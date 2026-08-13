import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  IllegalWorkflowStageTransitionError,
  LocalAgentRuntime
} from "../packages/agent-runtime/dist/index.js";

const kernel = createStudioKernel("game_room_gate_test", "Room gate test", "producer_test", "test idea");
const designRoom = kernel.getRoom("design-room");
assert.ok(designRoom.participants.includes("game_designer"));

const removed = kernel.updateRoomParticipant("design-room", "game_designer", "remove");
assert.equal(removed.changed, true);
assert.ok(!removed.room.participants.includes("game_designer"));

const removedRoute = kernel.postMessage(producerMessage(kernel, designRoom.roomId, "@策划 请回复", ["game_designer"]));
assert.ok(!removedRoute.targets.some((target) => target.agentId === "game_designer"));

const invited = kernel.updateRoomParticipant("design-room", "game_designer", "invite");
assert.equal(invited.changed, true);
const invitedRoute = kernel.postMessage(producerMessage(kernel, designRoom.roomId, "@策划 请回复", ["game_designer"]));
assert.ok(invitedRoute.targets.some((target) => target.agentId === "game_designer"));

const restored = createStudioKernelFromSnapshot(kernel.toSnapshot());
assert.ok(restored.getRoom("design-room").participants.includes("game_designer"));

const policyTempRoot = mkdtempSync(join(tmpdir(), "game-api-gate-policy-"));
process.env.STUDIO_WORKSPACE_ROOT = policyTempRoot;
const { apiGateEvidencePolicy } = await import("../apps/api/dist/gateEvidencePolicy.js");
try {
  const policyKernel = createStudioKernel("game_api_gate_policy", "API policy test", "producer_test", "test idea");
  const relativePath = "agents/design/gdd/policy.md";
  const absolutePath = join(policyTempRoot, policyKernel.project.projectId, relativePath);
  const content = "current gate evidence\n";
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  materializeGateArtifact(
    policyKernel,
    "artifact_policy_gdd",
    "gdd",
    relativePath,
    sha256(content),
    Buffer.byteLength(content)
  );
  const policyRequirement = {
    gateActionId: "stage1",
    phase: "decision",
    requiredArtifactIds: ["artifact_policy_gdd"]
  };
  assert.doesNotThrow(() => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement));
  const policyArtifact = policyKernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_policy_gdd");
  assert.ok(policyArtifact);
  policyKernel.upsertArtifact({
    ...policyArtifact,
    status: "change_requested",
    metadata: {
      ...policyArtifact.metadata,
      bridgeOperationId: "bridge_failed_fixture",
      bridgeOk: false
    },
    updatedAt: new Date().toISOString()
  });
  assert.throws(
    () => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement),
    /缺少当前且可消费的产物证据/,
    "a verified failure report must not be treated as a consumable gate deliverable"
  );
  policyKernel.upsertArtifact({
    ...policyArtifact,
    status: "draft",
    metadata: {
      ...policyArtifact.metadata,
      bridgeOperationId: "bridge_recovered_fixture",
      bridgeOk: true
    },
    updatedAt: new Date().toISOString()
  });
  assert.doesNotThrow(() => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement));
  writeFileSync(absolutePath, "tampered gate evidence\n");
  assert.throws(
    () => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement),
    /缺少当前且可消费的产物证据/,
    "API policy must reject a workspace file that no longer matches its ledger"
  );
} finally {
  rmSync(policyTempRoot, { recursive: true, force: true });
}

const gateKernel = createStudioKernel("game_gate_test", "Gate test", "producer_test", "test idea");
const runtime = new LocalAgentRuntime();
const first = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "发起立项阶段的门禁评审"),
  { scriptedReplies: false }
);
assert.ok(first.agentMessages.some((message) => message.messageType === "blocker" && message.content.includes("缺少已验证产物证据")));
assert.equal(gateKernel.project.currentStage, "concept_discussion", "missing evidence must not freeze work in review");
assert.equal(gateKernel.getWorkflowSnapshot().activeGateId, null);
assert.deepEqual(gateKernel.listWorkflowEvents(), []);

assert.throws(
  () => gateKernel.setStage("production"),
  IllegalWorkflowStageTransitionError,
  "the legacy stage setter must not bypass producer review"
);

const second = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "执行确认：确认立项"),
  { scriptedReplies: false }
);
assert.ok(second.agentMessages.some((message) => message.messageType === "decision_request" && message.content.includes("必须先经过")));
assert.ok(!second.agentMessages.some((message) => message.content.includes("二次确认口令：执行确认：确认立项")));
assert.equal(gateKernel.project.currentStage, "concept_discussion");
assert.equal(gateKernel.getWorkflowSnapshot().decisions.length, 0);

materializeGateArtifact(gateKernel, "artifact_gdd_baseline_draft", "gdd", "agents/design/gdd/00_overview.md");
materializeGateArtifact(
  gateKernel,
  "artifact_game_contract_draft",
  "game_contract",
  "agents/design/contracts/game-contract.json"
);
materializeGateArtifact(
  gateKernel,
  "artifact_art_bible_baseline_draft",
  "art_bible",
  "agents/art/art-bible/00_overview.md"
);
const readyReview = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "发起立项阶段的门禁评审"),
  { scriptedReplies: false }
);
assert.ok(readyReview.agentMessages.some((message) => message.content.includes("二次确认口令：执行确认：确认立项")));
assert.equal(gateKernel.project.currentStage, "concept_review");
assert.equal(gateKernel.getWorkflowSnapshot().activeGateId !== null, true);
assert.deepEqual(
  gateKernel.listWorkflowEvents().map((event) => event.type),
  ["stage_transitioned", "gate_opened"]
);

