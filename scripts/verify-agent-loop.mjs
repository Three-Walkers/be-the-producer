import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "be-the-producer-loop-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { AgentLoopService } = await import("../apps/api/dist/agentLoop.js");
const { executeAgentToolRequests, stableArtifactId } = await import("../apps/api/dist/toolExecutor.js");
const { createConversationHarnessAuthorization, createTaskHarnessAuthorization } = await import("../apps/api/dist/toolAuthorization.js");
const { hashWorkspaceFile, syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");
const {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  defaultAgentContracts,
  LocalAgentRuntime,
  migrateLocalRuntimeSnapshot,
  reconcileLocalRuntimeProjectState
} = await import("@game-pipeline/agent-runtime");

const projectId = "agent_loop_smoke";
const kernel = createStudioKernel(projectId, "Agent Loop Smoke", "producer_test", "做一个可爱的毛线球防守微信小游戏");
kernel.updateProject({ executionStatus: "running", startedAt: new Date().toISOString() });

const producerMessage = {
  messageId: "msg_smoke_bootstrap",
  projectId,
  roomId: kernel.getRoom("studio-main").roomId,
  senderType: "producer",
  senderId: "producer_test",
  messageType: "plan_submission",
  content: "单局 90 秒，点击毛线球防守篮子，轻松可爱，继续执行策划和美术基线。",
  mentions: [],
  relatedTaskIds: [],
  relatedArtifactIds: [],
  metadata: {},
  createdAt: new Date().toISOString()
};
new LocalAgentRuntime().handleProducerMessage(kernel, producerMessage, {
  scriptedReplies: false,
  protocolFlows: false,
  bootstrapProjectState: true
});

const stageOneArtifactContracts = [
  ["artifact_gdd_baseline_draft", "gdd", "agents/design/gdd/00_overview.md", "game_designer", "task_stage_1_design_clarification"],
  ["artifact_game_contract_draft", "game_contract", "agents/design/contracts/game-contract.json", "game_designer", "task_stage_1_design_clarification"],
  ["artifact_art_bible_baseline_draft", "art_bible", "agents/art/art-bible.md", "art_director", "task_stage_1_art_direction"],
  ["artifact_art_direction_board", "asset", "agents/art/art-direction-board.png", "art_director", "task_stage_1_art_direction"]
];
const stageOneQualityReviewArtifactIds = [
  "artifact_stage_1_design_quality_review",
  "artifact_stage_1_visual_quality_review"
];
for (const [artifactId, type, path, ownerAgentId, sourceTaskId] of stageOneArtifactContracts) {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  assert.deepEqual(
    artifact && {
      artifactId: artifact.artifactId,
      type: artifact.type,
      path: artifact.path,
      ownerAgentId: artifact.ownerAgentId,
      sourceTaskId: artifact.sourceTaskId
    },
    { artifactId, type, path, ownerAgentId, sourceTaskId },
    `${artifactId} 必须由生产 bootstrap 原子预登记`
  );
}

for (const taskId of ["task_stage_1_design_clarification", "task_stage_1_art_direction"]) {
  const task = kernel.findTask(taskId);
  const agent = task && defaultAgentContracts.find((candidate) => candidate.agentId === task.ownerAgentId);
  assert.ok(task && agent);
  assert.doesNotThrow(
    () => createTaskHarnessAuthorization(kernel, task, agent),
    `${taskId} 在生产 bootstrap 后应能直接创建严格 Harness authorization`
  );
}

const producer = defaultAgentContracts.find((candidate) => candidate.agentId === "producer");
assert.ok(producer);
const producerConversationAuthorization = createConversationHarnessAuthorization(kernel, producer);
assert.deepEqual(
  [...producerConversationAuthorization.inputArtifactIds].sort(),
  [
    ...stageOneArtifactContracts.map(([artifactId]) => artifactId),
    ...stageOneQualityReviewArtifactIds
  ].sort(),
  "Producer 房间会话只能通过显式任务输入读取 Stage 1 作者产物与独立质量审查"
);

const legacySnapshot = kernel.toSnapshot();
legacySnapshot.tasks = legacySnapshot.tasks.map((task) => {
  if (task.taskId === "task_stage_1_design_clarification") {
    return {
      ...task,
      status: "review",
      progressPercent: 90,
      outputArtifacts: task.outputArtifacts.filter((artifactId) => artifactId !== "artifact_game_contract_draft")
    };
  }
  if (task.taskId === "task_stage_1_scope_review") {
    return {
      ...task,
      inputArtifacts: task.inputArtifacts.filter((artifactId) => artifactId !== "artifact_game_contract_draft")
    };
  }
  return task;
});
legacySnapshot.artifacts = legacySnapshot.artifacts
  .filter((artifact) => !["artifact_gdd_baseline_draft", "artifact_game_contract_draft"].includes(artifact.artifactId));
legacySnapshot.artifactLedger = legacySnapshot.artifactLedger.filter(
  (entry) => !["artifact_gdd_baseline_draft", "artifact_game_contract_draft"].includes(entry.artifactId)
);
legacySnapshot.artifactOperations = legacySnapshot.artifactOperations.filter(
  (operation) => !["artifact_gdd_baseline_draft", "artifact_game_contract_draft"].includes(operation.artifactId ?? "")
);
const legacyKernel = createStudioKernelFromSnapshot(legacySnapshot);
const legacyReconciliation = reconcileLocalRuntimeProjectState(legacyKernel);
assert.equal(legacyReconciliation.changed, true, "旧快照应补齐 Stage 1 任务/产物拓扑");
assert.equal(reconcileLocalRuntimeProjectState(legacyKernel).changed, false, "Stage 1 迁移必须幂等");
for (const [artifactId, , , ownerAgentId, sourceTaskId] of stageOneArtifactContracts) {
  const artifact = legacyKernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  assert.equal(artifact?.ownerAgentId, ownerAgentId);
  assert.equal(artifact?.sourceTaskId, sourceTaskId);
  assert.equal(legacyKernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId)?.taskId, sourceTaskId);
}
assert.equal(
  legacyKernel.findTask("task_stage_1_design_clarification")?.status,
  "doing",
  "review/done Stage 1 tasks must reopen when the migration introduces pending required outputs"
);
const collisionSnapshot = structuredClone(kernel.toSnapshot());
const legacySamePathId = stableArtifactId(
  projectId,
  "game_designer",
  "agents/design/gdd/00_overview.md"
);
rewriteSnapshotArtifactId(collisionSnapshot, "artifact_gdd_baseline_draft", legacySamePathId);
const collisionLedger = collisionSnapshot.artifactLedger.find((entry) => entry.artifactId === legacySamePathId);
assert.ok(collisionLedger);
collisionLedger.status = "verified";
collisionLedger.hash = "b".repeat(64);
collisionLedger.sizeBytes = 256;
collisionLedger.materializedAt = collisionSnapshot.savedAt;
const migrationOptions = { legacyArtifactIdFor: stableArtifactId };
const collisionMigration = migrateLocalRuntimeSnapshot(collisionSnapshot, migrationOptions);
assert.deepEqual(collisionMigration.artifactIdMigrations, [
  { fromArtifactId: legacySamePathId, toArtifactId: "artifact_gdd_baseline_draft" }
]);
assert.equal(
  migrateLocalRuntimeSnapshot(collisionMigration.snapshot, migrationOptions).changed,
  false,
  "artifact rekey migration must be idempotent"
);
const laterStageCollisionSnapshot = structuredClone(collisionSnapshot);
laterStageCollisionSnapshot.project.currentStage = "production";
const laterStageDesignTask = laterStageCollisionSnapshot.tasks.find(
  (task) => task.taskId === "task_stage_1_design_clarification"
);
assert.ok(laterStageDesignTask);
laterStageDesignTask.status = "done";
laterStageDesignTask.progressPercent = 100;
const laterStageMigration = migrateLocalRuntimeSnapshot(laterStageCollisionSnapshot, migrationOptions);
assert.equal(
  laterStageMigration.changed,
  true,
  "strict identity-only rekey must run after the concept stages"
);
assert.ok(
  laterStageMigration.snapshot.artifacts.some(
    (artifact) => artifact.artifactId === "artifact_gdd_baseline_draft"
  )
);
assert.equal(
  laterStageMigration.snapshot.tasks.find(
    (task) => task.taskId === "task_stage_1_design_clarification"
  )?.status,
  "done",
  "identity-only rekey must not reopen a completed Stage 1 task"
);
assert.equal(
  laterStageMigration.snapshot.artifactLedger.find(
    (entry) => entry.artifactId === "artifact_gdd_baseline_draft"
  )?.status,
  "verified",
  "identity-only rekey must preserve verified evidence in production"
);
const collisionKernel = createStudioKernelFromSnapshot(collisionMigration.snapshot);
assert.doesNotThrow(() => reconcileLocalRuntimeProjectState(collisionKernel));
assert.equal(
  collisionKernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_gdd_baseline_draft")?.status,
  "verified",
  "an identity-only rekey with an already correct source task preserves file evidence"
);
const unsafeCollisionSnapshot = structuredClone(kernel.toSnapshot());
rewriteSnapshotArtifactId(unsafeCollisionSnapshot, "artifact_gdd_baseline_draft", "artifact_untrusted_same_path");
assert.equal(
  migrateLocalRuntimeSnapshot(unsafeCollisionSnapshot, migrationOptions).changed,
  false,
  "non-stable legacy identities must never be auto-adopted"
);
const unsafeCollisionKernel = createStudioKernelFromSnapshot(unsafeCollisionSnapshot);
assert.doesNotThrow(() => reconcileLocalRuntimeProjectState(unsafeCollisionKernel));
assert.equal(
  reconcileLocalRuntimeProjectState(unsafeCollisionKernel).changed,
  false,
  "an unresolved identity conflict must not create an audit/update storm on every checkpoint"
);
assert.equal(unsafeCollisionKernel.findTask("task_stage_1_design_clarification")?.status, "blocked");
assert.match(
  unsafeCollisionKernel.findTask("task_stage_1_design_clarification")?.blockers.join("；") ?? "",
  /产物身份契约冲突/
);

