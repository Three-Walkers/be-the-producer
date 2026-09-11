import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-claude-harness-"));
const projectRoot = join(tempRoot, "project");
const fakeClaude = join(tempRoot, "fake-claude.mjs");
mkdirSync(projectRoot, { recursive: true });
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9-test\\n");
  process.exit(0);
}
if (process.env.TEST_SECRET_SHOULD_NOT_LEAK) {
  process.stderr.write("TEST_SECRET_SHOULD_NOT_LEAK leaked into Claude environment.\\n");
  process.exit(91);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("ABORT_TEST")) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (prompt.includes("HANG_NO_PROGRESS")) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (prompt.includes("STREAM_BEFORE_WRITE")) {
  for (let index = 0; index < 6; index++) {
    process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "." } } }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (prompt.includes("RESUME_FAIL") && args.includes("--resume")) {
  process.stderr.write("Session does not exist or can no longer be resumed.\\n");
  process.exit(1);
}
if (prompt.includes("SESSION_LOG_FAIL")) {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const sessionDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "synthetic-project");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, sessionId + ".jsonl"), [
    JSON.stringify({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId }),
    JSON.stringify({ type: "assistant", error: "unknown", message: { content: [{ type: "text", text: "API Error: terminated" }] } })
  ].join("\\n") + "\\n");
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: ["sensitive_tool_list"] }) + "\\n");
  process.exit(1);
}
if (prompt.includes("FAILED_WRITE")) {
  const configIndex = args.indexOf("--mcp-config");
  const config = JSON.parse(args[configIndex + 1]);
  const operationLogPath = config.mcpServers.btp_workspace.env.BTP_OPERATION_LOG_PATH;
  mkdirSync(dirname(operationLogPath), { recursive: true });
  writeFileSync(operationLogPath, JSON.stringify({
    toolName: "write_artifact",
    path: "docs/design/harness-proof.md",
    status: "failed",
    error: "synthetic validation rejection",
    recordedAt: new Date().toISOString()
  }) + "\\n");
  process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"写入被结构校验拒绝。"}]}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result", result:"写入被结构校验拒绝。"}) + "\\n");
  process.exit(0);
}
if (prompt.includes("PARTIAL_PROGRESS")) {
  const configIndex = args.indexOf("--mcp-config");
  const config = JSON.parse(args[configIndex + 1]);
  const operationLogPath = config.mcpServers.btp_workspace.env.BTP_OPERATION_LOG_PATH;
  const target = join(process.cwd(), "docs/design/harness-proof.md");
  mkdirSync(dirname(target), { recursive: true });
  const content = "# Partial Harness Proof\\n\\nThe tool write completed before the CLI stopped.\\n";
  writeFileSync(target, content);
  mkdirSync(dirname(operationLogPath), { recursive: true });
  writeFileSync(operationLogPath, JSON.stringify({ toolName: "write_artifact", path: "docs/design/harness-proof.md", status: "completed", hash: "test", sizeBytes: content.length, recordedAt: new Date().toISOString() }) + "\\n");
  process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"工具写入已完成，正在继续检查。"}]}}) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
