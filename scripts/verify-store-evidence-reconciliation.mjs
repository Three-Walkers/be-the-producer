import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-store-evidence-reconciliation-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const {
  LocalAgentRuntime,
  createStudioKernel,
  reconcileLocalRuntimeProjectState
} = await import("../packages/agent-runtime/dist/index.js");
const {
  captureCurrentStageReviewOutputEvidence,
  reconcileCurrentStageReviewOutputEvidence
} = await import("../apps/api/dist/evidenceReconciliation.js");
const { artifactReadyForConsumption } = await import("../apps/api/dist/taskOutputEvidence.js");
const { StudioProjectStore } = await import("../apps/api/dist/store.js");
const { migrateLegacyMediaGenerationReceipts } = await import("../apps/api/dist/store.js");
const { syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");

try {
  verifyUntouchedReviewOutputStaysInReview();
  verifyNativeSyncCannotPublishEvidence();
  verifyTamperedReviewOutputReopens();
  verifyMissingReviewOutputReopens();
  verifyPastStageTaskDoesNotReopen();
  verifyLazyLoadPersistsSyncMutation();
  verifyLegacyForgedMediaReceiptIsInvalidated();
  process.stdout.write(
    "Store evidence reconciliation passed: stale review output reopened, past-stage task preserved, lazy-load mutation persisted\n"
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function verifyUntouchedReviewOutputStaysInReview() {
  const kernel = createStudioKernel("store_evidence_untouched", "Untouched evidence", "producer_test", "no false positive");
  const taskId = "task_untouched_review";
  const artifactId = "artifact_untouched_review";
  const path = "agents/design/untouched-review.md";
  addReviewTask(kernel, { taskId, artifactId, stageId: kernel.project.currentStage });
  materializeNativeArtifact(kernel, { taskId, artifactId, path, content: "untouched-v1\n" });
  const baseline = captureCurrentStageReviewOutputEvidence(kernel);
  syncProjectWorkspace(kernel);
  const result = reconcileCurrentStageReviewOutputEvidence(kernel, baseline);
  assert.equal(result.changed, false);
  assert.equal(kernel.findTask(taskId)?.status, "review");
  assert.equal(kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId)?.status, "verified");
}

function verifyTamperedReviewOutputReopens() {
  const kernel = createStudioKernel("store_evidence_current", "Current evidence", "producer_test", "evidence repair");
  const taskId = "task_current_review";
  const artifactId = "artifact_current_review";
  const path = "agents/design/current-review.md";
  addReviewTask(kernel, { taskId, artifactId, stageId: kernel.project.currentStage });
  materializeNativeArtifact(kernel, { taskId, artifactId, path, content: "reviewed-v1\n" });
  assert.equal(artifactReadyForConsumption(kernel, artifactId), true);

  const baseline = captureCurrentStageReviewOutputEvidence(kernel);
  writeWorkspaceFile(kernel.project.projectId, path, "externally-tampered-v2\n");
  syncProjectWorkspace(kernel);
  assert.equal(
    artifactReadyForConsumption(kernel, artifactId),
    false,
    "workspace sync must not bless externally changed native bytes, even before reconciliation"
  );

  const result = reconcileCurrentStageReviewOutputEvidence(kernel, baseline, "2026-08-15T10:00:00.000Z");
  assert.deepEqual(result.taskIds, [taskId]);
  assert.deepEqual(result.artifactIds, [artifactId]);
  assert.equal(kernel.findTask(taskId)?.status, "doing");
  assert.equal(kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId)?.status, "pending");
  assert.equal(
    kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId)?.metadata.toolExecutedAt,
    undefined
  );
  assert.equal(artifactReadyForConsumption(kernel, artifactId), false);
}

function verifyNativeSyncCannotPublishEvidence() {
  const kernel = createStudioKernel("native_sync_history", "Native receipt history", "producer_test", "immutable evidence");
  const taskId = "native_history_task", artifactId = "native_history_artifact", path = "agents/design/native-history.md";
  addReviewTask(kernel, { taskId, artifactId, stageId: kernel.project.currentStage });
  materializeNativeArtifact(kernel, { taskId, artifactId, path, content: "historical-v1\n" });
  const before = JSON.stringify(kernel.listArtifactLedger().find((item) => item.artifactId === artifactId));
  kernel.updateTask(taskId, { inputArtifacts: ["upstream_contract_now_invalid"] });
  assert.doesNotThrow(() => syncProjectWorkspace(kernel), "historical native receipts never recapture invalid current inputs during a checkpoint");
  assert.equal(JSON.stringify(kernel.listArtifactLedger().find((item) => item.artifactId === artifactId)), before);
  const artifact = kernel.listArtifacts().find((item) => item.artifactId === artifactId);
  kernel.upsertArtifact({ ...artifact, version: artifact.version + 1 });
  assert.doesNotThrow(() => syncProjectWorkspace(kernel));
  assert.equal(kernel.listArtifactLedger().find((item) => item.artifactId === artifactId).status, "pending", "timestamp plus old bytes cannot publish a new version");
  unlinkSync(workspacePath(kernel.project.projectId, path));
  assert.doesNotThrow(() => syncProjectWorkspace(kernel), "missing native outputs cannot be regenerated as registry placeholders");
  assert.equal(kernel.listArtifactLedger().find((item) => item.artifactId === artifactId).status, "pending");
}