const wrongTypeSnapshot = structuredClone(kernel.toSnapshot());
const wrongTypeArtifact = wrongTypeSnapshot.artifacts.find(
  (artifact) => artifact.artifactId === "artifact_gdd_baseline_draft"
);
assert.ok(wrongTypeArtifact);
wrongTypeArtifact.type = "art_bible";
const wrongTypeMigration = migrateLocalRuntimeSnapshot(wrongTypeSnapshot, migrationOptions);
assert.equal(wrongTypeMigration.changed, true, "canonical ID with the wrong schema type must be blocked on restore");
assert.equal(
  wrongTypeMigration.snapshot.tasks.find(
    (task) => task.taskId === "task_stage_1_design_clarification"
  )?.status,
  "blocked"
);
assert.match(
  wrongTypeMigration.snapshot.tasks.find(
    (task) => task.taskId === "task_stage_1_design_clarification"
  )?.blockers.join("；") ?? "",
  /type=art_bible, expected gdd/
);
assert.equal(
  migrateLocalRuntimeSnapshot(wrongTypeMigration.snapshot, migrationOptions).changed,
  false,
  "canonical identity blockers must be idempotent"
);
const wrongTypeKernel = createStudioKernelFromSnapshot(wrongTypeMigration.snapshot);
assert.equal(reconcileLocalRuntimeProjectState(wrongTypeKernel).changed, false);
assert.equal(
  wrongTypeKernel.listArtifacts().find(
    (artifact) => artifact.artifactId === "artifact_gdd_baseline_draft"
  )?.type,
  "art_bible",
  "reconciliation must not silently bless or rewrite a schema-bypassing canonical artifact"
);
syncProjectWorkspace(kernel);

