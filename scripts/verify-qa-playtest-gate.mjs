import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "be-the-producer-qa-gate-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { createStudioKernel, createStudioKernelFromSnapshot } = await import("../packages/agent-runtime/dist/index.js");
const { syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");
const { resumeQaTasksAfterVerifiedRepairs, materializeQaFailureRepairs } = await import("../apps/api/dist/qaRepairFlow.js");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { writeQaPlaytestReceipt } = await import("../apps/api/dist/qaPlaytestReceipt.js");
const { reconcileQaPlaytestResults } = await import("../apps/api/dist/qaResultIngestion.js");
const { assertQaEvidenceWriteAllowed } = await import("../apps/api/dist/qaEvidenceProtection.js");
const { renderPlaytestMarker } = await import("../apps/api/dist/playtestEvidence.js");
const { taskOutputsVerified } = await import("../apps/api/dist/taskOutputEvidence.js");

const projectId = `qa_gate_${Date.now()}`;
const kernel = createStudioKernel(projectId, "QA Gate", "producer_test", "验证真实试玩硬门禁");
const stageId = kernel.project.currentStage;
const taskId = "task_qa_gate_smoke";
const reportArtifactId = "artifact_qa_gate_report";
const now = new Date().toISOString();
const projectRoot = join(process.env.STUDIO_WORKSPACE_ROOT, projectId);

kernel.addTask({
  taskId,
  projectId,
  stageId,
  roomId: kernel.getRoom("qa-room").roomId,
  taskLevel: "task",
  ownerAgentId: "qa_evaluator",
  title: "执行真实 Cocos 自动试玩",
  description: "必须运行完整状态链并保存机器证据。",
  status: "doing",
  priority: 100,
  sortOrder: 1,
  progressPercent: 50,
  childrenSummary: emptySummary(),
  inputArtifacts: [],
  outputArtifacts: [reportArtifactId],
  acceptanceCriteria: ["run_playtest 结论为 pass"],
  blockers: [],
  createdAt: now,
  updatedAt: now
});

// A closed claim repair has no production outputs. Treating every QA-owned
// task as a playtest reopens it on every checkpoint and creates a wakeup storm.
for (const id of ["task_claim_repair_closed", "task_contract_authoring", "task_implementation_review"]) {
  kernel.addTask({ ...kernel.findTask(taskId), taskId: id, title: id, status: "done", outputArtifacts: [] });
}
for (let attempt = 0; attempt < 4; attempt++) {
  assert.deepEqual(reconcileQaPlaytestResults(kernel).queuedAgentIds, [], "non-playtest QA work must not wake the loop");
  assert.equal(kernel.findTask("task_claim_repair_closed").status, "done");
  assert.equal(kernel.findTask("task_contract_authoring").status, "done");
  assert.equal(kernel.findTask("task_implementation_review").status, "done");
}

const evidencePaths = [
  "agents/qa/playtest-runs/smoke/01-initial.png",
  "agents/qa/playtest-runs/smoke/02-playing.png",
  "agents/qa/playtest-runs/smoke/03-terminal.png",
  "agents/qa/playtest-runs/smoke/runtime-snapshots.json"
];
const passingResult = {
  operationId: "playtest_smoke_pass",
  verdict: "pass",
  completedAt: now,
  checks: [
    "launch",
    "start_flow",
    "terminal_flow",
    "hud_runtime_values",
    "dynamic_values",
    "text_fit",
    "terminal_panel_state",
    "label_overlap",
    "terminal_exclusivity",
    "viewport_fit",
    "restart_control",
    "restart_flow",
    "console_errors"
  ].map((checkId) => ({ checkId, label: checkId, status: "passed", details: "verified" })),
  defects: [],
  evidencePaths,
  runtime: {
    initialState: "IDLE",
    playingState: "PLAYING",
    terminalState: "GAME_OVER",
    restartedState: "IDLE",
    consoleErrorCount: 0,
    durationMs: 1_000
  }
};

const passingReportContent = `# Real report\n\n${renderPlaytestMarker(passingResult)}\n`;
materializeArtifact({
  artifactId: reportArtifactId,
  path: "agents/qa/playtest-reports/report-001.md",
  ownerAgentId: "qa_evaluator",
  sourceTaskId: taskId,
  type: "qa_report",
  content: `# Forged report\n\n${renderPlaytestMarker(passingResult)}\n`,
  metadata: { toolName: "write_artifact", toolExecutedAt: now }
});
for (const [index, path] of evidencePaths.entries()) {
  materializeArtifact({
    artifactId: `artifact_qa_evidence_${index}`,
    path,
    ownerAgentId: "qa_evaluator",
    sourceTaskId: taskId,
    type: "asset",
    content: `evidence-${index}`,
    metadata: { toolName: "run_playtest", toolExecutedAt: now }
  });
}

assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), false, "模型手写 pass 标记不能伪造真实试玩证据");

