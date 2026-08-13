import {
  IllegalWorkflowStageTransitionError,
  WorkflowDomainError,
  WorkflowIdempotencyConflictError,
  WorkflowRevisionConflictError
} from "./errors.js";
import {
  REVIEW_APPROVAL_TARGET,
  REVIEW_ENTRY_STAGE,
  REVIEW_REWORK_TARGET,
  canTransitionWorkflowStage,
  isReviewStage,
  isWorkflowStage
} from "./transitions.js";
import type {
  RecordGateDecisionCommand,
  RequestChangeCommand,
  RequestIterationCommand,
  ResolveChangeRequestCommand,
  RollbackCommand,
  SubmitReviewCommand,
  TransitionStageCommand,
  WorkflowChangeRequest,
  WorkflowCommand,
  WorkflowCommandResult,
  WorkflowDecision,
  WorkflowEvent,
  WorkflowEventMetadata,
  WorkflowEventPayload,
  WorkflowGate,
  WorkflowGateKind,
  WorkflowProcessedCommand,
  WorkflowRollback,
  WorkflowSnapshot,
  WorkflowStage,
  WorkflowWaiver
} from "./types.js";

type EventPayloadFactory = (revision: number) => WorkflowEventPayload;

interface WorkflowMutableState {
  initialStage: WorkflowStage;
  stage: WorkflowStage;
  revision: number;
  updatedAt: string;
  activeGateId: string | null;
  gates: WorkflowGate[];
  decisions: WorkflowDecision[];
  changeRequests: WorkflowChangeRequest[];
  waivers: WorkflowWaiver[];
  rollbacks: WorkflowRollback[];
  processedCommands: WorkflowProcessedCommand[];
  events: WorkflowEvent[];
}

const INITIAL_STAGE: WorkflowStage = "concept_discussion";
const DEFAULT_INITIAL_TIME = "1970-01-01T00:00:00.000Z";

export interface CreateWorkflowAggregateOptions {
  initialStage?: WorkflowStage;
  createdAt?: string;
}

export class WorkflowAggregate {
  readonly projectId: string;
  private readonly state: WorkflowMutableState;

  private constructor(projectId: string, initialStage: WorkflowStage, createdAt: string) {
    requireNonBlank(projectId, "projectId");
    requireTimestamp(createdAt, "createdAt");
    if (!isWorkflowStage(initialStage)) {
      throw invalid(`Unknown initial workflow stage '${String(initialStage)}'.`);
    }
    if (isReviewStage(initialStage)) {
      throw invalid(`A workflow cannot be created directly in review stage '${initialStage}'.`);
    }
    this.projectId = projectId;
    this.state = {
      initialStage,
      stage: initialStage,
      revision: 0,
      updatedAt: createdAt,
      activeGateId: null,
      gates: [],
      decisions: [],
      changeRequests: [],
      waivers: [],
      rollbacks: [],
      processedCommands: [],
      events: []
    };
  }

  static create(projectId: string, options: CreateWorkflowAggregateOptions = {}): WorkflowAggregate {
    return new WorkflowAggregate(
      projectId,
      options.initialStage ?? INITIAL_STAGE,
      options.createdAt ?? DEFAULT_INITIAL_TIME
    );
  }

  static fromEvents(
    projectId: string,
    events: readonly WorkflowEvent[],
    options: CreateWorkflowAggregateOptions = {}
  ): WorkflowAggregate {
    const aggregate = WorkflowAggregate.create(projectId, options);
    const commandGroups = new Map<string, WorkflowEvent[]>();

    for (const sourceEvent of events) {
      const event = clone(sourceEvent);
      aggregate.validateReplayedEvent(event);
      aggregate.applyEvent(event);

      const grouped = commandGroups.get(event.idempotencyKey) ?? [];
      grouped.push(event);
      commandGroups.set(event.idempotencyKey, grouped);
    }

    aggregate.state.processedCommands = buildProcessedCommands(commandGroups);
    aggregate.assertInvariants();
    return aggregate;
  }