const target = join(process.cwd(), "docs/design/harness-proof.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, "# Harness Proof\\n\\nClaude CLI wrote this file from its native Write/Edit loop.\\n");
const harnessState = join(process.cwd(), ".be-the-producer", "test");
mkdirSync(harnessState, { recursive: true });
writeFileSync(join(harnessState, "harness-args.json"), JSON.stringify(args));
const sessionId = "11111111-1111-4111-8111-111111111111";
process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:sessionId}) + "\\n");
process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"已实际写入任务文件。"}]}}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", result:"已实际写入任务文件。", session_id:sessionId}) + "\\n");
`,
  "utf8"
);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_CLI_PATH = fakeClaude;
process.env.TEST_SECRET_SHOULD_NOT_LEAK = "super-secret";

const { ClaudeCliHarness, ClaudeCliProcessError, ClaudeSessionResumeError } = await import("../apps/api/dist/claudeCliHarness.js");
const { captureWorkspaceSnapshot, recordHarnessWorkspaceChanges } = await import("../apps/api/dist/harnessWorkspaceEvidence.js");
const { createStudioKernel, defaultAgentContracts, getQualityReviewArtifactContracts } = await import("@game-pipeline/agent-runtime");
const { createTaskHarnessAuthorization } = await import("../apps/api/dist/toolAuthorization.js");
const {
  hashArtVisionRequestSemantics,
  hashArtVisionSemanticResult
} = await import("../apps/api/dist/multimodalArtProvider.js");
const {
  buildVisionReviewAuthoritativeContext
} = await import("../apps/api/dist/qualityReviewArtifacts.js");

const harness = new ClaudeCliHarness({
  timeoutMs: 600,
  initialProgressTimeoutMs: 150,
  idleAfterProgressMs: 150,
  settleAfterExpectedOutputsMs: 50
});
const status = await harness.status();
assert.equal(status.available, true);
assert.match(status.version, /9\.9\.9-test/);

const kernel = createStudioKernel("harness_test", "Harness Test", "producer", "验证 Claude CLI 持续工作");
const agent = defaultAgentContracts.find((candidate) => candidate.agentId === "game_designer");
assert.ok(agent);
const now = new Date().toISOString();
kernel.addTask({
  taskId: "task_harness",
  projectId: kernel.project.projectId,
  stageId: "concept_discussion",
  roomId: kernel.getRoom("design-room").roomId,
  parentTaskId: undefined,
  taskLevel: "task",
  title: "写入 Harness 证明",
  description: "使用 CLI 原生工具写入文件",
  ownerAgentId: agent.agentId,
  participantAgentIds: [],
  status: "doing",
  priority: 100,
  sortOrder: 1,
  progressPercent: 0,
  blockers: [],
  inputArtifacts: [],
  outputArtifacts: ["artifact_harness_proof"],
  acceptanceCriteria: ["文件存在且有 hash"],
  createdAt: now,
  updatedAt: now
});
kernel.upsertArtifact({
  artifactId: "artifact_harness_proof",
  projectId: kernel.project.projectId,
  type: "gdd",
  path: "docs/design/harness-proof.md",
  ownerAgentId: agent.agentId,
  stageId: "concept_discussion",
  status: "draft",
  version: 1,
  sourceTaskId: "task_harness",
  sourceDecisionIds: [],
  metadata: {},
  createdAt: now,
  updatedAt: now
});
const task = kernel.findTask("task_harness");
assert.ok(task);
const provider = {
  providerId: "test-anthropic",
  label: "Test Anthropic",
  protocol: "anthropic",
  baseUrl: "https://example.invalid/apps/anthropic",
  defaultModel: "qwen-test",
  apiKey: "test-only"
};
const authorization = createTaskHarnessAuthorization(kernel, task, agent, {
  read: [],
  write: ["docs/design/harness-proof.md"]
});
const before = captureWorkspaceSnapshot(projectRoot);
const harnessProgress = [];
const result = await harness.run({
  projectId: kernel.project.projectId,
  projectRoot,
  agent,
  provider,
  model: "qwen-test",
  systemPrompt: "test",
  userPrompt: "write the proof",
  authorization,
  onProgress: (event) => harnessProgress.push(event)
});
assert.equal(result.sessionId, "11111111-1111-4111-8111-111111111111");
const after = captureWorkspaceSnapshot(projectRoot);
const evidence = recordHarnessWorkspaceChanges(kernel, task, agent, before, after, result.invocationId);
assert.deepEqual(evidence.violations, []);
assert.ok(evidence.changedPaths.includes("docs/design/harness-proof.md"));
assert.ok(evidence.toolExecutions.some((tool) => tool.status === "completed"));
assert.equal(kernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_harness_proof")?.status, "verified");
assert.ok(kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_harness_proof")?.metadata.toolExecutedAt);
assert.deepEqual(harnessProgress.map((event) => event.type), ["started", "model_output", "completed"]);
const streamingBeforeWrite = await harness.run({
  projectId: kernel.project.projectId, projectRoot, agent, provider, model: "qwen-test",
  systemPrompt: "test", userPrompt: "STREAM_BEFORE_WRITE", authorization,
  requireToolProgress: true, expectedPaths: ["docs/design/harness-proof.md"]
});
assert.equal(streamingBeforeWrite.sessionId, result.sessionId,
  "active output before a large write must not hit the initial inactivity timeout");

const failedWritePath = "docs/design/harness-proof.md";
const failedWriteAbsolutePath = join(projectRoot, failedWritePath);
const failedWriteBytesBefore = readFileSync(failedWriteAbsolutePath);
const failedWriteArtifactBefore = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_harness_proof");
const failedWriteLedgerBefore = kernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_harness_proof");
assert.ok(failedWriteArtifactBefore && failedWriteLedgerBefore);
const failedWriteVersionBefore = failedWriteArtifactBefore.version;
const failedWriteStatusBefore = failedWriteArtifactBefore.status;
const failedWriteLedgerSnapshot = structuredClone(failedWriteLedgerBefore);
const failedWriteResult = await harness.run({
  projectId: kernel.project.projectId,
  projectRoot,
  agent,
  provider,
  model: "qwen-test",
  systemPrompt: "test",
  userPrompt: "FAILED_WRITE",
  authorization,
  expectedPaths: [failedWritePath]
});
assert.deepEqual(failedWriteResult.changedPaths, [], "失败写操作不得进入 invocation changed paths");
assert.equal(failedWriteResult.toolOperations?.length, 1);
assert.equal(failedWriteResult.toolOperations?.[0]?.status, "failed");
const failedWriteAfter = captureWorkspaceSnapshot(projectRoot);
const failedWriteEvidence = recordHarnessWorkspaceChanges(
  kernel,
  task,
  agent,
  after,
  failedWriteAfter,
  failedWriteResult.invocationId,
  [failedWritePath],
  failedWriteResult.toolOperations
);
assert.deepEqual(failedWriteEvidence.changedPaths, [], "证据层必须防御性剔除 failed-only operation path");
assert.deepEqual(failedWriteEvidence.artifactIds, []);
assert.ok(
  failedWriteEvidence.toolExecutions.some(
    (execution) => execution.status === "failed" && execution.path === failedWritePath &&
      execution.error === "synthetic validation rejection"
  ),
  "失败写操作必须保留在 toolExecutions 审计中"
);
assert.deepEqual(readFileSync(failedWriteAbsolutePath), failedWriteBytesBefore, "失败写操作不得改变已有文件字节");
const failedWriteArtifactAfter = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_harness_proof");
const failedWriteLedgerAfter = kernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_harness_proof");
assert.equal(failedWriteArtifactAfter?.version, failedWriteVersionBefore, "失败写操作不得增加 artifact version");
assert.equal(failedWriteArtifactAfter?.status, failedWriteStatusBefore, "失败写操作不得改变 artifact status");
assert.deepEqual(failedWriteLedgerAfter, failedWriteLedgerSnapshot, "失败写操作不得重写已验证 ledger");

const failedMutationBefore = captureWorkspaceSnapshot(projectRoot);
writeFileSync(failedWriteAbsolutePath, "# Partial bytes from a failed tool\n", "utf8");
const failedMutationAfter = captureWorkspaceSnapshot(projectRoot);
const rejectedFailedMutation = recordHarnessWorkspaceChanges(
  kernel,
  task,
  agent,
  failedMutationBefore,
  failedMutationAfter,
  "inv_failed_partial_mutation",
  [],
  [{
    toolName: "write_artifact",
    path: failedWritePath,
    access: "write",
    status: "failed",
    error: "synthetic disk failure"
  }]
);
assert.deepEqual(rejectedFailedMutation.changedPaths, [failedWritePath]);
assert.ok(rejectedFailedMutation.violations.some((violation) => /失败工具仍修改/.test(violation)));
assert.deepEqual(rejectedFailedMutation.artifactIds, [], "partial bytes from a failed tool must never enter the artifact ledger");
writeFileSync(failedWriteAbsolutePath, failedWriteBytesBefore);

const concurrentBefore = captureWorkspaceSnapshot(projectRoot);
writeFileSync(join(projectRoot, "docs/design/harness-proof.md"), "# Harness Proof\n\nOnly the design Agent changed this file.\n", "utf8");
mkdirSync(join(projectRoot, "agents/art"), { recursive: true });
writeFileSync(join(projectRoot, "agents/art/concurrent-art.md"), "# Concurrent Art\n", "utf8");
const concurrentAfter = captureWorkspaceSnapshot(projectRoot);
const isolatedEvidence = recordHarnessWorkspaceChanges(
  kernel,
  task,
  agent,
  concurrentBefore,
  concurrentAfter,
  "inv_concurrent_isolation",
  ["docs/design/harness-proof.md"]
);
assert.deepEqual(isolatedEvidence.changedPaths, ["docs/design/harness-proof.md"]);
assert.deepEqual(isolatedEvidence.violations, []);

const unchangedBefore = captureWorkspaceSnapshot(projectRoot);
const unchangedAfter = captureWorkspaceSnapshot(projectRoot);
const repeatedWriteEvidence = recordHarnessWorkspaceChanges(
  kernel,
  task,
  agent,
  unchangedBefore,
  unchangedAfter,
  "inv_repeated_tool_write",
  ["docs/design/harness-proof.md"]
);
assert.deepEqual(repeatedWriteEvidence.changedPaths, ["docs/design/harness-proof.md"]);
const sameFile = unchangedAfter.get("docs/design/harness-proof.md");
const repeatOperation = { toolName: "write_artifact", path: sameFile.path, hash: sameFile.hash,
  sizeBytes: sameFile.sizeBytes, access: "write", status: "completed" };
const authoritativeRepeat = (operation) => recordHarnessWorkspaceChanges(kernel, task, agent, unchangedBefore,
  unchangedAfter, "inv_authoritative_repeat", undefined, operation ? [operation] : [], { authoritativeWorkspace: true });
assert.deepEqual(authoritativeRepeat().changedPaths, [], "existing bytes alone cannot resubmit an output");
assert.deepEqual(authoritativeRepeat({ ...repeatOperation, access: "read" }).changedPaths, []);
assert.deepEqual(authoritativeRepeat({ ...repeatOperation, status: "failed" }).changedPaths, []);
assert.deepEqual(authoritativeRepeat({ ...repeatOperation, hash: "0".repeat(64) }).changedPaths, []);
assert.deepEqual(authoritativeRepeat(repeatOperation).changedPaths, [sameFile.path], "byte-matching authorized idempotent writes must survive staging diff analysis");

await harness.run({
  projectId: kernel.project.projectId,
  projectRoot,
  agent,
  provider,
  model: "qwen-test",
  systemPrompt: "test",
  userPrompt: "resume the proof",
  visionProducerDecisions: [{messageId: "producer_scope", content: "Scope fixture", createdAt: "2026-09-11T00:00:00.000Z"}],
  authorization,
  sessionId: result.sessionId,
  sessionKey: "task:harness_test:design-room:task_harness:game_designer:e0",
  sessionScope: "task_child"
});
const args = JSON.parse(readFileSync(join(projectRoot, ".be-the-producer/test/harness-args.json"), "utf8"));
const toolsArg = args[args.indexOf("--tools") + 1].split(",");
for (const unsafeBuiltin of ["Read", "Glob", "Grep", "Bash"]) {
  assert.equal(toolsArg.includes(unsafeBuiltin), false, `Claude task tools must not expose ${unsafeBuiltin}`);
}
assert.ok(toolsArg.includes("mcp__btp_workspace__read_file"));
assert.ok(toolsArg.includes("mcp__btp_workspace__read_image"));
const mcpConfigArg = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
assert.equal(mcpConfigArg.mcpServers.btp_workspace.env.BTP_TOOL_MODE, "task");
assert.equal(JSON.parse(mcpConfigArg.mcpServers.btp_workspace.env.BTP_VISION_PRODUCER_DECISIONS)[0].messageId, "producer_scope");
assert.equal("BTP_ALLOWED_ROOTS" in mcpConfigArg.mcpServers.btp_workspace.env, false);
assert.ok(args.includes("--resume"));
assert.ok(args.includes(result.sessionId));
assert.ok(args.includes("--name"));
assert.ok(args.includes("task-harness_test-design-room-task_harness-game_designer-e0"));

await assert.rejects(
  harness.run({
    projectId: kernel.project.projectId,
    projectRoot,
    agent,
    provider,
    model: "qwen-test",
    systemPrompt: "test",
    userPrompt: "RESUME_FAIL",
    authorization,
    sessionId: result.sessionId,
    sessionKey: "task:harness_test:design-room:task_harness:game_designer:e0",
    sessionScope: "task_child",
    requireToolProgress: false
  }),
  (error) => error instanceof ClaudeSessionResumeError && error.sessionId === result.sessionId
);

const failedProcessProgress = [];
let processFailure;
try {
  await harness.run({
    projectId: kernel.project.projectId,
    projectRoot,
    agent,
    provider,
    model: "qwen-test",
    systemPrompt: "test",
    userPrompt: "SESSION_LOG_FAIL",
    authorization,
    requireToolProgress: false,
    onProgress: (event) => failedProcessProgress.push(event)
  });
} catch (error) {
  processFailure = error;
}
assert.ok(processFailure instanceof ClaudeCliProcessError);
assert.equal(processFailure.kind, "provider_terminated");
assert.equal(processFailure.retryable, true);
assert.match(processFailure.message, /上游模型在生成过程中终止/);
assert.doesNotMatch(processFailure.message, /"type"|"tools"|synthetic-project|22222222/);
assert.equal(failedProcessProgress.at(-1)?.type, "failed");
assert.doesNotMatch(failedProcessProgress.at(-1)?.detail ?? "", /"type"|"tools"|synthetic-project|22222222/);

const partialProgress = [];
const partialResult = await harness.run({
  projectId: kernel.project.projectId,
  projectRoot,
  agent,
  provider,
  model: "qwen-test",
  systemPrompt: "test",
  userPrompt: "PARTIAL_PROGRESS",
  authorization,
  expectedPaths: ["docs/design/harness-proof.md"],
  onProgress: (event) => partialProgress.push(event)
});
assert.equal(partialResult.terminationReason, "expected_outputs_materialized");
assert.deepEqual(partialResult.changedPaths, ["docs/design/harness-proof.md"]);
assert.match(partialResult.content, /工具写入已完成/);
assert.ok(partialProgress.some((event) => event.type === "tool_completed" && event.path === "docs/design/harness-proof.md"));

await assert.rejects(
  harness.run({
    projectId: kernel.project.projectId,
    projectRoot,
    agent,
    provider,
    model: "qwen-test",
    systemPrompt: "test",
    userPrompt: "HANG_NO_PROGRESS",
    authorization
  }),
  /首次工具写入前连续.*无输出进展/
);

const perRunTimeoutStartedAt = Date.now();
await assert.rejects(
  harness.run({
    projectId: kernel.project.projectId,
    projectRoot,
    agent,
    provider,
    model: "qwen-test",
    systemPrompt: "test",
    userPrompt: "HANG_NO_PROGRESS",
    authorization,
    requireToolProgress: false,
    timeoutMs: 100
  }),
  /执行超过/
);
assert.ok(Date.now() - perRunTimeoutStartedAt < 500, "per-run conversation timeout should override the task harness default");

const abortController = new AbortController();
const aborted = harness.run({
  projectId: kernel.project.projectId,
  projectRoot,
  agent,
  provider,
  model: "qwen-test",
  systemPrompt: "test",
  userPrompt: "ABORT_TEST",
  authorization,
  abortSignal: abortController.signal
});
setTimeout(() => abortController.abort(), 50);
await assert.rejects(aborted, /暂停或取消/);
assert.equal(existsSync(join(projectRoot, "docs/design/harness-proof.md")), true);

const artAgent = defaultAgentContracts.find((candidate) => candidate.agentId === "art_director");
assert.ok(artAgent);
const generatedAssetPath = "agents/art/generated-board.png";
kernel.addTask({
  taskId: "task_harness_media",
  projectId: kernel.project.projectId,
  stageId: "concept_discussion",
  roomId: kernel.getRoom("art-room").roomId,
  parentTaskId: undefined,
  taskLevel: "task",
  title: "生成真实美术板",
  description: "验证媒体 provenance 物化",
  ownerAgentId: artAgent.agentId,
  participantAgentIds: [],
  status: "doing",
  priority: 100,
  sortOrder: 2,
  progressPercent: 0,
  blockers: [],
  inputArtifacts: [],
  outputArtifacts: ["artifact_harness_media"],
  acceptanceCriteria: ["真实 PNG 与 provider provenance 均存在"],
  createdAt: now,
  updatedAt: now
});
kernel.upsertArtifact({
  artifactId: "artifact_harness_media",
  projectId: kernel.project.projectId,
  type: "asset",
  path: generatedAssetPath,
  ownerAgentId: artAgent.agentId,
  stageId: "concept_discussion",
  status: "draft",
  version: 1,
  sourceTaskId: "task_harness_media",
  sourceDecisionIds: [],
  metadata: {},
  createdAt: now,
  updatedAt: now
});
const mediaTask = kernel.findTask("task_harness_media");
assert.ok(mediaTask);
const mediaBefore = captureWorkspaceSnapshot(projectRoot);
mkdirSync(join(projectRoot, "agents/art"), { recursive: true });
const generatedPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
writeFileSync(join(projectRoot, generatedAssetPath), generatedPng);
const mediaAfter = captureWorkspaceSnapshot(projectRoot);
const generatedPngEvidence = mediaAfter.get(generatedAssetPath);
assert.ok(generatedPngEvidence);
const mediaEvidence = recordHarnessWorkspaceChanges(
  kernel,
  mediaTask,
  artAgent,
  mediaBefore,
  mediaAfter,
  "inv_media_evidence",
  [generatedAssetPath],
  [{
    toolName: "generate_raster_asset",
    path: generatedAssetPath,
    access: "write",
    status: "completed",
    operationId: "req_media_001",
    operationType: "image_generation",
    hash: generatedPngEvidence.hash,
    sizeBytes: generatedPngEvidence.sizeBytes,
    providerId: "dashscope",
    model: "wan2.7-image-pro",
    requestId: "req_media_001",
    promptHash: "a".repeat(64),
    negativePromptHash: "b".repeat(64),
    seed: 42,
    width: 1024,
    height: 1024,
    mime: "image/png",
    endpointFingerprint: "c".repeat(64),
    latencyMs: 1234
  }]
);
assert.deepEqual(mediaEvidence.violations, []);
assert.ok(mediaEvidence.toolExecutions.some((execution) => execution.toolName === "generate_raster_asset"));
const materializedMedia = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_harness_media");
assert.ok(materializedMedia);
assert.equal(materializedMedia.metadata.mediaProvider, "dashscope");
assert.equal(materializedMedia.metadata.mediaModel, "wan2.7-image-pro");
assert.equal(materializedMedia.metadata.mediaRequestId, "req_media_001");
assert.equal(materializedMedia.metadata.mediaPromptHash, "a".repeat(64));
assert.equal(materializedMedia.metadata.mediaSeed, 42);
assert.equal(materializedMedia.metadata.mediaWidth, 1024);
assert.equal(materializedMedia.metadata.mediaHeight, 1024);
assert.equal(materializedMedia.metadata.mediaReviewStatus, "pending_independent_review");

const mediaArtifactBeforeTamper = structuredClone(materializedMedia);
const mediaLedgerBeforeTamper = structuredClone(
  kernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_harness_media")
);
assert.ok(mediaLedgerBeforeTamper?.hash && mediaLedgerBeforeTamper.sizeBytes !== undefined);
const tamperedMediaBefore = captureWorkspaceSnapshot(projectRoot);
const generatedIntermediate = Buffer.concat([generatedPng, Buffer.from("generated-v2")]);
writeFileSync(join(projectRoot, generatedAssetPath), generatedIntermediate);
const generatedIntermediateEvidence = captureWorkspaceSnapshot(projectRoot).get(generatedAssetPath);
assert.ok(generatedIntermediateEvidence);
writeFileSync(
  join(projectRoot, generatedAssetPath),
  Buffer.concat([generatedIntermediate, Buffer.from("tampered-after-generation")])
);
const tamperedMediaAfter = captureWorkspaceSnapshot(projectRoot);
const tamperedFinalEvidence = tamperedMediaAfter.get(generatedAssetPath);
assert.ok(tamperedFinalEvidence);
const rejectedTamperedMedia = recordHarnessWorkspaceChanges(
  kernel,
  mediaTask,
  artAgent,
  tamperedMediaBefore,
  tamperedMediaAfter,
  "inv_media_tampered_after_generation",
  [generatedAssetPath],
  [{
    toolName: "generate_raster_asset",
    path: generatedAssetPath,
    access: "write",
    status: "completed",
    operationId: "req_media_tampered",
    operationType: "image_generation",
    hash: generatedIntermediateEvidence.hash,
    sizeBytes: generatedIntermediateEvidence.sizeBytes,
    providerId: "dashscope",
    model: "wan2.7-image-pro",
    requestId: "req_media_tampered",
    promptHash: "d".repeat(64),
    negativePromptHash: "e".repeat(64),
    seed: 43,
    width: 1024,
    height: 1024,
    mime: "image/png",
    endpointFingerprint: "f".repeat(64),
    latencyMs: 987
  }]
);
assert.deepEqual(rejectedTamperedMedia.changedPaths, [generatedAssetPath]);
assert.ok(rejectedTamperedMedia.violations.some((violation) => /生成收据与本轮最终文件不一致/.test(violation)));
assert.deepEqual(rejectedTamperedMedia.artifactIds, []);
assert.ok(rejectedTamperedMedia.toolExecutions.some((execution) =>
  execution.toolName === "generate_raster_asset" && execution.status === "failed"
));
assert.deepEqual(
  kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_harness_media"),
  mediaArtifactBeforeTamper,
  "post-generation byte tampering must not advance or restamp the artifact"
);
assert.deepEqual(
  kernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_harness_media"),
  mediaLedgerBeforeTamper,
  "post-generation byte tampering must not bind the final file to the verified ledger"
);
assert.notEqual(tamperedFinalEvidence.hash, mediaLedgerBeforeTamper.hash);
writeFileSync(join(projectRoot, generatedAssetPath), generatedPng);

const readOnlySnapshot = captureWorkspaceSnapshot(projectRoot);
const ignoredReadEvidence = recordHarnessWorkspaceChanges(
  kernel,
  mediaTask,
  artAgent,
  readOnlySnapshot,
  readOnlySnapshot,
  "inv_read_only_evidence",
  [generatedAssetPath],
  [{
    toolName: "inspect_visual_assets",
    path: generatedAssetPath,
    access: "read",
    status: "completed",
    operationId: "req_vision_read_only",
    operationType: "vision_review"
  }]
);
assert.deepEqual(ignoredReadEvidence.changedPaths, [], "read-only operations must never rematerialize an artifact version");
assert.deepEqual(ignoredReadEvidence.artifactIds, []);

const visualReviewer = defaultAgentContracts.find((candidate) => candidate.agentId === "visual_quality_reviewer");
assert.ok(visualReviewer);
const visualContract = getQualityReviewArtifactContracts().find(
  (candidate) => candidate.artifactId === "artifact_stage_1_visual_quality_review"
);
assert.ok(visualContract);
const visualReviewPath = visualContract.path;
const artBiblePath = "agents/art/art-bible.md";
const artBoardPath = "agents/art/art-direction-board.png";
const artBibleBytes = Buffer.from("# Art Bible\n\nReadable silhouette and palette rules.\n");
const artBoardBytes = readFileSync(join(projectRoot, generatedAssetPath));
mkdirSync(join(projectRoot, "agents/art"), { recursive: true });
writeFileSync(join(projectRoot, artBiblePath), artBibleBytes);
writeFileSync(join(projectRoot, artBoardPath), artBoardBytes);
kernel.addTask({
  taskId: "task_stage_1_art_direction",
  projectId: kernel.project.projectId,
  stageId: "concept_discussion",
  roomId: kernel.getRoom("art-room").roomId,
  parentTaskId: undefined,
  taskLevel: "task",
  title: "美术方向",
  description: "canonical visual review inputs",
  ownerAgentId: "art_director",
  participantAgentIds: [],
  status: "done",
  priority: 100,
  sortOrder: 2,
  progressPercent: 100,
  blockers: [],
  inputArtifacts: [],
  outputArtifacts: [...visualContract.subjectArtifactIds],
  acceptanceCriteria: [],
  createdAt: now,
  updatedAt: now
});
for (const input of [
  { artifactId: "artifact_art_bible_baseline_draft", type: "art_bible", path: artBiblePath, bytes: artBibleBytes },
  { artifactId: "artifact_art_direction_board", type: "asset", path: artBoardPath, bytes: artBoardBytes }
]) {
  kernel.upsertArtifact({
    artifactId: input.artifactId,
    projectId: kernel.project.projectId,
    type: input.type,
    path: input.path,
    ownerAgentId: "art_director",
    stageId: "concept_discussion",
    status: "submitted",
    version: 1,
    sourceTaskId: "task_stage_1_art_direction",
    sourceDecisionIds: [],
    metadata: { toolExecutedAt: now },
    createdAt: now,
    updatedAt: now
  });
  kernel.recordArtifactMaterialization(input.artifactId, {
    path: input.path,
    hash: createHash("sha256").update(input.bytes).digest("hex"),
    sizeBytes: input.bytes.byteLength,
    materializedAt: now
  });
}
kernel.addTask({
  taskId: visualContract.sourceTaskId,
  projectId: kernel.project.projectId,
  stageId: "concept_discussion",
  roomId: kernel.getRoom("art-room").roomId,
  parentTaskId: undefined,
  taskLevel: "task",
  title: "独立视觉审查",
  description: "验证审查 trace 与变更请求闭环",
  ownerAgentId: visualReviewer.agentId,
  participantAgentIds: [],
  status: "doing",
  priority: 100,
  sortOrder: 3,
  progressPercent: 0,
  blockers: [],
  inputArtifacts: [...visualContract.subjectArtifactIds],
  outputArtifacts: [visualContract.artifactId],
  acceptanceCriteria: ["审查收据绑定像素证据"],
  createdAt: now,
  updatedAt: now
});
kernel.upsertArtifact({
  artifactId: visualContract.artifactId,
  projectId: kernel.project.projectId,
  type: "quality_review",
  path: visualReviewPath,
  ownerAgentId: visualReviewer.agentId,
  stageId: "concept_discussion",
  status: "draft",
  version: 1,
  sourceTaskId: visualContract.sourceTaskId,
  sourceDecisionIds: [],
  metadata: {},
  createdAt: now,
  updatedAt: now
});
const visualReviewTask = kernel.findTask(visualContract.sourceTaskId);
const artInputArtifacts = visualContract.subjectArtifactIds.map((artifactId) => {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId);
  assert.ok(artifact && ledger?.hash && ledger.sizeBytes);
  return { artifact, ledger };
});
const boardLedger = artInputArtifacts.find(({ artifact }) => artifact.artifactId === "artifact_art_direction_board")?.ledger;
assert.ok(visualReviewTask && boardLedger?.hash && boardLedger.sizeBytes);
const visionCriteria = visualContract.rubric.criteria.map((criterion, index) => ({
  ...criterion,
  score: index === 0 ? 60 : 90,
  status: index === 0 ? "change_requested" : "pass",
  findings: [{
    issueCode: index === 0 ? "visual.readability.low" : `${criterion.criterionId}.observed`,
    severity: index === 0 ? "major" : "note",
    summary: index === 0
      ? "The focal silhouette is not readable at target size."
      : `Visible evidence supports ${criterion.label}.`,
    evidenceRefs: [`${artBoardPath}#pixel:full frame ${criterion.criterionId}`]
  }]
}));
const visionScore = visionCriteria.reduce(
  (total, criterion) => total + criterion.weight * criterion.score / 100,
  0
);
const visionSemanticResult = {
  schemaVersion: "1.0.0",
  rubricId: visualContract.rubric.rubricId,
  rubricVersion: visualContract.rubric.version,
  passThreshold: visualContract.rubric.passThreshold,
  criteria: visionCriteria,
  scoreTotal: visionScore,
  verdict: "change_requested"
};
const visionResponseHash = createHash("sha256").update("claude-harness-vision-response").digest("hex");
const authoritativeContext = buildVisionReviewAuthoritativeContext({
  contract: visualContract,
  artifacts: artInputArtifacts
    .filter(({ artifact }) => artifact.artifactId === "artifact_art_bible_baseline_draft")
    .map(({ artifact, ledger }) => ({
      artifactId: artifact.artifactId,
      version: artifact.version,
      path: artifact.path,
      hash: ledger.hash,
      sizeBytes: ledger.sizeBytes,
      buffer: readFileSync(join(projectRoot, artifact.path))
    })),
  readRuntimeAsset: (path) => readFileSync(join(projectRoot, path))
});
const requestSemanticHash = hashArtVisionRequestSemantics(visualContract.rubric, authoritativeContext.hash);
const visionReceipt = {
  invocationId: "inv_visual_review_evidence",
  operationId: "req_vision_001",
  providerId: "dashscope",
  model: "qwen3.8-max",
  paths: [artBoardPath],
  evidence: [{ path: artBoardPath, hash: boardLedger.hash, sizeBytes: boardLedger.sizeBytes }],
  responseHash: visionResponseHash,
  authoritativeContextEvidence: authoritativeContext.evidence,
  authoritativeContextHash: authoritativeContext.hash,
  requestSemanticHash,
  result: visionSemanticResult
};
const reviewBefore = captureWorkspaceSnapshot(projectRoot);
mkdirSync(join(projectRoot, "agents/review/art"), { recursive: true });
writeFileSync(join(projectRoot, visualReviewPath), `${JSON.stringify({
  schemaVersion: "1.0.0",
  kind: "artifact_quality_review",
  reviewId: "review.harness.visual.v1",
  domain: "art_direction",
  reviewerAgentId: "visual_quality_reviewer",
  targets: artInputArtifacts.map(({ artifact, ledger }) => ({
    artifactId: artifact.artifactId,
    version: artifact.version,
    path: artifact.path,
    ledgerHash: ledger.hash,
    sizeBytes: ledger.sizeBytes
  })),
  rubric: {
    rubricId: visualContract.rubric.rubricId,
    version: visualContract.rubric.version,
    passThreshold: visualContract.rubric.passThreshold
  },
  criteria: visionCriteria,
  scoreTotal: visionScore,
  verdict: "change_requested",
  requiredChanges: [{
    issueCode: "visual.readability.low",
    summary: "Strengthen the focal silhouette.",
    acceptanceCriteria: ["The focal form remains distinct at mobile target size."],
    evidenceRefs: [`${artBoardPath}#pixel:full frame visual_consistency`]
  }],
  risks: [],
  blockingIssueCodes: [],
  modelTrace: {
    providerId: "test-anthropic",
    model: "qwen-test",
    invocationId: "inv_visual_review_evidence",
    promptVersion: "1.0.0"
  },
  reviewedAt: "2026-08-15T12:00:00.000Z"
}, null, 2)}\n`);
const reviewAfter = captureWorkspaceSnapshot(projectRoot);
const reviewEvidence = recordHarnessWorkspaceChanges(
  kernel,
  visualReviewTask,
  visualReviewer,
  reviewBefore,
  reviewAfter,
  "inv_visual_review_evidence",
  [visualReviewPath],
  [{
    toolName: "write_artifact",
    path: visualReviewPath,
    access: "write",
    status: "completed",
    operationId: "req_vision_001",
    operationType: "quality_review_with_vision",
    providerId: "dashscope",
    model: "qwen3.8-max",
    inspectedPaths: [artBoardPath],
    inspectedEvidence: [{ path: artBoardPath, hash: boardLedger.hash, sizeBytes: boardLedger.sizeBytes }],
    visionResponseHash,
    visionSemanticHash: hashArtVisionSemanticResult(visionSemanticResult),
    visionSemanticResult,
    authoritativeContextEvidence: authoritativeContext.evidence,
    authoritativeContextHash: authoritativeContext.hash,
    requestSemanticHash,
    visionSemanticReceipts: [visionReceipt],
    recordedAt: "2026-08-15T12:00:01.000Z"
  }]
);
assert.deepEqual(reviewEvidence.violations, []);
const materializedReview = kernel.listArtifacts().find((artifact) => artifact.artifactId === visualContract.artifactId);
assert.equal(materializedReview?.metadata.reviewProviderId, "test-anthropic");
assert.equal(materializedReview?.metadata.reviewModel, "qwen-test");
assert.equal(materializedReview?.metadata.reviewInvocationId, "inv_visual_review_evidence");
assert.equal(materializedReview?.metadata.visionInspectionOperationId, "req_vision_001");
assert.equal(materializedReview?.metadata.visionInspectionResponseHash, visionResponseHash);
assert.equal(materializedReview?.metadata.visionAuthoritativeContextHash, authoritativeContext.hash);
assert.equal(materializedReview?.metadata.visionRequestSemanticHash, requestSemanticHash);
assert.deepEqual(materializedReview?.metadata.visionInspectedPaths, [artBoardPath]);
assert.deepEqual(materializedReview?.metadata.visionInspectedEvidence, [
  { path: artBoardPath, hash: boardLedger.hash, sizeBytes: boardLedger.sizeBytes }
]);
assert.equal(kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_art_direction_board")?.status, "change_requested");
assert.ok(kernel.listMessages().some((message) =>
  message.roomId === kernel.getRoom("art-room").roomId &&
  message.metadata.generatedBy === "quality_review_feedback" &&
  message.relatedArtifactIds.includes(visualContract.artifactId)
));

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write("Claude CLI Harness smoke passed: session resume, failed-write isolation, byte-bound media provenance, read-only isolation, quality feedback, timeout, cancellation\n");
