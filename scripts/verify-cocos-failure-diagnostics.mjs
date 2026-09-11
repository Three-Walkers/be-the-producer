import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "btp-cocos-failure-"));
process.env.STUDIO_WORKSPACE_ROOT = join(root, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(root, "state");
const { createStudioKernel, defaultAgentContracts } = await import("@game-pipeline/agent-runtime");
const { CocosEngineBridge } = await import("../apps/api/dist/cocosEngineBridge.js");
const { captureWorkspaceSnapshot, analyzeHarnessWorkspaceChanges, recordHarnessWorkspaceChanges } = await import("../apps/api/dist/harnessWorkspaceEvidence.js");
const { syncProjectWorkspace, resolveProjectWorkspaceRoot } = await import("../apps/api/dist/workspaceWriter.js");
const { artifactReadyForConsumption, taskOutputsVerified } = await import("../apps/api/dist/taskOutputEvidence.js");
try {
  const kernel = createStudioKernel("cocos_failure", "Failure diagnostics", "producer_test", "diagnostic isolation");
  const now = new Date().toISOString();
  kernel.addTask({ taskId: "task_build", projectId: kernel.project.projectId, stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("engineering-room").roomId, taskLevel: "task", title: "Build", description: "Build",
    ownerAgentId: "cocos_automation", participantAgentIds: [], status: "doing", priority: 100, sortOrder: 1,
    blockers: [], inputArtifacts: [], outputArtifacts: ["out_build"], acceptanceCriteria: ["Real build"], createdAt: now, updatedAt: now });
  kernel.addArtifact({ artifactId: "out_build", projectId: kernel.project.projectId, type: "build",
    path: "shared/build-artifacts/wechat/dev", ownerAgentId: "cocos_automation", stageId: kernel.project.currentStage,
    status: "draft", version: 1, sourceTaskId: "task_build", sourceDecisionIds: [], metadata: {}, createdAt: now, updatedAt: now });
  syncProjectWorkspace(kernel);
  const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
  const task = kernel.findTask("task_build");
  const agent = defaultAgentContracts.find((a) => a.agentId === "cocos_automation");
  const before = captureWorkspaceSnapshot(projectRoot);
  const bridge = new CocosEngineBridge(projectRoot, { executablePath: process.execPath, version: "3.8.8", platform: "wechatgame", timeoutMs: 1000 });
  const validation = bridge.validateProject();
  assert.equal(validation.ok, true);
  const failure = bridge.build({ outputDir: "shared/build-artifacts/wechat/dev" });
  assert.equal(failure.ok, false, "a project without a scene must not become a build");
  const operations = [["cocos_validate_project", validation], ["cocos_build", failure]].flatMap(([toolName, result]) =>
    result.evidence.map((item) => ({ toolName, ...item, status: result.ok ? "completed" : "failed",
      bridgeOk: result.ok, operationId: result.operationId, operationType: result.operationType, error: result.error })));
  const after = captureWorkspaceSnapshot(projectRoot);
  const analyze = (ops = operations, snapshot = after) => analyzeHarnessWorkspaceChanges(kernel, task, agent, before, snapshot,
    undefined, ops, { authoritativeWorkspace: true });
  assert.deepEqual(analyze().violations, [], "server-written failure diagnostics must not roll back earlier success");
  const evidence = recordHarnessWorkspaceChanges(kernel, task, agent, before, after, "inv_cocos_failure", undefined, operations,
    { authoritativeWorkspace: true });
  assert.deepEqual(evidence.violations, []);
  assert.ok(evidence.artifactIds.length > 0, "earlier successful validation survives");
  assert.ok(evidence.toolExecutions.some((op) => op.toolName === "cocos_build" && op.status === "failed"));
  assert.ok(!kernel.listArtifacts().some((a) => failure.evidence.some((e) => e.path === a.path)), "failure diagnostics are not registered as successful artifacts");
  assert.equal(artifactReadyForConsumption(kernel, "out_build"), false);
  assert.equal(taskOutputsVerified(kernel, task), false);
  const forged = operations.map((op) => op.bridgeOk === false ? { ...op, hash: "0".repeat(64) } : op);
  assert.ok(analyze(forged).violations.length > 0, "diagnostics need exact server byte receipts");
  const target = join(projectRoot, failure.reportPath);
  const original = readFileSync(target);
  writeFileSync(target, original.toString().replace('"status": "failed"', '"status": "success"'));
  assert.ok(analyze(operations, captureWorkspaceSnapshot(projectRoot)).violations.length > 0, "a tampered success claim is not a failure diagnostic");
  console.log("Cocos diagnostics passed: preserve successful work, retain failures, reject tampering, never approve a failed build.");
} finally { rmSync(root, { recursive: true, force: true }); }