materializeArtifact({
  artifactId: reportArtifactId,
  path: "agents/qa/playtest-reports/report-001.md",
  ownerAgentId: "qa_evaluator",
  sourceTaskId: taskId,
  type: "qa_report",
  content: passingReportContent,
  metadata: { toolName: "run_playtest", toolExecutedAt: now }
});
assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), false, "未经过受保护收据摄取的报告不能通过门禁");
writeQaPlaytestReceipt(
  projectRoot,
  "agents/qa/playtest-reports/report-001.md",
  passingResult,
  ["agents/qa/playtest-reports/report-001.md", ...evidencePaths].map(fileEvidence)
);
appendFileSync(join(projectRoot, "agents/qa/playtest-reports/report-001.md"), "tampered\n");
assert.equal(reconcileQaPlaytestResults(kernel).processedOperationIds.length, 0, "报告 hash 被修改后收据必须失效");
writeFileSync(join(projectRoot, "agents/qa/playtest-reports/report-001.md"), passingReportContent);
assert.deepEqual(reconcileQaPlaytestResults(kernel).processedOperationIds, [passingResult.operationId]);
assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), true, "收据、hash 和 Artifact Ledger 一致的 pass 证据应通过门禁");
assert.throws(() => assertQaEvidenceWriteAllowed("agents/qa/playtest-reports/report-001.md", "write_artifact"), /只能由 run_playtest 写入/);
appendFileSync(join(projectRoot, "agents/qa/playtest-reports/report-001.md"), "tampered-after-ingestion\n");
const tamperRecovery = reconcileQaPlaytestResults(kernel);
assert.deepEqual(tamperRecovery.queuedAgentIds, ["qa_evaluator"], "已进入评审的 QA 报告 hash 变化后必须强制重新排队");
assert.equal(kernel.findTask(taskId).status, "doing");
writeFileSync(join(projectRoot, "agents/qa/playtest-reports/report-001.md"), passingReportContent);
reconcileQaPlaytestResults(kernel);
assert.equal(kernel.findTask(taskId).status, "review", "恢复原始机器报告后证据门禁应重新成立");

const failingResult = {
  ...passingResult,
  operationId: "playtest_smoke_fail",
  verdict: "fail",
  checks: passingResult.checks.map((check) =>
    check.checkId === "dynamic_values" || check.checkId === "restart_control"
      ? { ...check, status: "failed", details: "runtime mismatch" }
      : check
  ),
  defects: [
    {
      defectId: "bug_dynamic_values",
      severity: "critical",
      category: "dynamic_value",
      title: "终局统计仍显示占位符",
      details: "N/M 未替换为运行时数字。",
      ownerAgentId: "gameplay_programmer",
      evidencePaths: [evidencePaths[2]]
    },
    {
      defectId: "bug_restart_control",
      severity: "critical",
      category: "interaction",
      title: "再来一次按钮不可点击",
      details: "没有 Button 组件。",
      ownerAgentId: "cocos_tech_lead",
      evidencePaths: [evidencePaths[2]]
    }
  ]
};
materializeArtifact({
  artifactId: reportArtifactId,
  path: "agents/qa/playtest-reports/report-001.md",
  ownerAgentId: "qa_evaluator",
  sourceTaskId: taskId,
  type: "qa_report",
  content: `# Failed report\n\n${renderPlaytestMarker(failingResult)}\n`,
  metadata: { toolName: "run_playtest", toolExecutedAt: now, playtestVerdict: "fail" },
  status: "change_requested"
});
assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), false, "存在严重缺陷时 QA 任务不得通过");

