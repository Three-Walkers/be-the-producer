import type { StageId } from "@game-pipeline/shared-schemas";

export type WorkflowStage = StageId;

export type WorkflowActorRole = "producer" | "orchestrator" | "system" | "agent";

export interface WorkflowActor {
  actorId: string;
  role: WorkflowActorRole;
}

export type WorkflowReviewStage = "concept_review" | "first_playable_review" | "release_gate";
export type WorkflowGateKind = "concept" | "first_playable" | "release";
export type WorkflowGateStatus =
  | "pending_producer"
  | "approved"
  | "rejected"
  | "change_requested"
  | "waived";
export type WorkflowDecisionVerdict = "approved" | "rejected" | "change_requested" | "waived";

export interface WorkflowGate {
  gateId: string;
  projectId: string;
  kind: WorkflowGateKind;
  reviewStage: WorkflowReviewStage;
  label: string;
  requiredArtifacts: string[];
  checks: string[];
  status: WorkflowGateStatus;
  decisionId: string | null;
  openedAt: string;
  openedRevision: number;
  resolvedAt: string | null;
  resolvedRevision: number | null;
}

export type WorkflowDecisionStatus = "active" | "superseded";

export interface WorkflowDecision {
  decisionId: string;
  projectId: string;
  gateId: string;
  stage: WorkflowReviewStage;
  producerId: string;
  verdict: WorkflowDecisionVerdict;
  notes: string;
  waivedChecks: string[];
  status: WorkflowDecisionStatus;
  recordedAt: string;
  recordedRevision: number;
  supersededAt: string | null;
  supersededRevision: number | null;
}

export type WorkflowChangeRequestTrigger = "gate_decision" | "producer_request" | "liveops_iteration";
export type WorkflowChangeRequestStatus = "open" | "resolved";

export interface WorkflowChangeRequest {
  changeRequestId: string;
  projectId: string;
  sourceStage: WorkflowStage;
  requestedBy: string;
  trigger: WorkflowChangeRequestTrigger;
  summary: string;
  affectedAreas: string[];
  sourceDecisionId: string | null;
  status: WorkflowChangeRequestStatus;
  resolution: string | null;
  createdAt: string;
  createdRevision: number;
  resolvedAt: string | null;
  resolvedRevision: number | null;
}

export interface WorkflowWaiver {
  waiverId: string;
  projectId: string;
  gateId: string;
  decisionId: string;
  producerId: string;
  checks: string[];
  reason: string;
  createdAt: string;
  createdRevision: number;
}

export type WorkflowRollbackTrigger = "gate_decision" | "deployment_failure";

export interface WorkflowRollback {
  rollbackId: string;
  projectId: string;
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  trigger: WorkflowRollbackTrigger;
  reason: string;
  actorId: string;
  sourceDecisionId: string | null;
  createdAt: string;
  createdRevision: number;
}

export interface WorkflowCommandMetadata {
  expectedRevision: number;
  idempotencyKey: string;
  actor: WorkflowActor;
  occurredAt?: string;
}

export interface SubmitReviewCommand extends WorkflowCommandMetadata {
  type: "submit_review";
  label: string;
  requiredArtifacts: string[];
  checks: string[];
}

export interface RecordGateDecisionCommand extends WorkflowCommandMetadata {
  type: "record_gate_decision";
  gateId: string;
  verdict: WorkflowDecisionVerdict;
  notes: string;
  waivedChecks?: string[];
  changeSummary?: string;
  affectedAreas?: string[];
}

export interface TransitionStageCommand extends WorkflowCommandMetadata {
  type: "transition_stage";
  targetStage: WorkflowStage;
  reason: string;
}

export interface RequestChangeCommand extends WorkflowCommandMetadata {
  type: "request_change";
  summary: string;
  affectedAreas: string[];
  supersedesDecisionId?: string;
}

export interface ResolveChangeRequestCommand extends WorkflowCommandMetadata {
  type: "resolve_change_request";
  changeRequestId: string;
  resolution: string;
}

export interface RequestIterationCommand extends WorkflowCommandMetadata {
  type: "request_iteration";
  summary: string;
  affectedAreas: string[];
}

export interface RollbackCommand extends WorkflowCommandMetadata {
  type: "rollback";
  targetStage: WorkflowStage;
  reason: string;
}

export type WorkflowCommand =
  | SubmitReviewCommand
  | RecordGateDecisionCommand
  | TransitionStageCommand
  | RequestChangeCommand
  | ResolveChangeRequestCommand
  | RequestIterationCommand
  | RollbackCommand;

export type WorkflowStageTransitionTrigger =
  | "review_submitted"
  | "gate_decision"
  | "operational_transition"
  | "liveops_iteration"
  | "rollback";

export interface WorkflowEventMetadata {
  eventId: string;
  projectId: string;
  revision: number;
  occurredAt: string;
  actorId: string;
  actorRole: WorkflowActorRole;
  idempotencyKey: string;
  commandFingerprint: string;
  commandEventIndex: number;
  commandEventCount: number;
}

export type WorkflowEventPayload =
  | {
      type: "stage_transitioned";
      fromStage: WorkflowStage;
      toStage: WorkflowStage;
      trigger: WorkflowStageTransitionTrigger;
      reason: string;
    }
  | { type: "gate_opened"; gate: WorkflowGate }
  | {
      type: "gate_resolved";
      gateId: string;
      decisionId: string;
      status: Exclude<WorkflowGateStatus, "pending_producer">;
    }
  | { type: "decision_recorded"; decision: WorkflowDecision }
  | { type: "decision_superseded"; decisionId: string; reason: string }
  | { type: "change_request_created"; changeRequest: WorkflowChangeRequest }
  | { type: "change_request_resolved"; changeRequestId: string; resolution: string }
  | { type: "waiver_recorded"; waiver: WorkflowWaiver }
  | { type: "rollback_recorded"; rollback: WorkflowRollback };

export type WorkflowEvent = WorkflowEventMetadata & WorkflowEventPayload;

export interface WorkflowProcessedCommand {
  idempotencyKey: string;
  fingerprint: string;
  eventIds: string[];
  finalRevision: number;
}

export interface WorkflowSnapshot {
  schemaVersion: 1;
  projectId: string;
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

export interface WorkflowCommandResult {
  revision: number;
  commandRevision: number;
  eventIds: string[];
  events: WorkflowEvent[];
  idempotentReplay: boolean;
  snapshot: WorkflowSnapshot;
}
