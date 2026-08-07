import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-concurrent-room-"));
const fakeClaude = join(tempRoot, "fake-claude.mjs");
process.env.GAME_PIPELINE_SECRET_ROOT = join(tempRoot, "secrets");
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "projects");
process.env.CLAUDE_CLI_PATH = fakeClaude;
process.env.BTP_ROOM_HARNESS_TIMEOUT_MS = "3000";
process.env.BTP_ROOM_HARNESS_IDLE_TIMEOUT_MS = "2000";

writeFileSync(fakeClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9-concurrency-test\\n");
  process.exit(0);
}
for await (const _chunk of process.stdin) {}
const isArt = process.env.CLAUDE_CONFIG_DIR?.includes("art_director");
await new Promise((resolve) => setTimeout(resolve, isArt ? 450 : 40));
const sessionId = isArt
  ? "22222222-2222-4222-8222-222222222222"
  : "11111111-1111-4111-8111-111111111111";
const content = isArt ? "美术回复完成。" : "策划回复完成。";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: content, session_id: sessionId }) + "\\n");
`, "utf8");
chmodSync(fakeClaude, 0o755);

const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { ModelAgentRuntime } = await import("../apps/api/dist/modelAgentRuntime.js");
const { finalizeMessageActivity } = await import("../apps/api/dist/agentActivity.js");
const { modelSettingsStore } = await import("../apps/api/dist/modelSettings.js");

modelSettingsStore.saveProvider("dashscope-anthropic-qwen", {
  baseUrl: "https://example.invalid/apps/anthropic",
  defaultModel: "qwen3.7-plus",
  apiKey: "shared-test-key"
});
for (const agentId of ["game_designer", "art_director"]) {
  modelSettingsStore.saveAgentAssignment(agentId, {
    harnessId: "claude-cli",
    providerId: "dashscope-anthropic-qwen",
    model: "qwen3.7-plus"
  });
}

const kernel = createStudioKernel("concurrent_room", "Concurrent Room", "producer", "验证并发回复即时落盘");
const room = kernel.getRoom("studio-main");
const producerMessage = {
  messageId: "msg_producer_concurrent",
  projectId: kernel.project.projectId,
  roomId: room.roomId,
  senderType: "producer",
  senderId: "producer",
  messageType: "progress_update",
  content: "请策划和美术分别回复。",
  mentions: ["game_designer", "art_director"],
  relatedTaskIds: [],
  relatedArtifactIds: [],
  metadata: {},
  createdAt: new Date().toISOString()
};
kernel.recordMessage(producerMessage);

const callbacks = [];
let activityCheckpointCount = 0;
let resolveFirst;
const firstMessage = new Promise((resolve) => { resolveFirst = resolve; });
let allResolved = false;
const pending = new ModelAgentRuntime().respond(kernel, producerMessage, {
  targets: [
    { agentId: "game_designer", score: 100, reasons: ["test"], required: true },
    { agentId: "art_director", score: 100, reasons: ["test"], required: true }
  ],
  orchestratorSummaryRequired: false
}, {
  onAgentActivity: () => {
    activityCheckpointCount += 1;
  },
  onAgentMessage: (message) => {
    callbacks.push(message.senderId);
    resolveFirst?.(message);
    resolveFirst = undefined;
  }
}).finally(() => {
  allResolved = true;
});

const first = await Promise.race([
  firstMessage,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Fast Agent reply was not persisted promptly")), 3_000))
]);
assert.equal(first.senderId, "game_designer");
assert.equal(allResolved, false, "fast Agent must be observable before the slow Agent completes");
assert.ok(kernel.listMessages(room.roomId).some((message) => message.senderId === "game_designer"));
assert.equal(kernel.listAgentActivities(room.roomId).length, 2, "both in-flight Agent activities remain observable");

const result = await pending;
assert.deepEqual(callbacks, ["game_designer", "art_director"]);
assert.deepEqual(result.agentMessages.map((message) => message.senderId), ["game_designer", "art_director"]);
assert.equal(result.agentMessages.every((message) => message.metadata.failure !== true), true);
assert.equal(activityCheckpointCount > 0, true);
assert.equal(result.agentMessages.every((message) => Array.isArray(message.metadata.activityTimeline)), true);
for (const message of result.agentMessages) finalizeMessageActivity(kernel, message);
assert.equal(kernel.listAgentActivities(room.roomId).length, 0);

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write("Concurrent room reply smoke passed: shared key runs in parallel and fast Agent persists before slow Agent\n");
