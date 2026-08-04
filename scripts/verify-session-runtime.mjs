import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-session-runtime-"));
const fakeClaude = join(tempRoot, "fake-claude.mjs");
process.env.GAME_PIPELINE_SECRET_ROOT = join(tempRoot, "secrets");
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "projects");
process.env.CLAUDE_CLI_PATH = fakeClaude;

writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9-runtime-test\\n");
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("ROOM_TIMEOUT_FALLBACK")) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
const counterPath = join(process.cwd(), ".be-the-producer", "runtime-test-count.txt");
mkdirSync(dirname(counterPath), { recursive: true });
const count = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
writeFileSync(counterPath, String(count));
if (args.includes("--resume")) {
  process.stderr.write("Session does not exist or cannot be resumed.\\n");
  process.exit(1);
}
const sessionId = count === 1
  ? "11111111-1111-4111-8111-111111111111"
  : "22222222-2222-4222-8222-222222222222";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "已从持久 Context Packet 恢复并回复制作人。", session_id: sessionId }) + "\\n");
`,
  "utf8"
);
chmodSync(fakeClaude, 0o755);

const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { ModelAgentRuntime } = await import("../apps/api/dist/modelAgentRuntime.js");
const { modelSettingsStore } = await import("../apps/api/dist/modelSettings.js");

modelSettingsStore.saveProvider("dashscope-anthropic-qwen", {
  baseUrl: "https://example.invalid/apps/anthropic",
  defaultModel: "qwen-runtime-test",
  apiKey: "test-only"
});
modelSettingsStore.saveAgentAssignment("game_designer", {
  harnessId: "claude-cli",
  providerId: "dashscope-anthropic-qwen",
  model: "qwen-runtime-test"
});

const kernel = createStudioKernel("runtime_recovery", "Runtime Recovery", "producer", "验证 Claude room session 自愈");
const room = kernel.getRoom("design-room");
const runtime = new ModelAgentRuntime();
const routePlan = {
  targets: [{ agentId: "game_designer", score: 100, reasons: ["runtime_test"], required: true }],
  orchestratorSummaryRequired: false
};

const firstProducerMessage = producerMessage(kernel.project.projectId, room.roomId, "msg_producer_first", "请策划说明当前机制。", 1);
kernel.recordMessage(firstProducerMessage);
const first = await runtime.respond(kernel, firstProducerMessage, routePlan);
assert.equal(first.agentMessages.length, 1);
assert.equal(first.agentMessages[0].metadata.failure, undefined);
let active = kernel.listAgentSessions().find((session) => session.scope === "room" && session.status === "active");
assert.ok(active);
assert.equal(active.sessionId, "11111111-1111-4111-8111-111111111111");
assert.equal(active.epoch, 0);

const secondProducerMessage = producerMessage(kernel.project.projectId, room.roomId, "msg_producer_second", "继续，结合刚才的讨论回答。", 2);
kernel.recordMessage(secondProducerMessage);
const second = await runtime.respond(kernel, secondProducerMessage, routePlan);
assert.equal(second.agentMessages.length, 1);
assert.equal(second.agentMessages[0].metadata.failure, undefined);
assert.equal(second.agentMessages[0].metadata.resumed, false);
assert.match(second.agentMessages[0].content, /持久 Context Packet/);

const sessions = kernel.listAgentSessions().filter((session) => session.scope === "room");
assert.equal(sessions.length, 2);
assert.equal(sessions.find((session) => session.epoch === 0)?.status, "sealed");
active = sessions.find((session) => session.epoch === 1);
assert.ok(active);
assert.equal(active.status, "active");
assert.equal(active.predecessorSessionKey, sessions.find((session) => session.epoch === 0)?.sessionKey);
assert.equal(active.sessionId, "22222222-2222-4222-8222-222222222222");
assert.equal(active.resumeFailureCount, 1);
assert.ok(kernel.listHandoffCapsules(active.sessionKey).some((capsule) => capsule.kind === "resume_recovery"));

const projectRoot = join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId);
assert.equal(readFileSync(join(projectRoot, ".be-the-producer", "runtime-test-count.txt"), "utf8"), "3");

const fallbackServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ content: [{ type: "text", text: "已通过直接 API 降级回复制作人。" }] }));
});
await new Promise((resolve) => fallbackServer.listen(0, "127.0.0.1", resolve));
const fallbackAddress = fallbackServer.address();
assert.ok(fallbackAddress && typeof fallbackAddress === "object");
modelSettingsStore.saveProvider("dashscope-anthropic-qwen", {
  baseUrl: `http://127.0.0.1:${fallbackAddress.port}/v1`,
  defaultModel: "qwen-runtime-test",
  apiKey: "test-only"
});
process.env.BTP_ROOM_HARNESS_TIMEOUT_MS = "100";

const thirdProducerMessage = producerMessage(kernel.project.projectId, room.roomId, "msg_producer_third", "ROOM_TIMEOUT_FALLBACK", 3);
kernel.recordMessage(thirdProducerMessage);
const third = await runtime.respond(kernel, thirdProducerMessage, routePlan);
assert.equal(third.agentMessages.length, 1);
assert.equal(third.agentMessages[0].metadata.failure, undefined);
assert.equal(third.agentMessages[0].metadata.harnessFallback, true);
assert.equal(third.agentMessages[0].metadata.executionPath, "direct_model_api_fallback");
assert.match(third.agentMessages[0].content, /直接 API 降级/);
await new Promise((resolve, reject) => fallbackServer.close((error) => error ? reject(error) : resolve()));

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write("Session runtime smoke passed: persisted room session, --resume recovery, bounded CLI timeout, direct API fallback\n");

function producerMessage(projectId, roomId, messageId, content, second) {
  return {
    messageId,
    projectId,
    roomId,
    senderType: "producer",
    senderId: "producer",
    messageType: "progress_update",
    content,
    mentions: ["game_designer"],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date(Date.UTC(2026, 6, 20, 1, 0, second)).toISOString()
  };
}
