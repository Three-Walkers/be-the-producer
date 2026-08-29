import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { createStudioKernel, defaultAgentContracts } = await import("@game-pipeline/agent-runtime");
const { buildProjectMemoryView } = await import("../apps/api/dist/projectMemoryView.js");
const { filterMemoryRecords, memoryRelation, summarizeAgentMemory } = await import(
  "../apps/api/public/memory-dashboard.js"
);

const kernel = createStudioKernel("memory_view_test", "Memory View", "producer", "验证 Agent 记忆可视化");
const projectId = kernel.project.projectId;
const now = "2026-08-29T08:00:00.000Z";

writeMemory({ memoryId: "mem_project", scope: "project", status: "active", type: "project_brief", content: "单局 60 秒。" });
writeMemory({ memoryId: "mem_decision", scope: "decision", status: "active", type: "core_loop", content: "采用点击防守。", ownerAgent: "producer" });
writeMemory({ memoryId: "mem_design_role", scope: "role", status: "active", type: "workspace_summary", content: "策划正在收敛数值。", ownerAgent: "game_designer" });
writeMemory({ memoryId: "mem_art_role", scope: "role", status: "active", type: "workspace_summary", content: "美术正在制作方向板。", ownerAgent: "art_director" });
writeMemory({ memoryId: "mem_design_draft", scope: "knowledge", status: "draft", type: "balance_note", content: "尚未确认的平衡草案。", ownerAgent: "game_designer" });
writeMemory({ memoryId: "mem_archived_qa", scope: "qa", status: "archived", type: "old_qa", content: "历史测试结论。" });

const designRoom = kernel.getRoom("design-room");
const cursor = { roomId: designRoom.roomId, deliveredMessageCount: 0, updatedAt: now };
kernel.upsertAgentSession({
  sessionKey: "session_game_designer_room",
  logicalSessionKey: "logical_game_designer_room",
  projectId,
  agentId: "game_designer",
  roomId: designRoom.roomId,
  scope: "room",
  harnessId: "direct-api",
  providerId: "test-provider",
  model: "test-model",
  epoch: 0,
  status: "active",
  cursor,
  contextTokensEstimate: 420,
  resumeFailureCount: 0,
  lastContextPacketId: "packet_game_designer_latest",
  incomingCapsuleIds: [],
  outgoingCapsuleIds: [],
  createdAt: now,
  updatedAt: now
});
kernel.recordContextPacket({
  packetId: "packet_game_designer_latest",
  projectId,
  sessionKey: "session_game_designer_room",
  agentId: "game_designer",
  roomId: designRoom.roomId,
  cursorBefore: cursor,
  cursorAfter: cursor,
  layers: [
    {
      kind: "durable_memory",
      title: "持久记忆与已确认事实",
      content: "单局 60 秒。",
      sourceRefs: ["mem_project"],
      truncated: false
    }
  ],
  health: {
    status: "healthy",
    score: 100,
    estimatedTokens: 420,
    budgetTokens: 8_000,
    deltaMessageCount: 0,
    omittedMessageCount: 0,
    staleCursor: false,
    reasons: [],
    checkedAt: now
  },
  createdAt: now
});

const view = buildProjectMemoryView(kernel);
assert.equal(view.records.length, 6, "memory view must include every status, including archived records");
assert.equal(view.memory, view.records, "the original memory response field must remain available");
assert.equal(view.summary.active, 4);
assert.equal(view.summary.byStatus.archived, 1);
assert.equal(view.agents.length, defaultAgentContracts.length, "every registered agent needs an explicit memory view");
assert.match(view.architecture.search, /not enabled/, "the API must not claim vector retrieval exists in the local runtime");

const designer = view.agents.find((agent) => agent.agentId === "game_designer");
const artDirector = view.agents.find((agent) => agent.agentId === "art_director");
assert.ok(designer);
assert.ok(artDirector);
assert.deepEqual(new Set(designer.injectedMemoryIds), new Set(["mem_project", "mem_decision", "mem_design_role"]));
assert.ok(!designer.injectedMemoryIds.includes("mem_design_draft"), "draft owner memory must not be injected");
assert.ok(!designer.injectedMemoryIds.includes("mem_art_role"), "another role's private memory must not be injected");
assert.deepEqual(new Set(artDirector.injectedMemoryIds), new Set(["mem_project", "mem_decision", "mem_art_role"]));
assert.ok(designer.ownedMemoryIds.includes("mem_design_draft"), "owned and injected are intentionally different relations");
assert.equal(designer.context.sessionMemory.sessionCount, 1);
assert.equal(designer.context.sessionMemory.activeSessionCount, 1);
assert.equal(designer.context.sessionMemory.contextPacketCount, 1);
assert.equal(designer.context.sessionMemory.latestSession?.contextTokensEstimate, 420);
assert.equal(designer.context.sessionMemory.latestPacket?.layers[0]?.kind, "durable_memory");
assert.equal(artDirector.context.sessionMemory.sessionCount, 0, "agents without sessions must still have an explicit zero-state view");

const projectRecord = view.records.find((record) => record.memoryId === "mem_project");
const designDraft = view.records.find((record) => record.memoryId === "mem_design_draft");
assert.ok(projectRecord);
assert.ok(designDraft);
assert.deepEqual(memoryRelation(projectRecord, designer), {
  owned: false,
  injected: true,
  readable: true,
  historical: false
});
assert.deepEqual(memoryRelation(designDraft, designer), {
  owned: true,
  injected: false,
  readable: false,
  historical: true
});
assert.deepEqual(
  filterMemoryRecords(view, { agentId: designer.agentId, relation: "injected", scope: "all", status: "all" }).map(
    (record) => record.memoryId
  ),
  ["mem_project", "mem_decision", "mem_design_role"],
  "the UI injected filter must match the runtime memory-pack rule"
);
assert.deepEqual(
  filterMemoryRecords(view, { agentId: designer.agentId, relation: "all", query: "平衡", scope: "all", status: "all" }).map(
    (record) => record.memoryId
  ),
  ["mem_design_draft"]
);
assert.deepEqual(summarizeAgentMemory(designer, view.records), {
  owned: 2,
  injected: 3,
  readable: 3,
  historical: 1
});

const [html, app, css, server] = await Promise.all([
  readFile(new URL("../apps/api/public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../apps/api/public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../apps/api/public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../apps/api/src/server.ts", import.meta.url), "utf8")
]);
for (const marker of ["memory-dialog", "memory-agent-list", "memory-feed", "memory-inspector", "memory-relation-filter"]) {
  assert.match(html, new RegExp(`id=["']${marker}["']`), `dashboard markup must include #${marker}`);
}
assert.match(app, /\/projects\/\$\{projectId\}\/memory/, "dashboard must load the current project's memory view");
assert.match(css, /\.memory-layout\s*\{/, "memory dashboard must define a visual master-detail layout");
assert.match(css, /@media \(max-width: 780px\)/, "memory dashboard must retain the existing mobile breakpoint");
assert.match(server, /memory-dashboard\.js/, "the memory dashboard module must be available through the static boundary");

console.log("Agent memory view and dashboard verification passed");

function writeMemory(input) {
  kernel.writeMemory({
    projectId,
    createdAt: now,
    updatedAt: now,
    ...input
  });
}
