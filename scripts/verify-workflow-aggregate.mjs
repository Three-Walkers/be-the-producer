import assert from "node:assert/strict";
import {
  IllegalWorkflowStageTransitionError,
  WorkflowAggregate,
  WorkflowDomainError,
  WorkflowIdempotencyConflictError,
  WorkflowRevisionConflictError,
  workflowTaskStages
} from "../packages/agent-runtime/dist/index.js";

const occurredAt = "2026-08-13T08:00:00.000Z";
let sequence = 0;

function metadata(aggregate, role, actorId, prefix) {
  sequence += 1;
  return {
    expectedRevision: aggregate.revision,
    idempotencyKey: `${prefix}-${sequence}`,
    actor: { actorId, role },
    occurredAt
  };
}

function submitReview(aggregate, label, prefix = "review") {
  aggregate.execute({
    type: "submit_review",
    ...metadata(aggregate, "orchestrator", "orchestrator", prefix),
    label,
    requiredArtifacts: [`artifact/${prefix}.json`],
    checks: [`${prefix}_complete`]
  });
  const gate = aggregate.activeGate;
  assert.ok(gate, "review submission must open a gate");
  return gate;
}

function decide(aggregate, gateId, verdict, options = {}) {
  return aggregate.execute({
    type: "record_gate_decision",
    ...metadata(aggregate, "producer", "producer-1", `decision-${verdict}`),
    gateId,
    verdict,
    notes: options.notes ?? `${verdict} by producer`,
    ...(options.waivedChecks ? { waivedChecks: options.waivedChecks } : {}),
    ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
    ...(options.affectedAreas ? { affectedAreas: options.affectedAreas } : {})
  });
}

function reachProduction(aggregate) {
  const gate = submitReview(aggregate, "Concept review", "concept");
  decide(aggregate, gate.gateId, "approved");
  assert.equal(aggregate.stage, "production");
}

function reachReleasePreparation(aggregate) {
  reachProduction(aggregate);
  const gate = submitReview(aggregate, "First playable review", "playable");
  decide(aggregate, gate.gateId, "approved");
  assert.equal(aggregate.stage, "release_preparation");
}

function reachProductionDeploy(aggregate, verdict = "approved") {
  reachReleasePreparation(aggregate);
  const gate = submitReview(aggregate, "Release gate", "release");
  decide(
    aggregate,
    gate.gateId,
    verdict,
    verdict === "waived"
      ? { waivedChecks: ["release_complete"], notes: "Known low-risk issue accepted." }
      : {}
  );
  assert.equal(aggregate.stage, "production_deploy");
}

function verifyHappyPathAndRecovery() {
  const aggregate = WorkflowAggregate.create("game_happy", { createdAt: occurredAt });
  reachProductionDeploy(aggregate);
  aggregate.execute({
    type: "transition_stage",
    ...metadata(aggregate, "orchestrator", "orchestrator", "deploy-complete"),
    targetStage: "liveops",
    reason: "Production health checks passed."
  });

  assert.equal(aggregate.stage, "liveops");
  const snapshot = aggregate.getSnapshot();
  assert.equal(snapshot.gates.length, 3);
  assert.equal(snapshot.decisions.length, 3);
  assert.equal(snapshot.gates.every((gate) => gate.status === "approved"), true);
  assert.equal(snapshot.activeGateId, null);

  const restoredSnapshot = WorkflowAggregate.fromSnapshot(
    JSON.parse(JSON.stringify(snapshot))
  ).getSnapshot();
  assert.deepEqual(restoredSnapshot, snapshot, "snapshot recovery must preserve the aggregate");

  const restoredEvents = WorkflowAggregate.fromEvents("game_happy", aggregate.listEvents(), {
    createdAt: occurredAt
  }).getSnapshot();
  assert.deepEqual(restoredEvents, snapshot, "event replay must preserve the aggregate");
}