function verifyMissingReviewOutputReopens() {
  const kernel = createStudioKernel("store_evidence_missing", "Missing evidence", "producer_test", "missing repair");
  const taskId = "task_missing_review";
  const artifactId = "artifact_missing_review";
  const path = "agents/design/missing-review.md";
  addReviewTask(kernel, { taskId, artifactId, stageId: kernel.project.currentStage });
  materializeNativeArtifact(kernel, { taskId, artifactId, path, content: "missing-v1\n" });
  const baseline = captureCurrentStageReviewOutputEvidence(kernel);
  unlinkSync(workspacePath(kernel.project.projectId, path));
  syncProjectWorkspace(kernel);
  const result = reconcileCurrentStageReviewOutputEvidence(kernel, baseline);
  assert.deepEqual(result.taskIds, [taskId]);
  assert.equal(kernel.findTask(taskId)?.status, "doing");
  assert.equal(kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId)?.status, "pending");
}

function verifyPastStageTaskDoesNotReopen() {
  const kernel = createStudioKernel("store_evidence_past_stage", "Past stage", "producer_test", "stage boundary");
  reachProduction(kernel);
  const taskId = "task_past_stage_review";
  const artifactId = "artifact_past_stage_review";
  const path = "agents/design/past-stage.md";
  addReviewTask(kernel, { taskId, artifactId, stageId: "concept_discussion" });
  materializeNativeArtifact(kernel, { taskId, artifactId, path, content: "past-stage-v1\n" });

  const baseline = captureCurrentStageReviewOutputEvidence(kernel);
  assert.deepEqual(baseline.taskIds, []);
  writeWorkspaceFile(kernel.project.projectId, path, "past-stage-external-change\n");
  syncProjectWorkspace(kernel);
  const result = reconcileCurrentStageReviewOutputEvidence(kernel, baseline);
  assert.equal(result.changed, false);
  assert.equal(kernel.findTask(taskId)?.status, "review", "past-stage work must not become an unreachable doing task");
}

function verifyLazyLoadPersistsSyncMutation() {
  const kernel = createStudioKernel("store_evidence_lazy", "Lazy persistence", "producer_test", "lazy load");
  kernel.updateProject({ executionStatus: "paused", updatedAt: new Date().toISOString() });
  new LocalAgentRuntime().handleProducerMessage(
    kernel,
    producerMessage(kernel, "bootstrap deterministic Stage 1 topology"),
    { scriptedReplies: false, protocolFlows: false, bootstrapProjectState: true }
  );
  assert.equal(reconcileLocalRuntimeProjectState(kernel).changed, false);

  const taskId = "task_lazy_review";
  const artifactId = "artifact_lazy_review";
  const path = "agents/design/lazy-review.md";
  addReviewTask(kernel, { taskId, artifactId, stageId: kernel.project.currentStage });
  materializeNativeArtifact(kernel, { taskId, artifactId, path, content: "lazy-v1\n" });
  writeWorkspaceFile(kernel.project.projectId, path, "lazy-external-change\n");

  const savedSnapshots = [];
  const repository = {
    loadAll: () => [],
    listSummaries: () => [],
    load: (projectId) => (projectId === kernel.project.projectId ? kernel : undefined),
    save: (savedKernel) => {
      const snapshot = savedKernel.toSnapshot();
      savedSnapshots.push(snapshot);
      return snapshot;
    },
    delete: () => {}
  };
  const store = new StudioProjectStore({ persistence: repository });
  const loaded = store.getKernel(kernel.project.projectId);
  assert.equal(loaded.findTask(taskId)?.status, "doing");
  assert.equal(loaded.listArtifactLedger().find((entry) => entry.artifactId === artifactId)?.status, "pending");
  assert.equal(savedSnapshots.length, 1, "lazy load must persist workspace-sync evidence mutations unconditionally");
  const persistedTask = savedSnapshots[0].tasks.find((task) => task.taskId === taskId);
  const persistedLedger = savedSnapshots[0].artifactLedger.find((entry) => entry.artifactId === artifactId);
  assert.equal(persistedTask?.status, "doing");
  assert.equal(persistedLedger?.status, "pending");
}

