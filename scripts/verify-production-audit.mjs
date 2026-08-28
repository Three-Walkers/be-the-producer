import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "btp-production-audit-"));
const workspaceRoot = join(root, "workspace");
const stateRoot = join(root, "state");
process.env.STUDIO_WORKSPACE_ROOT = workspaceRoot;

try {
  const { createStudioKernel, createStudioKernelFromSnapshot } = await import("@game-pipeline/agent-runtime");
  const {
    assertProductionAuditReadyForGate,
    reconcileProductionAudit
  } = await import("../apps/api/dist/productionAudit.js");
  const { enforceProducerGateBoundary } = await import("../apps/api/dist/modelAgentRuntime.js");
  const { ProjectPersistenceStore } = await import("../apps/api/dist/projectPersistence.js");
  const { syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");

  const kernel = createStudioKernel("project_audit", "Audit Fixture", "producer", "制作一个可验证的微信小游戏。");
  const now = new Date().toISOString();
  kernel.updateProject({ executionStatus: "running", startedAt: now, updatedAt: now });
  const producerMessage = {
    messageId: "msg_audit_goal",
    projectId: kernel.project.projectId,
    roomId: kernel.getRoom("studio-main").roomId,
    senderType: "producer",
    senderId: "producer",
    messageType: "plan_submission",
    content: "先完成核心玩法文档，只有证据完整后再评审。",
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: now
  };
  kernel.recordMessage(producerMessage);
  kernel.addTask({
    taskId: "task_audit_gdd",
    projectId: kernel.project.projectId,
    stageId: "concept_discussion",
    roomId: kernel.getRoom("design-room").roomId,
    taskLevel: "task",
    ownerAgentId: "game_designer",
    participantAgentIds: [],
    title: "核心玩法文档",
    description: "审计夹具",
    status: "doing",
    priority: 1,
    sortOrder: 1,
    progressPercent: 50,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts: ["artifact_audit_gdd"],
    acceptanceCriteria: ["当前版本有 hash/size 证据"],
    createdAt: now,
    updatedAt: now
  });
  kernel.upsertArtifact({
    artifactId: "artifact_audit_gdd",
    projectId: kernel.project.projectId,
    type: "gdd",
    path: "docs/design/audit-gdd.md",
    ownerAgentId: "game_designer",
    stageId: "concept_discussion",
    status: "submitted",
    version: 1,
    sourceTaskId: "task_audit_gdd",
    sourceDecisionIds: [],
    metadata: { toolName: "write_artifact", toolExecutedAt: now },
    createdAt: now,
    updatedAt: now
  });

  const failed = reconcileProductionAudit(kernel, {
    trigger: "stage_gate",
    triggerRef: "gate:stage1:review:test",
    requiredArtifactIds: ["artifact_audit_gdd"]
  });
  assert.equal(failed.run.blocking, true);
  assert.throws(() => assertProductionAuditReadyForGate(failed.run), /生产审计未通过/);
  assert.ok(failed.run.findings.some((finding) => finding.dimension === "artifact_integrity"));
  assert.equal(failed.bundle.lanes.length, 4);

  const content = "# 可验证核心玩法\n\n这是当前审计夹具。\n";
  const artifactPath = join(workspaceRoot, kernel.project.projectId, "docs/design/audit-gdd.md");
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, content, "utf8");
  const body = Buffer.from(content);
  kernel.recordArtifactMaterialization("artifact_audit_gdd", {
    path: "docs/design/audit-gdd.md",
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength,
    materializedAt: new Date().toISOString()
  });
  const passed = reconcileProductionAudit(kernel, {
    trigger: "stage_gate",
    triggerRef: "gate:stage1:review:test",
    requiredArtifactIds: ["artifact_audit_gdd"]
  });
  assert.equal(passed.run.blocking, false);
  assert.doesNotThrow(() => assertProductionAuditReadyForGate(passed.run));
  assert.equal(kernel.listProductionAuditFindings().find((finding) => finding.signature === "required-artifact:artifact_audit_gdd")?.status, "resolved");
  assert.equal(kernel.listInterventionLedger()[0]?.status, "outcome_supported");

  syncProjectWorkspace(kernel);
  const sealedEpisode = readFileSync(join(workspaceRoot, kernel.project.projectId, passed.run.reportPaths.episode), "utf8");
  for (const path of Object.values(passed.run.reportPaths)) {
    assert.ok(readFileSync(join(workspaceRoot, kernel.project.projectId, path), "utf8").length > 0, `${path} must exist`);
  }
  const manifest = JSON.parse(readFileSync(join(workspaceRoot, kernel.project.projectId, passed.run.reportPaths.manifest), "utf8"));
  assert.equal(manifest.immutable, true);
  assert.equal(manifest.files.length, 5);
  assert.doesNotThrow(() => syncProjectWorkspace(kernel), "same audit run must be idempotent");

  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeated = reconcileProductionAudit(kernel, {
    trigger: "stage_gate",
    triggerRef: "gate:stage1:review:test",
    requiredArtifactIds: ["artifact_audit_gdd"]
  });
  assert.equal(repeated.created, false);
  assert.doesNotThrow(() => syncProjectWorkspace(kernel), "mutable Episode updates must not rewrite a frozen run");
  assert.equal(
    readFileSync(join(workspaceRoot, kernel.project.projectId, passed.run.reportPaths.episode), "utf8"),
    sealedEpisode
  );

  const legacySnapshot = structuredClone(kernel.toSnapshot());
  delete legacySnapshot.productionAuditRuns[0].episodeSnapshot;
  delete legacySnapshot.productionAuditRuns[0].evidenceBundleSnapshot;
  const legacyKernel = createStudioKernelFromSnapshot(legacySnapshot);
  assert.doesNotThrow(
    () => syncProjectWorkspace(legacyKernel),
    "sealed audit runs created before frozen snapshots must remain readable"
  );

  const repository = new ProjectPersistenceStore(stateRoot);
  repository.save(kernel);
  const restored = repository.load(kernel.project.projectId);
  assert.equal(restored?.listProductionAuditRuns().length, 2);
  assert.equal(restored?.listTaskEpisodes().length, 1);
  assert.equal(restored?.listInterventionLedger()[0]?.status, "outcome_supported");

  rmSync(artifactPath);
  const regressed = reconcileProductionAudit(kernel, {
    trigger: "stage_gate",
    triggerRef: "gate:stage1:review:regression",
    requiredArtifactIds: ["artifact_audit_gdd"]
  });
  assert.equal(regressed.run.blocking, true);
  assert.equal(kernel.listInterventionLedger()[0]?.status, "regressing");

  const normal = enforceProducerGateBoundary(kernel, "我建议先比较两个核心循环，再补充失败反馈。", {
    agentId: "game_designer",
    scope: "conversation",
    producerMessage
  });
  assert.equal(normal.content, "我建议先比较两个核心循环，再补充失败反馈。");
  assert.equal(normal.metadata.producerGateBoundary, "passed");

  const transitionRequest = { ...producerMessage, messageId: "msg_advance", content: "讨论结束，开始下一阶段", messageType: "decision_record" };
  const guarded = enforceProducerGateBoundary(
    kernel,
    "玩法风险是失败反馈还不够清晰。我们现在正式进入下一阶段。建议先补充一次失败后的引导。",
    { agentId: "studio_orchestrator", scope: "conversation", producerMessage: transitionRequest }
  );
  assert.match(guarded.content, /玩法风险/);
  assert.match(guarded.content, /建议先补充/);
  assert.doesNotMatch(guarded.content, /正式进入下一阶段/);
  assert.match(guarded.content, /我已记录你希望推进/);
  assert.equal(guarded.metadata.removedStageClaimCount, 1);

  const specialist = enforceProducerGateBoundary(kernel, "我已经推进至下一阶段。", {
    agentId: "art_director",
    scope: "conversation",
    producerMessage: transitionRequest
  });
  assert.doesNotMatch(specialist.content, /门禁评审，汇总证据/);

  process.stdout.write("Production audit passed: episodes, four evidence lanes, findings, interventions, immutable reports, persistence, and non-mechanical stage guards\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