  static fromSnapshot(snapshot: WorkflowSnapshot): WorkflowAggregate {
    if (snapshot.schemaVersion !== 1) {
      throw invariant(`Unsupported workflow snapshot schema version '${String(snapshot.schemaVersion)}'.`);
    }

    const restored = WorkflowAggregate.fromEvents(snapshot.projectId, snapshot.events, {
      initialStage: snapshot.initialStage,
      createdAt: snapshot.events.length === 0 ? snapshot.updatedAt : DEFAULT_INITIAL_TIME
    });
    const actual = restored.getSnapshot();
    if (canonicalStringify(actual) !== canonicalStringify(snapshot)) {
      throw invariant("Workflow snapshot does not match its embedded event stream.");
    }
    return restored;
  }

  get stage(): WorkflowStage {
    return this.state.stage;
  }

  get revision(): number {
    return this.state.revision;
  }

  get activeGate(): WorkflowGate | null {
    if (!this.state.activeGateId) {
      return null;
    }
    return clone(this.requireGate(this.state.activeGateId));
  }

  listEvents(afterRevision = 0): WorkflowEvent[] {
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw invalid("afterRevision must be a non-negative integer.");
    }
    return clone(this.state.events.filter((event) => event.revision > afterRevision));
  }

  getSnapshot(): WorkflowSnapshot {
    return clone({
      schemaVersion: 1,
      projectId: this.projectId,
      initialStage: this.state.initialStage,
      stage: this.state.stage,
      revision: this.state.revision,
      updatedAt: this.state.updatedAt,
      activeGateId: this.state.activeGateId,
      gates: this.state.gates,
      decisions: this.state.decisions,
      changeRequests: this.state.changeRequests,
      waivers: this.state.waivers,
      rollbacks: this.state.rollbacks,
      processedCommands: this.state.processedCommands,
      events: this.state.events
    });
  }

  execute(command: WorkflowCommand): WorkflowCommandResult {
    this.validateCommandMetadata(command);
    const fingerprint = commandFingerprint(command);
    const existing = this.state.processedCommands.find(
      (processed) => processed.idempotencyKey === command.idempotencyKey
    );

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new WorkflowIdempotencyConflictError(command.idempotencyKey);
      }
      const replayedEvents = this.eventsByIds(existing.eventIds);
      return {
        revision: this.state.revision,
        commandRevision: existing.finalRevision,
        eventIds: [...existing.eventIds],
        events: replayedEvents,
        idempotentReplay: true,
        snapshot: this.getSnapshot()
      };
    }

    if (command.expectedRevision !== this.state.revision) {
      throw new WorkflowRevisionConflictError(command.expectedRevision, this.state.revision);
    }

    const occurredAt = command.occurredAt ?? new Date().toISOString();
    requireTimestamp(occurredAt, "occurredAt");
    const effectiveCommand = { ...command, occurredAt } as WorkflowCommand;
    const payloadFactories = this.decide(effectiveCommand);
    if (payloadFactories.length === 0) {
      throw invariant(`Workflow command '${command.type}' did not produce an event.`);
    }

    const eventCount = payloadFactories.length;
    const events = payloadFactories.map((createPayload, index) => {
      const revision = command.expectedRevision + index + 1;
      const metadata: WorkflowEventMetadata = {
        eventId: workflowId("event", this.projectId, revision),
        projectId: this.projectId,
        revision,
        occurredAt,
        actorId: command.actor.actorId,
        actorRole: command.actor.role,
        idempotencyKey: command.idempotencyKey,
        commandFingerprint: fingerprint,
        commandEventIndex: index,
        commandEventCount: eventCount
      };
      return { ...metadata, ...createPayload(revision) } as WorkflowEvent;
    });

    for (const event of events) {
      this.applyEvent(event);
    }
    const processed: WorkflowProcessedCommand = {
      idempotencyKey: command.idempotencyKey,
      fingerprint,
      eventIds: events.map((event) => event.eventId),
      finalRevision: this.state.revision
    };
    this.state.processedCommands.push(processed);
    this.assertInvariants();

    return {
      revision: this.state.revision,
      commandRevision: processed.finalRevision,
      eventIds: [...processed.eventIds],
      events: clone(events),
      idempotentReplay: false,
      snapshot: this.getSnapshot()
    };
  }

  private decide(command: WorkflowCommand): EventPayloadFactory[] {
    switch (command.type) {
      case "submit_review":
        return this.decideSubmitReview(command);
      case "record_gate_decision":
        return this.decideGateDecision(command);
      case "transition_stage":
        return this.decideOperationalTransition(command);
      case "request_change":
        return this.decideRequestChange(command);
      case "resolve_change_request":
        return this.decideResolveChangeRequest(command);
      case "request_iteration":
        return this.decideRequestIteration(command);
      case "rollback":
        return this.decideRollback(command);
      default:
        return assertNever(command);
    }
  }

  private decideSubmitReview(command: SubmitReviewCommand): EventPayloadFactory[] {
    requireRole(command, ["orchestrator", "system"]);
    requireNonBlank(command.label, "label");
    const requiredArtifacts = requireUniqueNonBlank(command.requiredArtifacts, "requiredArtifacts", true);
    const checks = requireUniqueNonBlank(command.checks, "checks", true);
    if (this.state.activeGateId) {
      throw invariant(`Gate '${this.state.activeGateId}' is already pending producer review.`);
    }

    const reviewStage = REVIEW_ENTRY_STAGE[this.state.stage];
    if (!reviewStage) {
      throw new IllegalWorkflowStageTransitionError(
        this.state.stage,
        this.state.stage,
        "a review can only be submitted from concept_discussion, production, or release_preparation"
      );
    }
    this.requireTransition(this.state.stage, reviewStage);
    const fromStage = this.state.stage;
    const gateKind = gateKindForReview(reviewStage);

    return [
      () => ({
        type: "stage_transitioned",
        fromStage,
        toStage: reviewStage,
        trigger: "review_submitted",
        reason: `Submitted ${command.label} for producer review.`
      }),
      (revision) => ({
        type: "gate_opened",
        gate: {
          gateId: workflowId("gate", this.projectId, revision),
          projectId: this.projectId,
          kind: gateKind,
          reviewStage,
          label: command.label.trim(),
          requiredArtifacts,
          checks,
          status: "pending_producer",
          decisionId: null,
          openedAt: command.occurredAt ?? new Date().toISOString(),
          openedRevision: revision,
          resolvedAt: null,
          resolvedRevision: null
        }
      })
    ];
  }

  private decideGateDecision(command: RecordGateDecisionCommand): EventPayloadFactory[] {
    requireRole(command, ["producer"]);
    requireNonBlank(command.notes, "notes");
    if (!isDecisionVerdict(command.verdict)) {
      throw invalid(`Unknown producer verdict '${String(command.verdict)}'.`);
    }
    if (!isReviewStage(this.state.stage)) {
      throw invalid(`Gate decisions require a review stage; current stage is '${this.state.stage}'.`);
    }
    if (this.state.activeGateId !== command.gateId) {
      throw notFound(`Gate '${command.gateId}' is not the active gate.`);
    }

    const gate = this.requireGate(command.gateId);
    if (gate.status !== "pending_producer" || gate.decisionId !== null) {
      throw invariant(`Gate '${gate.gateId}' already has a terminal decision.`);
    }
    if (gate.reviewStage !== this.state.stage) {
      throw invariant(`Gate '${gate.gateId}' does not belong to stage '${this.state.stage}'.`);
    }

    const waivedChecks = requireUniqueNonBlank(command.waivedChecks ?? [], "waivedChecks", false);
    if (command.verdict === "waived") {
      if (this.state.stage !== "release_gate") {
        throw invalid("Only the release gate can be completed with a waiver.");
      }
      if (waivedChecks.length === 0) {
        throw invalid("A waived decision must name at least one waived check.");
      }
      const unknownChecks = waivedChecks.filter((check) => !gate.checks.includes(check));
      if (unknownChecks.length > 0) {
        throw invalid(`Waived checks are not defined by the gate: ${unknownChecks.join(", ")}.`);
      }
    } else if (waivedChecks.length > 0) {
      throw invalid("waivedChecks are only valid for a waived decision.");
    }

    if (command.verdict === "change_requested") {
      requireNonBlank(command.changeSummary ?? "", "changeSummary");
    }

    const decisionRevision = command.expectedRevision + 1;
    const decisionId = workflowId("decision", this.projectId, decisionRevision);
    const decisionTime = command.occurredAt ?? new Date().toISOString();
    const decisionFactory: EventPayloadFactory = (revision) => ({
      type: "decision_recorded",
      decision: {
        decisionId,
        projectId: this.projectId,
        gateId: gate.gateId,
        stage: gate.reviewStage,
        producerId: command.actor.actorId,
        verdict: command.verdict,
        notes: command.notes.trim(),
        waivedChecks,
        status: "active",
        recordedAt: decisionTime,
        recordedRevision: revision,
        supersededAt: null,
        supersededRevision: null
      }
    });

    const status = command.verdict;
    const factories: EventPayloadFactory[] = [decisionFactory];
    if (command.verdict === "waived") {
      factories.push((revision) => ({
        type: "waiver_recorded",
        waiver: {
          waiverId: workflowId("waiver", this.projectId, revision),
          projectId: this.projectId,
          gateId: gate.gateId,
          decisionId,
          producerId: command.actor.actorId,
          checks: waivedChecks,
          reason: command.notes.trim(),
          createdAt: decisionTime,
          createdRevision: revision
        }
      }));
    }
    factories.push(() => ({ type: "gate_resolved", gateId: gate.gateId, decisionId, status }));

    const fromStage = this.state.stage;
    const isApproved = command.verdict === "approved" || command.verdict === "waived";
    const targetStage = isApproved
      ? REVIEW_APPROVAL_TARGET[fromStage]
      : REVIEW_REWORK_TARGET[fromStage];
    this.requireTransition(fromStage, targetStage);

    if (!isApproved) {
      if (command.verdict === "change_requested") {
        const summary = command.changeSummary?.trim() ?? "";
        const affectedAreas = requireUniqueNonBlank(command.affectedAreas ?? [], "affectedAreas", false);
        factories.push((revision) => ({
          type: "change_request_created",
          changeRequest: createChangeRequest({
            revision,
            projectId: this.projectId,
            sourceStage: fromStage,
            requestedBy: command.actor.actorId,
            trigger: "gate_decision",
            summary,
            affectedAreas,
            sourceDecisionId: decisionId,
            createdAt: decisionTime
          })
        }));
      }
      factories.push((revision) => ({
        type: "rollback_recorded",
        rollback: createRollback({
          revision,
          projectId: this.projectId,
          fromStage,
          toStage: targetStage,
          trigger: "gate_decision",
          reason: command.notes.trim(),
          actorId: command.actor.actorId,
          sourceDecisionId: decisionId,
          createdAt: decisionTime
        })
      }));
    }

    factories.push(() => ({
      type: "stage_transitioned",
      fromStage,
      toStage: targetStage,
      trigger: "gate_decision",
      reason: command.notes.trim()
    }));
    return factories;
  }

  private decideOperationalTransition(command: TransitionStageCommand): EventPayloadFactory[] {
    requireRole(command, ["orchestrator", "system"]);
    requireNonBlank(command.reason, "reason");
    this.requireTransition(this.state.stage, command.targetStage);
    if (this.state.stage !== "production_deploy" || command.targetStage !== "liveops") {
      throw new IllegalWorkflowStageTransitionError(
        this.state.stage,
        command.targetStage,
        "review entry, gate decisions, iterations, and rollbacks require their dedicated commands"
      );
    }
    const fromStage = this.state.stage;
    return [() => ({
      type: "stage_transitioned",
      fromStage,
      toStage: command.targetStage,
      trigger: "operational_transition",
      reason: command.reason.trim()
    })];
  }

  private decideRequestChange(command: RequestChangeCommand): EventPayloadFactory[] {
    requireRole(command, ["producer"]);
    const summary = requireNonBlank(command.summary, "summary");
    const affectedAreas = requireUniqueNonBlank(command.affectedAreas, "affectedAreas", false);
    const createdAt = command.occurredAt ?? new Date().toISOString();
    const factories: EventPayloadFactory[] = [];
    let sourceDecisionId: string | null = null;

    if (command.supersedesDecisionId) {
      const decision = this.requireDecision(command.supersedesDecisionId);
      if (decision.status !== "active") {
        throw invariant(`Decision '${decision.decisionId}' is already superseded.`);
      }
      sourceDecisionId = decision.decisionId;
      factories.push(() => ({
        type: "decision_superseded",
        decisionId: decision.decisionId,
        reason: summary
      }));
    }

    factories.push((revision) => ({
      type: "change_request_created",
      changeRequest: createChangeRequest({
        revision,
        projectId: this.projectId,
        sourceStage: this.state.stage,
        requestedBy: command.actor.actorId,
        trigger: "producer_request",
        summary,
        affectedAreas,
        sourceDecisionId,
        createdAt
      })
    }));
    return factories;
  }

  private decideResolveChangeRequest(command: ResolveChangeRequestCommand): EventPayloadFactory[] {
    requireRole(command, ["producer", "orchestrator"]);
    const resolution = requireNonBlank(command.resolution, "resolution");
    const changeRequest = this.requireChangeRequest(command.changeRequestId);
    if (changeRequest.status !== "open") {
      throw invariant(`Change request '${changeRequest.changeRequestId}' is already resolved.`);
    }
    return [() => ({
      type: "change_request_resolved",
      changeRequestId: changeRequest.changeRequestId,
      resolution
    })];
  }

  private decideRequestIteration(command: RequestIterationCommand): EventPayloadFactory[] {
    requireRole(command, ["producer"]);
    const summary = requireNonBlank(command.summary, "summary");
    const affectedAreas = requireUniqueNonBlank(command.affectedAreas, "affectedAreas", false);
    if (this.state.stage !== "liveops") {
      throw new IllegalWorkflowStageTransitionError(
        this.state.stage,
        "production",
        "iterations can only be requested from liveops"
      );
    }
    this.requireTransition(this.state.stage, "production");
    const createdAt = command.occurredAt ?? new Date().toISOString();
    return [
      (revision) => ({
        type: "change_request_created",
        changeRequest: createChangeRequest({
          revision,
          projectId: this.projectId,
          sourceStage: "liveops",
          requestedBy: command.actor.actorId,
          trigger: "liveops_iteration",
          summary,
          affectedAreas,
          sourceDecisionId: null,
          createdAt
        })
      }),
      () => ({
        type: "stage_transitioned",
        fromStage: "liveops",
        toStage: "production",
        trigger: "liveops_iteration",
        reason: summary
      })
    ];
  }

  private decideRollback(command: RollbackCommand): EventPayloadFactory[] {
    requireRole(command, ["producer", "orchestrator", "system"]);
    const reason = requireNonBlank(command.reason, "reason");
    this.requireTransition(this.state.stage, command.targetStage);
    if (this.state.stage !== "production_deploy" || command.targetStage !== "release_preparation") {
      throw new IllegalWorkflowStageTransitionError(
        this.state.stage,
        command.targetStage,
        "explicit operational rollback is only valid from production_deploy to release_preparation"
      );
    }
    const fromStage = this.state.stage;
    const createdAt = command.occurredAt ?? new Date().toISOString();
    return [
      (revision) => ({
        type: "rollback_recorded",
        rollback: createRollback({
          revision,
          projectId: this.projectId,
          fromStage,
          toStage: command.targetStage,
          trigger: "deployment_failure",
          reason,
          actorId: command.actor.actorId,
          sourceDecisionId: null,
          createdAt
        })
      }),
      () => ({
        type: "stage_transitioned",
        fromStage,
        toStage: command.targetStage,
        trigger: "rollback",
        reason
      })
    ];
  }

  private applyEvent(event: WorkflowEvent): void {
    if (event.projectId !== this.projectId) {
      throw invariant(`Event '${event.eventId}' belongs to project '${event.projectId}'.`);
    }
    if (event.revision !== this.state.revision + 1) {
      throw invariant(
        `Event '${event.eventId}' has revision ${event.revision}; expected ${this.state.revision + 1}.`
      );
    }

    switch (event.type) {
      case "stage_transitioned":
        if (this.state.stage !== event.fromStage) {
          throw invariant(
            `Stage transition '${event.eventId}' expected '${event.fromStage}', actual '${this.state.stage}'.`
          );
        }
        this.requireTransition(event.fromStage, event.toStage);
        this.state.stage = event.toStage;
        break;
      case "gate_opened":
        if (this.state.activeGateId) {
          throw invariant(`Cannot open gate '${event.gate.gateId}' while another gate is active.`);
        }
        if (event.gate.projectId !== this.projectId || event.gate.reviewStage !== this.state.stage) {
          throw invariant(`Gate '${event.gate.gateId}' does not match the workflow state.`);
        }
        if (event.gate.status !== "pending_producer" || event.gate.decisionId !== null) {
          throw invariant(`New gate '${event.gate.gateId}' must be pending producer review.`);
        }
        this.requireUniqueRecordId(event.gate.gateId);
        this.state.gates.push(clone(event.gate));
        this.state.activeGateId = event.gate.gateId;
        break;
      case "decision_recorded": {
        const gate = this.requireGate(event.decision.gateId);
        if (gate.status !== "pending_producer" || gate.decisionId !== null) {
          throw invariant(`Gate '${gate.gateId}' cannot accept another decision.`);
        }
        if (event.decision.projectId !== this.projectId || event.decision.stage !== gate.reviewStage) {
          throw invariant(`Decision '${event.decision.decisionId}' does not match gate '${gate.gateId}'.`);
        }
        this.requireUniqueRecordId(event.decision.decisionId);
        this.state.decisions.push(clone(event.decision));
        break;
      }
      case "waiver_recorded":
        this.requireDecision(event.waiver.decisionId);
        this.requireGate(event.waiver.gateId);
        this.requireUniqueRecordId(event.waiver.waiverId);
        this.state.waivers.push(clone(event.waiver));
        break;
      case "gate_resolved": {
        const gate = this.requireGate(event.gateId);
        const decision = this.requireDecision(event.decisionId);
        if (this.state.activeGateId !== gate.gateId || gate.status !== "pending_producer") {
          throw invariant(`Gate '${gate.gateId}' is not awaiting a decision.`);
        }
        if (decision.gateId !== gate.gateId || decision.verdict !== event.status) {
          throw invariant(`Decision '${decision.decisionId}' cannot resolve gate '${gate.gateId}'.`);
        }
        gate.status = event.status;
        gate.decisionId = decision.decisionId;
        gate.resolvedAt = event.occurredAt;
        gate.resolvedRevision = event.revision;
        this.state.activeGateId = null;
        break;
      }
      case "decision_superseded": {
        const decision = this.requireDecision(event.decisionId);
        if (decision.status !== "active") {
          throw invariant(`Decision '${decision.decisionId}' is already superseded.`);
        }
        decision.status = "superseded";
        decision.supersededAt = event.occurredAt;
        decision.supersededRevision = event.revision;
        break;
      }
      case "change_request_created":
        if (event.changeRequest.projectId !== this.projectId) {
          throw invariant(`Change request '${event.changeRequest.changeRequestId}' has the wrong project.`);
        }
        this.requireUniqueRecordId(event.changeRequest.changeRequestId);
        this.state.changeRequests.push(clone(event.changeRequest));
        break;
      case "change_request_resolved": {
        const changeRequest = this.requireChangeRequest(event.changeRequestId);
        if (changeRequest.status !== "open") {
          throw invariant(`Change request '${changeRequest.changeRequestId}' is already resolved.`);
        }
        changeRequest.status = "resolved";
        changeRequest.resolution = event.resolution;
        changeRequest.resolvedAt = event.occurredAt;
        changeRequest.resolvedRevision = event.revision;
        break;
      }
      case "rollback_recorded":
        if (event.rollback.projectId !== this.projectId || event.rollback.fromStage !== this.state.stage) {
          throw invariant(`Rollback '${event.rollback.rollbackId}' does not match the workflow state.`);
        }
        this.requireTransition(event.rollback.fromStage, event.rollback.toStage);
        this.requireUniqueRecordId(event.rollback.rollbackId);
        this.state.rollbacks.push(clone(event.rollback));
        break;
      default:
        assertNever(event);
    }

    this.state.revision = event.revision;
    this.state.updatedAt = event.occurredAt;
    this.state.events.push(clone(event));
  }

  private validateReplayedEvent(event: WorkflowEvent): void {
    requireNonBlank(event.eventId, "eventId");
    requireNonBlank(event.idempotencyKey, "idempotencyKey");
    requireNonBlank(event.commandFingerprint, "commandFingerprint");
    requireTimestamp(event.occurredAt, "occurredAt");
    if (!Number.isInteger(event.commandEventIndex) || event.commandEventIndex < 0) {
      throw invariant(`Event '${event.eventId}' has an invalid commandEventIndex.`);
    }
    if (!Number.isInteger(event.commandEventCount) || event.commandEventCount <= 0) {
      throw invariant(`Event '${event.eventId}' has an invalid commandEventCount.`);
    }
    if (event.commandEventIndex >= event.commandEventCount) {
      throw invariant(`Event '${event.eventId}' has an out-of-range command event index.`);
    }
    if (this.state.events.some((existing) => existing.eventId === event.eventId)) {
      throw invariant(`Duplicate workflow event id '${event.eventId}'.`);
    }
  }

  private validateCommandMetadata(command: WorkflowCommand): void {
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw invalid("expectedRevision must be a non-negative integer.");
    }
    requireNonBlank(command.idempotencyKey, "idempotencyKey");
    requireNonBlank(command.actor.actorId, "actor.actorId");
    if (command.occurredAt !== undefined) {
      requireTimestamp(command.occurredAt, "occurredAt");
    }
  }

  private requireTransition(fromStage: WorkflowStage, toStage: WorkflowStage): void {
    if (!canTransitionWorkflowStage(fromStage, toStage)) {
      throw new IllegalWorkflowStageTransitionError(fromStage, toStage);
    }
  }

  private requireGate(gateId: string): WorkflowGate {
    const gate = this.state.gates.find((candidate) => candidate.gateId === gateId);
    if (!gate) {
      throw notFound(`Workflow gate '${gateId}' was not found.`);
    }
    return gate;
  }

  private requireDecision(decisionId: string): WorkflowDecision {
    const decision = this.state.decisions.find((candidate) => candidate.decisionId === decisionId);
    if (!decision) {
      throw notFound(`Workflow decision '${decisionId}' was not found.`);
    }
    return decision;
  }

  private requireChangeRequest(changeRequestId: string): WorkflowChangeRequest {
    const changeRequest = this.state.changeRequests.find(
      (candidate) => candidate.changeRequestId === changeRequestId
    );
    if (!changeRequest) {
      throw notFound(`Workflow change request '${changeRequestId}' was not found.`);
    }
    return changeRequest;
  }

  private requireUniqueRecordId(recordId: string): void {
    const exists =
      this.state.gates.some((record) => record.gateId === recordId) ||
      this.state.decisions.some((record) => record.decisionId === recordId) ||
      this.state.changeRequests.some((record) => record.changeRequestId === recordId) ||
      this.state.waivers.some((record) => record.waiverId === recordId) ||
      this.state.rollbacks.some((record) => record.rollbackId === recordId);
    if (exists) {
      throw invariant(`Duplicate workflow record id '${recordId}'.`);
    }
  }

  private eventsByIds(eventIds: readonly string[]): WorkflowEvent[] {
    return eventIds.map((eventId) => {
      const event = this.state.events.find((candidate) => candidate.eventId === eventId);
      if (!event) {
        throw invariant(`Processed command references missing event '${eventId}'.`);
      }
      return clone(event);
    });
  }

  private assertInvariants(): void {
    if (this.state.events.length !== this.state.revision) {
      throw invariant("Workflow revision does not match its event stream length.");
    }
    const activeGates = this.state.gates.filter((gate) => gate.status === "pending_producer");
    if (activeGates.length > 1) {
      throw invariant("Workflow has more than one active gate.");
    }
    if ((activeGates[0]?.gateId ?? null) !== this.state.activeGateId) {
      throw invariant("Workflow activeGateId does not match its pending gate.");
    }
    if (isReviewStage(this.state.stage)) {
      if (!this.state.activeGateId) {
        throw invariant(`Review stage '${this.state.stage}' requires an active gate.`);
      }
      const gate = this.requireGate(this.state.activeGateId);
      if (gate.reviewStage !== this.state.stage) {
        throw invariant(`Active gate '${gate.gateId}' does not match review stage '${this.state.stage}'.`);
      }
    } else if (this.state.activeGateId) {
      throw invariant(`Non-review stage '${this.state.stage}' cannot have an active gate.`);
    }
  }
}