function verifyLegacyForgedMediaReceiptIsInvalidated() {
  const kernel = createStudioKernel("store_legacy_media", "Legacy media", "producer_test", "forged receipt");
  const now = new Date().toISOString();
  const taskId = "task_legacy_media";
  const artifactId = "artifact_legacy_media";
  const path = "assets/art/first-playable/legacy.png";
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    title: "Legacy media",
    description: "legacy forged provider metadata fixture",
    ownerAgentId: "asset_production",
    participantAgentIds: [],
    status: "review",
    priority: 1,
    sortOrder: 1,
    progressPercent: 90,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts: [artifactId],
    acceptanceCriteria: ["server-issued current media receipt"],
    createdAt: now,
    updatedAt: now
  });
  const content = Buffer.from("legacy-not-a-real-png-provider-fixture");
  writeWorkspaceFile(kernel.project.projectId, path, content);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type: "asset",
    path,
    ownerAgentId: "asset_production",
    stageId: kernel.project.currentStage,
    status: "submitted",
    version: 1,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "dashscope_multimodal_art_provider",
      toolName: "generate_raster_asset",
      toolExecutedAt: now,
      mediaProvider: "dashscope",
      mediaModel: "wan2.7-image-pro",
      mediaRequestId: "model-authored-fake",
      mediaPromptHash: "a".repeat(64),
      mediaMime: "image/png",
      mediaWidth: 1024,
      mediaHeight: 1024
    },
    createdAt: now,
    updatedAt: now
  });
  const absolutePath = workspacePath(kernel.project.projectId, path);
  const stats = statSync(absolutePath);
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    sizeBytes: stats.size,
    materializedAt: stats.mtime.toISOString()
  });

  assert.equal(migrateLegacyMediaGenerationReceipts(kernel), true);
  const migrated = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  assert.equal(migrated?.status, "change_requested");
  assert.equal(migrated?.metadata.mediaProvider, undefined);
  assert.equal(migrated?.metadata.generatedBy, undefined);
  assert.equal(migrated?.metadata.toolExecutedAt, undefined);
  assert.equal(migrated?.metadata.legacyMediaReceiptInvalidationReason, "missing_current_server_materialization_operation");
  assert.equal(ledger?.status, "pending");
  assert.equal(ledger?.hash, undefined);
  assert.equal(migrateLegacyMediaGenerationReceipts(kernel), false, "migration must be idempotent");
}

function addReviewTask(kernel, { taskId, artifactId, stageId }) {
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId,
    roomId: kernel.getRoom("design-room").roomId,
    taskLevel: "task",
    title: taskId,
    description: "review evidence fixture",
    ownerAgentId: "game_designer",
    participantAgentIds: [],
    status: "review",
    priority: 1,
    sortOrder: 1,
    progressPercent: 90,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts: [artifactId],
    acceptanceCriteria: ["current file evidence"],
    createdAt: now,
    updatedAt: now
  });
}

function materializeNativeArtifact(kernel, { taskId, artifactId, path, content }) {
  const now = new Date().toISOString();
  writeWorkspaceFile(kernel.project.projectId, path, content);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type: "gdd",
    path,
    ownerAgentId: "game_designer",
    stageId: kernel.findTask(taskId).stageId,
    status: "submitted",
    version: 1,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "claude_cli_harness",
      nativeHarnessManaged: true,
      toolExecutedAt: now
    },
    createdAt: now,
    updatedAt: now
  });
  const absolutePath = workspacePath(kernel.project.projectId, path);
  const stats = statSync(absolutePath);
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    sizeBytes: stats.size,
    materializedAt: stats.mtime.toISOString()
  });
}

function reachProduction(kernel) {
  let revision = kernel.getWorkflowSnapshot().revision;
  kernel.executeWorkflow({
    type: "submit_review",
    expectedRevision: revision,
    idempotencyKey: `${kernel.project.projectId}:review`,
    actor: { actorId: "studio_orchestrator", role: "orchestrator" },
    occurredAt: new Date().toISOString(),
    label: "Concept review",
    requiredArtifacts: ["artifact_fixture"],
    checks: ["fixture_ready"]
  });
  const gateId = kernel.getWorkflowSnapshot().activeGateId;
  assert.ok(gateId);
  revision = kernel.getWorkflowSnapshot().revision;
  kernel.executeWorkflow({
    type: "record_gate_decision",
    expectedRevision: revision,
    idempotencyKey: `${kernel.project.projectId}:approve`,
    actor: { actorId: "producer_test", role: "producer" },
    occurredAt: new Date().toISOString(),
    gateId,
    verdict: "approved",
    notes: "test transition"
  });
  assert.equal(kernel.project.currentStage, "production");
}

function producerMessage(kernel, content) {
  return {
    messageId: `msg_${kernel.project.projectId}`,
    projectId: kernel.project.projectId,
    roomId: kernel.getRoom("studio-main").roomId,
    senderType: "producer",
    senderId: kernel.project.producerId,
    messageType: "plan_submission",
    content,
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

function writeWorkspaceFile(projectId, path, content) {
  const absolutePath = workspacePath(projectId, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function workspacePath(projectId, path) {
  return join(process.env.STUDIO_WORKSPACE_ROOT, projectId, path);
}