const strictContractPath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "agents/design/contracts/game-contract.json");
assert.equal(existsSync(strictContractPath), false, "pending strict contracts must not be materialized as registry-wrapper JSON");
mkdirSync(dirname(strictContractPath), { recursive: true });
writeFileSync(
  strictContractPath,
  `${JSON.stringify({
    artifact: kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_game_contract_draft"),
    sourceTask: kernel.findTask("task_stage_1_design_clarification"),
    relatedMemory: []
  }, null, 2)}\n`,
  "utf8"
);
const strictContractArtifact = kernel.listArtifacts().find(
  (artifact) => artifact.artifactId === "artifact_game_contract_draft"
);
assert.ok(strictContractArtifact);
kernel.upsertArtifact({
  ...strictContractArtifact,
  metadata: { ...strictContractArtifact.metadata, nativeHarnessManaged: true },
  updatedAt: new Date().toISOString()
});
const strictPlaceholderStats = statSync(strictContractPath);
kernel.recordArtifactMaterialization(strictContractArtifact.artifactId, {
  path: strictContractArtifact.path,
  hash: hashWorkspaceFile(strictContractPath),
  sizeBytes: strictPlaceholderStats.size,
  materializedAt: strictPlaceholderStats.mtime.toISOString()
});
assert.equal(
  kernel.listArtifactLedger().find((entry) => entry.artifactId === strictContractArtifact.artifactId)?.status,
  "verified"
);
syncProjectWorkspace(kernel);
assert.equal(existsSync(strictContractPath), false, "legacy generated contract placeholders must be removed during sync");
assert.equal(
  kernel.listArtifactLedger().find((entry) => entry.artifactId === strictContractArtifact.artifactId)?.status,
  "pending",
  "removing a falsely verified strict placeholder must invalidate its ledger evidence"
);
syncProjectWorkspace(kernel);
assert.equal(
  existsSync(strictContractPath),
  false,
  "later checkpoints must not recreate a removed strict placeholder for a native Harness artifact"
);