function buildProcessedCommands(groups: ReadonlyMap<string, WorkflowEvent[]>): WorkflowProcessedCommand[] {
  const processed: WorkflowProcessedCommand[] = [];
  for (const [idempotencyKey, events] of groups) {
    const first = events[0];
    const last = events.at(-1);
    if (!first || !last) {
      throw invariant(`Idempotency group '${idempotencyKey}' is empty.`);
    }
    if (events.length !== first.commandEventCount) {
      throw invariant(`Idempotency group '${idempotencyKey}' is incomplete.`);
    }
    events.forEach((event, index) => {
      if (
        event.commandFingerprint !== first.commandFingerprint ||
        event.commandEventCount !== first.commandEventCount ||
        event.commandEventIndex !== index ||
        event.revision !== first.revision + index ||
        event.actorId !== first.actorId ||
        event.actorRole !== first.actorRole ||
        event.occurredAt !== first.occurredAt
      ) {
        throw invariant(`Idempotency group '${idempotencyKey}' has inconsistent metadata.`);
      }
    });
    processed.push({
      idempotencyKey,
      fingerprint: first.commandFingerprint,
      eventIds: events.map((event) => event.eventId),
      finalRevision: last.revision
    });
  }
  return processed.sort((left, right) => left.finalRevision - right.finalRevision);
}