const activeGateId = gateKernel.getWorkflowSnapshot().activeGateId;
assert.ok(activeGateId);
assert.throws(
  () => gateKernel.executeWorkflow({
    type: "record_gate_decision",
    expectedRevision: gateKernel.getWorkflowSnapshot().revision,
    idempotencyKey: "agent-cannot-self-approve-room-gate",
    actor: { actorId: "game_designer", role: "agent" },
    gateId: activeGateId,
    verdict: "approved",
    notes: "Agent attempted self approval."
  }),
  (error) => error?.code === "WORKFLOW_FORBIDDEN"
);

const reviewSnapshot = gateKernel.toSnapshot();
assert.equal(reviewSnapshot.workflow?.stage, "concept_review");
const restoredReview = createStudioKernelFromSnapshot(reviewSnapshot);
assert.equal(restoredReview.project.currentStage, "concept_review");
assert.deepEqual(restoredReview.getWorkflowSnapshot(), gateKernel.getWorkflowSnapshot());

const approvalMessage = producerMessage(
  gateKernel,
  gateKernel.getRoom("studio-main").roomId,
  "执行确认：确认立项"
);
runtime.handleProducerMessage(gateKernel, approvalMessage, { scriptedReplies: false });
assert.equal(gateKernel.project.currentStage, "production");
assert.equal(gateKernel.getWorkflowSnapshot().decisions.at(-1)?.producerId, gateKernel.project.producerId);
assert.equal(gateKernel.getWorkflowSnapshot().decisions.at(-1)?.verdict, "approved");
const approvedRevision = gateKernel.getWorkflowSnapshot().revision;
runtime.handleProducerMessage(gateKernel, approvalMessage, { scriptedReplies: false });
assert.equal(
  gateKernel.getWorkflowSnapshot().revision,
  approvedRevision,
  "replaying the same producer request must not duplicate a workflow decision"
);
const mismatchedSnapshot = gateKernel.toSnapshot();
assert.throws(
  () => createStudioKernelFromSnapshot({
    ...mismatchedSnapshot,
    project: { ...mismatchedSnapshot.project, currentStage: "release_preparation" }
  }),
  /does not match project stage/,
  "snapshot restore must reject drift between Project and Workflow stages"
);

const deploymentKernel = createStudioKernelFromSnapshot({
  ...kernel.toSnapshot(),
  project: {
    ...kernel.project,
    projectId: "game_deployment_boundary_test",
    currentStage: "production_deploy"
  },
  workflow: undefined,
  rooms: kernel.listRooms().map((room) => ({
    ...room,
    projectId: "game_deployment_boundary_test"
  })),
  messages: [],
  tasks: [],
  artifacts: [],
  artifactOperations: [],
  artifactLedger: [],
  claimVerifications: [],
  claimRepairs: [],
  memoryRecords: [],
  auditEvents: []
});
assert.throws(
  () => deploymentKernel.setStage("liveops", "2026-08-13T10:00:00.000Z"),
  IllegalWorkflowStageTransitionError,
  "even deployment completion must not use the legacy stage setter"
);
deploymentKernel.executeWorkflow({
  type: "transition_stage",
  expectedRevision: deploymentKernel.getWorkflowSnapshot().revision,
  idempotencyKey: "deployment-health-check-passed",
  actor: { actorId: "devops", role: "orchestrator" },
  occurredAt: "2026-08-13T10:00:00.000Z",
  targetStage: "liveops",
  reason: "Production deployment and health checks passed."
});
assert.equal(deploymentKernel.project.currentStage, "liveops");
assert.equal(deploymentKernel.listWorkflowEvents().at(-1)?.trigger, "operational_transition");

console.log("Room membership and natural-language gate smoke passed");

function producerMessage(targetKernel, roomId, content, mentions = []) {
  return {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: targetKernel.project.projectId,
    roomId,
    senderType: "producer",
    senderId: targetKernel.project.producerId,
    messageType: "plan_submission",
    content,
    mentions,
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

function materializeGateArtifact(
  targetKernel,
  artifactId,
  type,
  path,
  hash = `sha256:${artifactId}`,
  sizeBytes = 128
) {
  const now = new Date().toISOString();
  targetKernel.addArtifact({
    artifactId,
    projectId: targetKernel.project.projectId,
    type,
    path,
    ownerAgentId: type === "art_bible" ? "art_director" : "game_designer",
    stageId: "concept_discussion",
    status: "draft",
    version: 1,
    sourceDecisionIds: [],
    metadata: {
      toolExecutedAt: now,
      toolName: "write_artifact"
    },
    createdAt: now,
    updatedAt: now
  });
  targetKernel.recordArtifactMaterialization(artifactId, {
    path,
    hash,
    sizeBytes,
    materializedAt: now
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