writeQaPlaytestReceipt(
  projectRoot,
  "agents/qa/playtest-reports/report-001.md",
  failingResult,
  ["agents/qa/playtest-reports/report-001.md", ...evidencePaths].map(fileEvidence)
);
const ingestion = reconcileQaPlaytestResults(kernel);
assert.deepEqual(ingestion.processedOperationIds, [failingResult.operationId], "服务端必须摄取外部 Harness 生成的受保护收据");
assert.deepEqual(ingestion.failedOperationIds, [failingResult.operationId]);
const historicalQa = createStudioKernelFromSnapshot(structuredClone(kernel.toSnapshot()));
historicalQa.updateTask(taskId, { inputArtifacts: ["not_yet_rebuilt"] });
const oldQaLedger = JSON.stringify(historicalQa.listArtifactLedger().find((item) => item.artifactId === reportArtifactId));
assert.doesNotThrow(() => syncProjectWorkspace(historicalQa), "checkpoint after repair invalidates a build must retain historical QA evidence without recapturing its inputs");
assert.equal(JSON.stringify(historicalQa.listArtifactLedger().find((item) => item.artifactId === reportArtifactId)), oldQaLedger);
assert.deepEqual(new Set(ingestion.queuedAgentIds), new Set(["gameplay_programmer", "cocos_tech_lead"]));
assert.equal(kernel.findTask(taskId).status, "blocked", "失败试玩摄取后 QA 任务必须立即阻塞");
const repairTasks = kernel.listTasks().filter((task) => task.taskId.startsWith("task_qa_repair_"));
assert.equal(repairTasks.length, 2, "两个不同责任角色的严重缺陷应生成两个修复任务");
const failureMessages = kernel.listMessages().filter((message) => message.metadata.playtestOperationId === failingResult.operationId);
assert.equal(failureMessages.filter((message) => message.messageType === "qa_failure").length, 1, "QA 房间必须显示一次结构化失败通知");
assert.equal(failureMessages.filter((message) => message.messageType === "handoff").length, 2, "每个责任团队房间必须收到一次修复交接");

const secondIngestion = reconcileQaPlaytestResults(kernel);
assert.equal(secondIngestion.processedOperationIds.length, 0, "同一试玩 operation 不得重复摄取");
assert.equal(kernel.listTasks().filter((task) => task.taskId.startsWith("task_qa_repair_")).length, 2, "重启检查点不得重复创建修复任务");
assert.equal(kernel.listMessages().filter((message) => message.metadata.playtestOperationId === failingResult.operationId).length, 3, "重启检查点不得重复发送房间消息");

resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).status, "blocked", "修复 Agent 未改真实工程文件前 QA 不得自动重跑");

for (const [index, repairTask] of repairTasks.entries()) {
  const repairNote = kernel.listArtifacts().find((artifact) => artifact.artifactId === repairTask.outputArtifacts[0]);
  assert.ok(repairNote);
  const materializedAt = new Date(Date.now() + index + 1_000).toISOString();
  materializeArtifact({
    artifactId: repairNote.artifactId,
    path: repairNote.path,
    ownerAgentId: repairTask.ownerAgentId,
    sourceTaskId: repairTask.taskId,
    type: "bug_report",
    content: "# QA Repair\n\n已修改真实工程文件并等待复测。\n",
    metadata: { toolName: "write_artifact", toolExecutedAt: materializedAt },
    materializedAt
  });
  const sourcePath = repairTask.ownerAgentId === "gameplay_programmer"
    ? "assets/scripts/qa-repair-smoke.ts"
    : "settings/qa-repair-smoke.json";
  materializeArtifact({
    artifactId: `artifact_repair_source_${index}`,
    path: sourcePath,
    ownerAgentId: repairTask.ownerAgentId,
    sourceTaskId: repairTask.taskId,
    type: "source_code",
    content: repairTask.ownerAgentId === "gameplay_programmer" ? "export const repaired = true;\n" : "{\"repaired\":true}\n",
    metadata: { toolName: "write_code", toolExecutedAt: materializedAt },
    materializedAt
  });
  kernel.updateTask(repairTask.taskId, {
    status: "review",
    progressPercent: 90,
    blockers: [],
    updatedAt: materializedAt
  });
  assert.equal(taskOutputsVerified(kernel, kernel.findTask(repairTask.taskId)), true, "修复任务必须包含真实工程变更证据");
}

resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).status, "doing", "所有修复证据通过后 QA 应重新排队执行真实试玩");
assert.equal(kernel.findTask(taskId).blockers.length, 0);