const latePlaceholderSeed = createStudioKernel(
  "late_strict_placeholder_smoke",
  "Late Strict Placeholder Smoke",
  "producer_test",
  "验证后期严格契约占位文件只撤证、不回退旧任务"
);
latePlaceholderSeed.updateProject({ executionStatus: "running", startedAt: new Date().toISOString() });
new LocalAgentRuntime().handleProducerMessage(
  latePlaceholderSeed,
  {
    ...producerMessage,
    projectId: latePlaceholderSeed.project.projectId,
    roomId: latePlaceholderSeed.getRoom("studio-main").roomId,
    messageId: "msg_late_placeholder_bootstrap"
  },
  { scriptedReplies: false, protocolFlows: false, bootstrapProjectState: true }
);
const latePlaceholderSnapshot = latePlaceholderSeed.toSnapshot();
latePlaceholderSnapshot.project.currentStage = "production";
delete latePlaceholderSnapshot.workflow;
const lateCompletedTask = latePlaceholderSnapshot.tasks.find(
  (task) => task.taskId === "task_stage_1_design_clarification"
);
assert.ok(lateCompletedTask);
lateCompletedTask.status = "done";
lateCompletedTask.progressPercent = 100;
lateCompletedTask.blockers = [];
const latePlaceholderKernel = createStudioKernelFromSnapshot(latePlaceholderSnapshot);
latePlaceholderKernel.updateAgentLoopAgent("game_designer", {
  status: "waiting",
  taskId: "task_stage_1_design_clarification",
  lastError: undefined,
  updatedAt: new Date().toISOString()
});
const lateContractArtifact = latePlaceholderKernel.listArtifacts().find(
  (artifact) => artifact.artifactId === "artifact_game_contract_draft"
);
assert.ok(lateContractArtifact);
const lateContractPath = join(
  process.env.STUDIO_WORKSPACE_ROOT,
  latePlaceholderKernel.project.projectId,
  lateContractArtifact.path
);
mkdirSync(dirname(lateContractPath), { recursive: true });
writeFileSync(
  lateContractPath,
  `${JSON.stringify({
    artifact: lateContractArtifact,
    sourceTask: latePlaceholderKernel.findTask("task_stage_1_design_clarification"),
    relatedMemory: []
  }, null, 2)}\n`,
  "utf8"
);
latePlaceholderKernel.upsertArtifact({
  ...lateContractArtifact,
  metadata: { ...lateContractArtifact.metadata, nativeHarnessManaged: true },
  updatedAt: new Date().toISOString()
});
const lateContractStats = statSync(lateContractPath);
latePlaceholderKernel.recordArtifactMaterialization(lateContractArtifact.artifactId, {
  path: lateContractArtifact.path,
  hash: hashWorkspaceFile(lateContractPath),
  sizeBytes: lateContractStats.size,
  materializedAt: lateContractStats.mtime.toISOString()
});
syncProjectWorkspace(latePlaceholderKernel);
assert.equal(existsSync(lateContractPath), false);
assert.equal(
  latePlaceholderKernel.listArtifactLedger().find(
    (entry) => entry.artifactId === lateContractArtifact.artifactId
  )?.status,
  "pending"
);
assert.equal(
  latePlaceholderKernel.findTask("task_stage_1_design_clarification")?.status,
  "done",
  "late placeholder invalidation must not reopen an unreachable Stage 1 task"
);
assert.deepEqual(
  latePlaceholderKernel.findTask("task_stage_1_design_clarification")?.blockers,
  [],
  "late placeholder invalidation must leave the historical completed task unchanged"
);
assert.match(
  String(
    latePlaceholderKernel.listArtifacts().find(
      (artifact) => artifact.artifactId === lateContractArtifact.artifactId
    )?.metadata.generatedPlaceholderEvidenceIssue ?? ""
  ),
  /任务状态不会跨阶段自动回退/,
  "late placeholder invalidation must leave a durable issue without creating unreachable work"
);
assert.equal(
  latePlaceholderKernel.getAgentLoopState().agents.game_designer?.status,
  "waiting",
  "late placeholder invalidation must not queue an old-stage agent"
);

const authoredGddPath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "agents/design/gdd/00_overview.md");
const authoredGdd = "# Harness-authored GDD\n\nThis content must survive an activity checkpoint before evidence capture.\n";
writeFileSync(authoredGddPath, authoredGdd, "utf8");
syncProjectWorkspace(kernel);
assert.equal(
  readFileSync(authoredGddPath, "utf8"),
  authoredGdd,
  "workspace sync must not clobber a Harness write with the registry placeholder"
);