function verifyRejectionsAndChangeRequest() {
  const concept = WorkflowAggregate.create("game_concept_reject", { createdAt: occurredAt });
  const conceptGate = submitReview(concept, "Concept review", "concept-reject");
  decide(concept, conceptGate.gateId, "rejected", { notes: "Core loop is not viable." });
  assert.equal(concept.stage, "concept_discussion");
  assert.equal(concept.getSnapshot().rollbacks[0]?.toStage, "concept_discussion");

  const playable = WorkflowAggregate.create("game_playable_rework", { createdAt: occurredAt });
  reachProduction(playable);
  const playableGate = submitReview(playable, "First playable review", "playable-rework");
  decide(playable, playableGate.gateId, "change_requested", {
    notes: "Moment-to-moment feedback is too weak.",
    changeSummary: "Strengthen hit feedback and retest.",
    affectedAreas: ["gameplay", "audio"]
  });
  assert.equal(playable.stage, "production");
  const playableSnapshot = playable.getSnapshot();
  assert.equal(playableSnapshot.changeRequests.at(-1)?.trigger, "gate_decision");
  assert.equal(playableSnapshot.changeRequests.at(-1)?.status, "open");
  assert.equal(playableSnapshot.rollbacks.at(-1)?.toStage, "production");
}

function verifyWaiverRollbackAndIteration() {
  const waived = WorkflowAggregate.create("game_waived", { createdAt: occurredAt });
  reachProductionDeploy(waived, "waived");
  assert.equal(waived.getSnapshot().waivers.length, 1);
  waived.execute({
    type: "rollback",
    ...metadata(waived, "system", "deploy-worker", "deploy-failed"),
    targetStage: "release_preparation",
    reason: "Deployment health check failed."
  });
  assert.equal(waived.stage, "release_preparation");
  assert.equal(waived.getSnapshot().rollbacks.at(-1)?.trigger, "deployment_failure");

  const live = WorkflowAggregate.create("game_iteration", { createdAt: occurredAt });
  reachProductionDeploy(live);
  live.execute({
    type: "transition_stage",
    ...metadata(live, "orchestrator", "orchestrator", "go-live"),
    targetStage: "liveops",
    reason: "Deployment completed."
  });
  live.execute({
    type: "request_iteration",
    ...metadata(live, "producer", "producer-1", "iteration"),
    summary: "Retention data calls for a shorter onboarding loop.",
    affectedAreas: ["onboarding", "analytics"]
  });
  assert.equal(live.stage, "production");
  assert.equal(live.getSnapshot().changeRequests.at(-1)?.trigger, "liveops_iteration");
}

function verifyGuards() {
  const aggregate = WorkflowAggregate.create("game_guards", { createdAt: occurredAt });
  assert.throws(
    () => aggregate.execute({
      type: "transition_stage",
      ...metadata(aggregate, "orchestrator", "orchestrator", "illegal-jump"),
      targetStage: "production",
      reason: "Skip the review."
    }),
    IllegalWorkflowStageTransitionError
  );

  const gate = submitReview(aggregate, "Concept review", "guard-review");
  assert.throws(
    () => aggregate.execute({
      type: "record_gate_decision",
      ...metadata(aggregate, "agent", "designer", "agent-decision"),
      gateId: gate.gateId,
      verdict: "approved",
      notes: "Agent self-approval."
    }),
    (error) => error instanceof WorkflowDomainError && error.code === "WORKFLOW_FORBIDDEN"
  );

  const idempotencyAggregate = WorkflowAggregate.create("game_idempotency", { createdAt: occurredAt });
  const original = {
    type: "submit_review",
    expectedRevision: 0,
    idempotencyKey: "review-once",
    actor: { actorId: "orchestrator", role: "orchestrator" },
    occurredAt,
    label: "Concept review",
    requiredArtifacts: ["artifact/gdd.json"],
    checks: ["scope_complete"]
  };
  const first = idempotencyAggregate.execute(original);
  const replay = idempotencyAggregate.execute(original);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.revision, first.revision);
  assert.deepEqual(replay.eventIds, first.eventIds);

  assert.throws(
    () => idempotencyAggregate.execute({ ...original, label: "Different intent" }),
    WorkflowIdempotencyConflictError
  );
  assert.throws(
    () => idempotencyAggregate.execute({
      ...original,
      idempotencyKey: "stale-revision",
      label: "New command"
    }),
    WorkflowRevisionConflictError
  );
}

verifyHappyPathAndRecovery();
verifyRejectionsAndChangeRequest();
verifyWaiverRollbackAndIteration();
verifyGuards();
assert.deepEqual(workflowTaskStages("concept_review"), ["concept_discussion", "concept_review"]);
assert.deepEqual(workflowTaskStages("production"), ["production"]);

console.log("Workflow Aggregate verification passed.");
