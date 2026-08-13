import assert from "node:assert/strict";
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
if (prompt.includes("RESUME_FAIL") && args.includes("--resume")) {
  process.stderr.write("Session does not exist or can no longer be resumed.\\n");
  process.exit(1);
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

const { ClaudeCliHarness, ClaudeSessionResumeError } = await import("../apps/api/dist/claudeCliHarness.js");
const { captureWorkspaceSnapshot, recordHarnessWorkspaceChanges } = await import("../apps/api/dist/harnessWorkspaceEvidence.js");
const { createStudioKernel, defaultAgentContracts } = await import("@game-pipeline/agent-runtime");
const { createTaskHarnessAuthorization } = await import("../apps/api/dist/toolAuthorization.js");

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

await harness.run({
  projectId: kernel.project.projectId,
  projectRoot,
  agent,
  provider,
  model: "qwen-test",
  systemPrompt: "test",
  userPrompt: "resume the proof",
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
const mcpConfigArg = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
assert.equal(mcpConfigArg.mcpServers.btp_workspace.env.BTP_TOOL_MODE, "task");
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
  /没有产生工具写入/
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

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write("Claude CLI Harness smoke passed: session resume, per-run timeout, partial progress recovery, isolated evidence ledger, cancellation\n");