interface CreateChangeRequestInput {
  revision: number;
  projectId: string;
  sourceStage: WorkflowStage;
  requestedBy: string;
  trigger: WorkflowChangeRequest["trigger"];
  summary: string;
  affectedAreas: string[];
  sourceDecisionId: string | null;
  createdAt: string;
}

function createChangeRequest(input: CreateChangeRequestInput): WorkflowChangeRequest {
  return {
    changeRequestId: workflowId("change", input.projectId, input.revision),
    projectId: input.projectId,
    sourceStage: input.sourceStage,
    requestedBy: input.requestedBy,
    trigger: input.trigger,
    summary: input.summary,
    affectedAreas: input.affectedAreas,
    sourceDecisionId: input.sourceDecisionId,
    status: "open",
    resolution: null,
    createdAt: input.createdAt,
    createdRevision: input.revision,
    resolvedAt: null,
    resolvedRevision: null
  };
}

interface CreateRollbackInput {
  revision: number;
  projectId: string;
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  trigger: WorkflowRollback["trigger"];
  reason: string;
  actorId: string;
  sourceDecisionId: string | null;
  createdAt: string;
}

function createRollback(input: CreateRollbackInput): WorkflowRollback {
  return {
    rollbackId: workflowId("rollback", input.projectId, input.revision),
    projectId: input.projectId,
    fromStage: input.fromStage,
    toStage: input.toStage,
    trigger: input.trigger,
    reason: input.reason,
    actorId: input.actorId,
    sourceDecisionId: input.sourceDecisionId,
    createdAt: input.createdAt,
    createdRevision: input.revision
  };
}