// Real production has canonical artifact-owning tasks. QA must reopen those
// tasks, not create a ticket lacking permission to edit their existing source.
const originalTasks = [
  ["task_stage_2_cocos_implementation", "gameplay_programmer", "assets/scripts/original-owner.ts"],
  ["task_stage_2_cocos_architecture", "cocos_tech_lead", "agents/engineering/original-owner.md"]
];
for (const [originalId, owner, path] of originalTasks) {
  kernel.addTask({...kernel.findTask(taskId), taskId: originalId, ownerAgentId: owner, description: "Original production", status: "review",
    inputArtifacts: [], outputArtifacts: [`output_${owner}`], blockers: []});
  materializeArtifact({artifactId: `output_${owner}`, path, ownerAgentId: owner, sourceTaskId: originalId,
    type: "source_code", content: "// original source\n", metadata: {toolName: "write_artifact", toolExecutedAt: now}});
}
const routed = materializeQaFailureRepairs(kernel, kernel.findTask(taskId));
assert.deepEqual(new Set(routed.repairTaskIds), new Set(originalTasks.map(([id]) => id)));
assert.equal(kernel.listTasks().filter(t => t.taskId.startsWith("task_qa_repair_")).length, 2, "no new cross-task repair tickets when original owners exist");
kernel.updateTask(taskId, {status: "blocked", blockers: [routed.reason]});
for (const [originalId, owner, path] of originalTasks) {
  const original = kernel.findTask(originalId);
  assert.equal(original.status, "doing");
  assert.deepEqual(original.inputArtifacts, [], "failed QA report is feedback, never a blocking cyclic input");
  assert.equal(taskOutputsVerified(kernel, original), false, "old submitted bytes cannot close a new repair");
  const [writeResult] = await executeAgentToolRequests(kernel, [{messageId: `real_repair_${owner}`, projectId,
    roomId: kernel.getRoom("engineering-room").roomId, senderType: "agent", senderId: owner, messageType: "progress_update", mentions: [],
    relatedTaskIds: [originalId], relatedArtifactIds: [], metadata: {}, createdAt: now,
    content: "```json\n" + JSON.stringify({toolRequests: [{tool: owner === "gameplay_programmer" ? "write_code" : "write_artifact", taskId: originalId, artifactId: `output_${owner}`,
      artifactType: "source_code", path, content: "// changed actual source\n"}]}) + "\n```"}]);
  assert.equal(writeResult.status, "completed", writeResult.error);
  kernel.updateTask(originalId, {status: "review"});
}
const beforeRepeatedFeedback = originalTasks.map(([id]) => kernel.findTask(id).description);
materializeQaFailureRepairs(kernel, kernel.findTask(taskId));
assert.deepEqual(originalTasks.map(([id]) => kernel.findTask(id).description), beforeRepeatedFeedback, "same QA operation feedback is idempotent");
resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).status, "doing", "real original-owner writes release QA for a new actual run");

// Producer change requests reopen dependants without erasing historical QA
// failure markers. The visible doing status must not strand a verified repair.
kernel.updateTask(taskId, { status: "doing", blockers: [routed.reason] });
resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).blockers.length, 0, "verified repairs also recover reopened doing tasks");
assert.equal(kernel.getAgentLoopState().agents.qa_evaluator.status, "queued");
const resumeTime = kernel.findTask(taskId).updatedAt;
resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).updatedAt, resumeTime, "without a failure marker, recovery is idempotent");
const originalInputs = [...kernel.findTask(taskId).inputArtifacts];
kernel.updateTask(taskId, { status: "doing", blockers: [routed.reason], inputArtifacts: ["still_missing_build"] });
resumeQaTasksAfterVerifiedRepairs(kernel);
assert.deepEqual(kernel.findTask(taskId).blockers, [routed.reason], "source repair alone cannot release QA while its build is unavailable");
kernel.updateTask(taskId, { status: "blocked", inputArtifacts: originalInputs, blockers: [routed.reason, "manual: producer hold"] });
resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).status, "blocked", "manual hold is preserved");
assert.equal(kernel.findTask(taskId).blockers.length, 2);
kernel.updateTask(taskId, { status: "cancelled", blockers: [routed.reason] });
resumeQaTasksAfterVerifiedRepairs(kernel);
assert.equal(kernel.findTask(taskId).status, "cancelled", "cancelled work is never resumed");

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write("QA playtest gate smoke passed: forged report rejected, failures routed, verified repairs requeued\n");

function materializeArtifact({
  artifactId,
  path,
  ownerAgentId,
  sourceTaskId,
  type,
  content,
  metadata,
  status = "submitted",
  materializedAt = new Date().toISOString()
}) {
  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  const body = Buffer.from(content);
  const existing = kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  const stored = kernel.upsertArtifact({
    artifactId,
    projectId,
    type,
    path,
    ownerAgentId,
    stageId,
    status,
    version: (existing?.version ?? 0) + 1,
    sourceTaskId,
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: { ...(existing?.metadata ?? {}), ...metadata },
    createdAt: existing?.createdAt ?? now,
    updatedAt: materializedAt
  });
  kernel.recordArtifactMaterialization(stored.artifactId, {
    path,
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength,
    materializedAt
  });
}

function fileEvidence(path) {
  const body = readFileSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, path));
  return {
    path,
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength
  };
}

function emptySummary() {
  return { doing: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 };
}