const placeholderKernel = createStudioKernel(
  "placeholder_evidence_smoke",
  "Placeholder Evidence Smoke",
  "producer_test",
  "验证占位文件不能成为 Harness 证据"
);
placeholderKernel.updateProject({ executionStatus: "running", startedAt: new Date().toISOString() });
new LocalAgentRuntime().handleProducerMessage(
  placeholderKernel,
  {
    ...producerMessage,
    projectId: placeholderKernel.project.projectId,
    roomId: placeholderKernel.getRoom("studio-main").roomId,
    messageId: "msg_placeholder_bootstrap"
  },
  { scriptedReplies: false, protocolFlows: false, bootstrapProjectState: true }
);
syncProjectWorkspace(placeholderKernel);
const placeholderArtifact = placeholderKernel.listArtifacts().find(
  (artifact) => artifact.artifactId === "artifact_art_bible_baseline_draft"
);
assert.ok(placeholderArtifact);
const placeholderPath = join(process.env.STUDIO_WORKSPACE_ROOT, placeholderKernel.project.projectId, placeholderArtifact.path);
assert.match(readFileSync(placeholderPath, "utf8"), /^# artifact_art_bible_baseline_draft/);
placeholderKernel.upsertArtifact({
  ...placeholderArtifact,
  metadata: { ...placeholderArtifact.metadata, nativeHarnessManaged: true },
  updatedAt: new Date().toISOString()
});
const placeholderStats = statSync(placeholderPath);
placeholderKernel.recordArtifactMaterialization(placeholderArtifact.artifactId, {
  path: placeholderArtifact.path,
  hash: hashWorkspaceFile(placeholderPath),
  sizeBytes: placeholderStats.size,
  materializedAt: placeholderStats.mtime.toISOString()
});
assert.equal(
  placeholderKernel.listArtifactLedger().find((entry) => entry.artifactId === placeholderArtifact.artifactId)?.status,
  "verified"
);
syncProjectWorkspace(placeholderKernel);
assert.equal(
  placeholderKernel.listArtifactLedger().find((entry) => entry.artifactId === placeholderArtifact.artifactId)?.status,
  "pending",
  "a generated registry placeholder must invalidate false Harness evidence"
);
assert.equal(
  placeholderKernel.listArtifacts().find((artifact) => artifact.artifactId === placeholderArtifact.artifactId)?.status,
  "change_requested"
);
for (const artifactId of ["artifact_gdd_baseline_draft", "artifact_game_contract_draft", "artifact_art_bible_baseline_draft"]) {
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  assert.equal(ledger?.status, "pending", `${artifactId} 的工作区占位文件不得成为已验证证据`);
}

let activeCalls = 0;
let maximumConcurrency = 0;
let modelCallCount = 0;
let responseDelayMs = 40;
let firstBatchPublishedEarly = false;
let forcedFailureKind;
const fakeModelRuntime = {
  async respondToTask(currentKernel, task, input) {
    activeCalls += 1;
    modelCallCount += 1;
    maximumConcurrency = Math.max(maximumConcurrency, activeCalls);
    await new Promise((resolve) => setTimeout(resolve, responseDelayMs + (task.ownerAgentId === "game_designer" ? 200 : 0)));
    activeCalls -= 1;

    if (forcedFailureKind) {
      return {
        messageId: `msg_${task.ownerAgentId}_failure_${modelCallCount}`,
        projectId,
        roomId: task.roomId ?? currentKernel.getRoom("studio-main").roomId,
        senderType: "agent",
        senderId: task.ownerAgentId,
        messageType: "blocker",
        content: "Harness 没有产生工具写入。",
        mentions: [],
        relatedTaskIds: [task.taskId],
        relatedArtifactIds: [],
        metadata: {
          failure: true,
          failureKind: forcedFailureKind,
          loopIteration: input.iteration
        },
        createdAt: new Date().toISOString()
      };
    }

    const title = task.ownerAgentId === "game_designer" ? "GDD Baseline" : "Art Bible Baseline";
    const toolRequests = task.outputArtifacts.map((artifactId) => {
      const artifact = currentKernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
      assert.ok(artifact, `missing fixture artifact for ${task.taskId}`);
      return {
        tool: "write_artifact",
        path: artifact.path,
        artifactId,
        artifactType: artifact.type,
        taskId: task.taskId,
        content: artifact.type === "game_contract"
          ? `${JSON.stringify(gameContractFixture(), null, 2)}\n`
          : `# ${title}\n\n由 ${task.ownerAgentId} 在 Agent Loop 第 ${input.iteration} 轮生成。`
      };
    });
    if (task.ownerAgentId === "game_designer") {
      const contract = currentKernel.listArtifacts().find(
        (artifact) => artifact.artifactId === "artifact_game_contract_draft"
      );
      assert.ok(contract);
      toolRequests.unshift({
        tool: "write_artifact",
        path: contract.path,
        artifactId: contract.artifactId,
        artifactType: contract.type,
        taskId: task.taskId,
        content: "{}"
      });
    }
    const payload = {
      loopControl: {
        status: "ready_for_review",
        reason: "基线内容已通过服务端工具提交，等待制作人评审。",
        handoffAgentIds: []
      },
      toolRequests
    };
    return {
      messageId: `msg_${task.ownerAgentId}_${modelCallCount}`,
      projectId,
      roomId: task.roomId ?? currentKernel.getRoom("studio-main").roomId,
      senderType: "agent",
      senderId: task.ownerAgentId,
      messageType: "progress_update",
      content: `提交 ${title} 供制作人评审。\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      mentions: [],
      relatedTaskIds: [task.taskId],
      relatedArtifactIds: [],
      metadata: {
        generatedBy: "agent_loop_smoke_model",
        loopIteration: input.iteration
      },
      createdAt: new Date().toISOString()
    };
  }
};

const service = new AgentLoopService({
  getKernel: () => kernel,
  checkpoint: (currentKernel) => {
    syncProjectWorkspace(currentKernel);
    if (activeCalls > 0 && currentKernel.findTask("task_stage_1_art_direction")?.status === "review") {
      firstBatchPublishedEarly = true;
    }
  },
  modelRuntime: fakeModelRuntime
});

service.start(projectId, {
  reason: "smoke test producer wake",
  unlockProducerWaits: true
});
await waitFor(() => kernel.getAgentLoopState().status !== "running", 4_000);

assert.equal(maximumConcurrency, 2, "策划和美术应在同一回合并行执行");
assert.equal(firstBatchPublishedEarly, true, "fast sibling must publish its outcome while slow sibling is still running");
assert.equal(kernel.findTask("task_stage_1_design_clarification")?.status, "review");
assert.equal(kernel.findTask("task_stage_1_art_direction")?.status, "review");
assert.equal(kernel.getAgentLoopState().status, "blocked", "fixture 的审查 JSON 工具失败不能被作者 review 状态掩盖");
assert.match(kernel.getAgentLoopState().waitingReason ?? "", /质量审查收据不是合法 JSON/);
assert.equal(kernel.getAgentLoopState().agents.game_designer?.status, "waiting");
assert.equal(
  kernel.getAgentLoopState().agents.game_designer?.lastError,
  undefined,
  "同轮较早的契约校验失败在后续成功写入后不得残留为 Agent 错误"
);

for (const artifactId of ["artifact_gdd_baseline_draft", "artifact_game_contract_draft", "artifact_art_bible_baseline_draft"]) {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  assert.ok(artifact?.metadata.toolExecutedAt, `${artifactId} 缺少工具执行证据`);
  assert.equal(ledger?.status, "verified", `${artifactId} 未通过 Artifact Ledger 验证`);
  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, artifact.path);
  assert.ok(existsSync(absolutePath), `${artifact.path} 未实际写入`);
  const materialized = readFileSync(absolutePath, "utf8");
  if (artifact?.type === "game_contract") {
    assert.equal(JSON.parse(materialized).kind, "game_contract");
  } else {
    assert.match(materialized, /Baseline/);
  }
}

const restored = createStudioKernelFromSnapshot(kernel.toSnapshot());
assert.equal(restored.getAgentLoopState().status, "blocked", "重启后应保留真实 Loop 阻塞状态");
assert.equal(restored.getAgentLoopState().iteration, kernel.getAgentLoopState().iteration, "重启后应保留 Loop 轮次");
restored.updateAgentLoopAgent("game_designer", {
  status: "queued",
  taskId: "task_stage_1_design_clarification",
  lastError: "旧轮次残留的契约校验错误",
  updatedAt: new Date().toISOString()
});
assert.equal(reconcileLocalRuntimeProjectState(restored).changed, true);
assert.equal(restored.getAgentLoopState().agents.game_designer?.status, "waiting");
assert.equal(
  restored.getAgentLoopState().agents.game_designer?.lastError,
  undefined,
  "恢复旧快照时必须清理已进入评审任务的陈旧 Agent 错误"
);

kernel.updateTask("task_stage_1_design_clarification", {
  status: "doing",
  blockers: [],
  updatedAt: new Date().toISOString()
});
responseDelayMs = 120;
const versionBeforePause = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gdd_baseline_draft")?.version;
service.start(projectId, { reason: "pause cancellation smoke" });
await new Promise((resolve) => setTimeout(resolve, 15));
service.pause(projectId, "smoke pause");
await new Promise((resolve) => setTimeout(resolve, responseDelayMs + 40));
assert.equal(kernel.getAgentLoopState().status, "paused");
assert.equal(
  kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gdd_baseline_draft")?.version,
  versionBeforePause,
  "暂停后迟到的模型结果不得写入产物"
);

kernel.addTask({
  taskId: "task_harness_no_progress",
  projectId,
  stageId: "concept_discussion",
  roomId: kernel.getRoom("design-room").roomId,
  parentTaskId: "task_group_stage_1",
  taskLevel: "task",
  title: "验证无进展 Harness 重试上限",
  description: "模拟 Claude CLI 没有调用任何工具。",
  ownerAgentId: "game_designer",
  participantAgentIds: [],
  status: "doing",
  priority: 200,
  sortOrder: 5,
  progressPercent: 0,
  blockers: [],
  inputArtifacts: [],
  outputArtifacts: [],
  acceptanceCriteria: ["两次无进展后停止自动重试"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});
forcedFailureKind = "harness_timeout_no_progress";
responseDelayMs = 0;
const callsBeforeNoProgressFailure = modelCallCount;
service.start(projectId, { reason: "no-progress retry limit smoke" });
await waitFor(() => kernel.getAgentLoopState().status !== "running", 4_000);
assert.equal(modelCallCount - callsBeforeNoProgressFailure, 2, "无工具进展的 Harness 超时最多自动尝试两次");
assert.equal(kernel.findTask("task_harness_no_progress")?.status, "blocked");
assert.match(kernel.findTask("task_harness_no_progress")?.blockers.join("；") ?? "", /连续失败 2 次/);
forcedFailureKind = undefined;

addDirectToolFixture({
  taskId: "task_smoke_asset_tool",
  ownerAgentId: "asset_production",
  artifactId: "artifact_smoke_ball",
  artifactType: "asset",
  path: "assets/art/smoke-ball.svg"
});
addDirectToolFixture({
  taskId: "task_smoke_code_tool",
  ownerAgentId: "gameplay_programmer",
  artifactId: "artifact_smoke_controller",
  artifactType: "source_code",
  path: "assets/scripts/SmokeController.ts"
});

const toolMessages = [
  createToolMessage("asset_production", "task_smoke_asset_tool", {
    loopControl: { status: "continue", reason: "继续生成配套资产。", handoffAgentIds: [] },
    toolRequests: [
      {
        tool: "generate_image",
        taskId: "task_smoke_asset_tool",
        artifactId: "artifact_smoke_ball",
        path: "assets/art/smoke-ball.svg",
        artifactType: "asset",
        content: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="#54b895"/></svg>'
      }
    ]
  }),
  createToolMessage("gameplay_programmer", "task_smoke_code_tool", {
    loopControl: { status: "continue", reason: "代码已写入并完成语法检查。", handoffAgentIds: [] },
    toolRequests: [
      {
        tool: "write_code",
        taskId: "task_smoke_code_tool",
        artifactId: "artifact_smoke_controller",
        path: "assets/scripts/SmokeController.ts",
        artifactType: "source_code",
        content: "export class SmokeController { private score = 0; addScore(): number { return ++this.score; } }"
      },
      {
        tool: "run_typecheck",
        taskId: "task_smoke_code_tool",
        path: "assets/scripts/SmokeController.ts"
      }
    ]
  })
];
const directToolResults = await executeAgentToolRequests(kernel, toolMessages);
syncProjectWorkspace(kernel);
assert.deepEqual(directToolResults.map((result) => result.status), ["completed", "completed", "completed"]);
assert.ok(existsSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "assets/art/smoke-ball.svg")));
assert.ok(existsSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "assets/scripts/SmokeController.ts")));

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write(`Agent Loop smoke passed: concurrency=${maximumConcurrency}, modelCalls=${modelCallCount}\n`);

function createToolMessage(agentId, taskId, payload) {
  return {
    messageId: `msg_tool_${agentId}`,
    projectId,
    roomId: kernel.getRoom(agentId === "asset_production" ? "art-room" : "engineering-room").roomId,
    senderType: "agent",
    senderId: agentId,
    messageType: "progress_update",
    content: `执行工具。\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    mentions: [],
    relatedTaskIds: [taskId],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

function addDirectToolFixture({ taskId, ownerAgentId, artifactId, artifactType, path }) {
  const createdAt = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom(ownerAgentId === "asset_production" ? "art-room" : "engineering-room").roomId,
    parentTaskId: "task_group_stage_1",
    taskLevel: "task",
    title: `验证 ${ownerAgentId} 直接工具执行`,
    description: "为工具授权回归提供真实的 owned task 与声明式输出产物。",
    ownerAgentId,
    participantAgentIds: [],
    status: "doing",
    priority: 150,
    sortOrder: 6,
    progressPercent: 0,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts: [artifactId],
    acceptanceCriteria: ["只能在任务声明的产物路径执行工具"],
    createdAt,
    updatedAt: createdAt
  });
  kernel.addArtifact({
    artifactId,
    projectId,
    type: artifactType,
    path,
    ownerAgentId,
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: { generatedBy: "agent_loop_direct_tool_fixture" },
    createdAt,
    updatedAt: createdAt
  });
}

function rewriteSnapshotArtifactId(snapshot, fromArtifactId, toArtifactId) {
  const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === fromArtifactId);
  assert.ok(artifact);
  artifact.artifactId = toArtifactId;
  for (const task of snapshot.tasks) {
    task.inputArtifacts = task.inputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
    task.outputArtifacts = task.outputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
  }
  for (const message of snapshot.messages) {
    message.relatedArtifactIds = message.relatedArtifactIds.map(
      (artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId
    );
  }
  for (const operation of snapshot.artifactOperations) {
    if (operation.artifactId === fromArtifactId) operation.artifactId = toArtifactId;
  }
  for (const ledger of snapshot.artifactLedger) {
    if (ledger.artifactId === fromArtifactId) ledger.artifactId = toArtifactId;
    for (const input of ledger.inputArtifacts ?? []) {
      if (input.artifactId === fromArtifactId) input.artifactId = toArtifactId;
    }
  }
  for (const claim of snapshot.claimVerifications) {
    claim.relatedArtifactIds = claim.relatedArtifactIds.map(
      (artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId
    );
  }
  for (const capsule of snapshot.handoffCapsules ?? []) {
    capsule.artifactIds = capsule.artifactIds.map(
      (artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId
    );
  }
  for (const memory of snapshot.memoryRecords) {
    if (memory.sourceArtifactId === fromArtifactId) memory.sourceArtifactId = toArtifactId;
  }
  for (const event of snapshot.auditEvents) {
    event.inputArtifacts = event.inputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
    event.outputArtifacts = event.outputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
  }
}

function gameContractFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "game_contract",
    identity: {
      contractId: "agent_loop_smoke.contract",
      gameId: "agent_loop_smoke",
      title: "Agent Loop Smoke",
      slug: "agent-loop-smoke",
      summary: "Contract fixture used to prove that design outputs are validated before review.",
      revision: 1,
      releaseVersion: "0.1.0"
    },
    genre: {
      primary: "interaction_test",
      tags: ["interaction_test"],
      perspective: "2d",
      playerMode: "single_player"
    },
    coreLoop: {
      summary: "Start the session, perform the primary action, and reach the objective.",
      steps: [{
        stepId: "primary_loop",
        label: "Primary loop",
        description: "Exercise the public input and progress signal.",
        actionIds: ["primary_action"],
        stateIds: ["playing"],
        emits: ["progress"]
      }],
      successConditions: [{ signalId: "progress", operator: "gte", value: 1 }],
      failureConditions: []
    },
    stateModel: {
      lifecycle: "finite",
      initialState: "ready",
      states: [
        { stateId: "ready", label: "Ready", kind: "boot", terminal: false, description: "Waiting to start." },
        { stateId: "playing", label: "Playing", kind: "active", terminal: false, description: "Main loop." },
        { stateId: "won", label: "Won", kind: "success", terminal: true, description: "Objective reached." }
      ],
      transitions: [
        { transitionId: "start", from: "ready", to: "playing", trigger: { type: "system", ref: "start" }, guards: [], emits: [] },
        { transitionId: "win", from: "playing", to: "won", trigger: { type: "signal", ref: "progress" }, guards: [{ signalId: "progress", operator: "gte", value: 1 }], emits: [] }
      ]
    },
    inputModel: {
      actions: [{
        actionId: "primary_action",
        label: "Primary action",
        description: "The fixture's primary input.",
        bindings: [{ device: "touch", control: "gameplay_area", gesture: "tap" }],
        enabledInStates: ["playing"]
      }],
      simultaneousTouchPoints: 1
    },
    runtimeSignals: {
      signals: [{
        signalId: "progress",
        label: "Progress",
        description: "Public objective progress.",
        valueType: "integer",
        visibility: "public",
        initialValue: 0
      }]
    }
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