function gateKindForReview(stage: WorkflowStage): WorkflowGateKind {
  switch (stage) {
    case "concept_review":
      return "concept";
    case "first_playable_review":
      return "first_playable";
    case "release_gate":
      return "release";
    default:
      throw invalid(`Stage '${stage}' is not a review stage.`);
  }
}

function isDecisionVerdict(value: string): value is WorkflowDecision["verdict"] {
  return value === "approved" || value === "rejected" || value === "change_requested" || value === "waived";
}

function commandFingerprint(command: WorkflowCommand): string {
  const { expectedRevision: _expectedRevision, idempotencyKey: _idempotencyKey, occurredAt: _occurredAt, ...intent } =
    command;
  return canonicalStringify(intent);
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function requireRole(
  command: WorkflowCommand,
  allowedRoles: readonly WorkflowCommand["actor"]["role"][]
): void {
  if (!allowedRoles.includes(command.actor.role)) {
    throw new WorkflowDomainError(
      "WORKFLOW_FORBIDDEN",
      `Actor role '${command.actor.role}' cannot execute workflow command '${command.type}'.`
    );
  }
}

function requireNonBlank(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw invalid(`${fieldName} must be a non-empty string.`);
  }
  return normalized;
}

function requireUniqueNonBlank(values: readonly string[], fieldName: string, requireOne: boolean): string[] {
  const normalized = values.map((value, index) => requireNonBlank(value, `${fieldName}[${index}]`));
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw invalid(`${fieldName} must not contain duplicate values.`);
  }
  if (requireOne && unique.length === 0) {
    throw invalid(`${fieldName} must contain at least one value.`);
  }
  return unique;
}

function requireTimestamp(value: string, fieldName: string): void {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw invalid(`${fieldName} must be an ISO-compatible timestamp.`);
  }
}

function workflowId(prefix: string, projectId: string, revision: number): string {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefix}_${safeProjectId}_${revision.toString(36)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function invalid(message: string): WorkflowDomainError {
  return new WorkflowDomainError("WORKFLOW_INVALID_COMMAND", message);
}

function invariant(message: string): WorkflowDomainError {
  return new WorkflowDomainError("WORKFLOW_INVARIANT_VIOLATION", message);
}

function notFound(message: string): WorkflowDomainError {
  return new WorkflowDomainError("WORKFLOW_NOT_FOUND", message);
}

function assertNever(value: never): never {
  throw invariant(`Unsupported workflow value: ${JSON.stringify(value)}.`);
}
