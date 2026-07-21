import assert from "node:assert/strict";

const { createStudioKernel, createStudioKernelFromSnapshot, defaultAgentContracts } = await import("@game-pipeline/agent-runtime");
const { SessionCoordinator } = await import("../apps/api/dist/sessionCoordinator.js");

const coordinator = new SessionCoordinator();
const kernel = createStudioKernel("session_context_test", "Session Context Test", "producer", "验证持久会话与分层上下文");
const agent = defaultAgentContracts.find((candidate) => candidate.agentId === "game_designer");
const targetAgent = defaultAgentContracts.find((candidate) => candidate.agentId === "art_director");
assert.ok(agent);
assert.ok(targetAgent);
const room = kernel.getRoom("design-room");
const identity = { providerId: "test-provider", model: "test-model", harnessId: "claude-cli" };

for (let index = 0; index < 12; index += 1) {
  kernel.recordMessage(message(kernel.project.projectId, room.roomId, `msg_${index}`, index));
}

let roomSession = coordinator.getOrCreateRoomSession(kernel, agent, room.roomId, identity);
let prepared = coordinator.prepareContext(kernel, roomSession, agent, room.roomId, undefined, "msg_11");
const firstDelta = layer(prepared.context.packet, "room_delta");
assert.equal(prepared.context.packet.health.deltaMessageCount, 12);
assert.match(firstDelta.content, /msg_0/);
assert.match(firstDelta.content, /msg_11/);
roomSession = coordinator.commitSuccess(kernel, prepared.session, prepared.context.packet, {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  invocationId: "inv_room_first",
  outputText: "first room response"
});

kernel.recordMessage(message(kernel.project.projectId, room.roomId, "msg_12", 12));
kernel.recordMessage(message(kernel.project.projectId, room.roomId, "msg_13", 13));
prepared = coordinator.prepareContext(kernel, roomSession, agent, room.roomId, undefined, "msg_13");
const secondDelta = layer(prepared.context.packet, "room_delta");
assert.equal(prepared.context.packet.health.deltaMessageCount, 2);
assert.doesNotMatch(secondDelta.content, /msg_7\b/);
assert.match(secondDelta.content, /msg_12/);
assert.match(secondDelta.content, /msg_13/);
roomSession = coordinator.commitSuccess(kernel, prepared.session, prepared.context.packet, {
  sessionId: roomSession.sessionId,
  invocationId: "inv_room_second",
  outputText: "second room response"
});
assert.equal(roomSession.cursor.lastMessageId, "msg_13");

const previousRoomSession = roomSession;
roomSession = coordinator.getOrCreateRoomSession(kernel, agent, room.roomId, {
  providerId: "new-provider",
  model: "new-model",
  harnessId: "claude-cli"
});
assert.equal(previousRoomSession.status, "active");
assert.equal(kernel.findAgentSession(previousRoomSession.sessionKey)?.status, "sealed");
assert.equal(roomSession.epoch, 1);
assert.equal(roomSession.providerId, "new-provider");
assert.equal(roomSession.model, "new-model");
assert.equal(roomSession.sessionId, undefined);
identity.providerId = "new-provider";
identity.model = "new-model";

const now = new Date().toISOString();
kernel.addTask({
  taskId: "task_child_test",
  projectId: kernel.project.projectId,
  stageId: kernel.project.currentStage,
  roomId: room.roomId,
  taskLevel: "task",
  title: "独立 child session 任务",
  description: "验证父子会话与回流协议",
  ownerAgentId: agent.agentId,
  participantAgentIds: [targetAgent.agentId],
  status: "doing",
  priority: 100,
  sortOrder: 1,
  progressPercent: 10,
  blockers: [],
  inputArtifacts: [],
  outputArtifacts: [],
  acceptanceCriteria: ["回流胶囊可追溯"],
  createdAt: now,
  updatedAt: now
});
const task = kernel.findTask("task_child_test");
assert.ok(task);
let child = coordinator.getOrCreateTaskChildSession(kernel, task, agent, room.roomId, identity);
assert.equal(child.scope, "task_child");
assert.equal(child.parentSessionKey, roomSession.sessionKey);
assert.ok(kernel.listHandoffCapsules(child.sessionKey).some((capsule) => capsule.kind === "parent_to_child"));

let concurrent = 0;
let maxConcurrent = 0;
await Promise.all([
  coordinator.runExclusive(kernel, child, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(40);
    concurrent -= 1;
  }),
  coordinator.runExclusive(kernel, child, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(10);
    concurrent -= 1;
  })
]);
assert.equal(maxConcurrent, 1);

child = kernel.upsertAgentSession({
  ...child,
  sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  contextTokensEstimate: 70_000,
  updatedAt: new Date().toISOString()
});
const rotated = coordinator.prepareContext(kernel, child, agent, room.roomId, task, "msg_13").session;
assert.equal(rotated.epoch, 1);
assert.equal(rotated.predecessorSessionKey, child.sessionKey);
assert.equal(rotated.parentSessionKey, child.parentSessionKey);
assert.equal(kernel.findAgentSession(child.sessionKey)?.status, "sealed");
assert.ok(kernel.listHandoffCapsules(rotated.sessionKey).some((capsule) => capsule.kind === "resume_recovery"));

const recovered = coordinator.recoverResumeFailure(kernel, {
  ...rotated,
  sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}, "test resume failure");
assert.equal(recovered.epoch, 2);
assert.equal(recovered.resumeFailureCount, 1);
assert.equal(recovered.sessionId, undefined);
assert.equal(kernel.findAgentSession(rotated.sessionKey)?.status, "sealed");

const childMessage = message(kernel.project.projectId, room.roomId, "msg_child_result", 14, "agent", agent.agentId);
const returned = coordinator.returnChildToParent(kernel, recovered, {
  summary: "child 已形成可回流结果",
  message: childMessage,
  changedPaths: ["docs/design/child-result.md"]
});
assert.ok(returned);
assert.equal(returned.kind, "child_to_parent");
assert.ok(returned.targetSessionKeys.includes(roomSession.sessionKey));

const handoff = coordinator.handoffToAgents(
  kernel,
  recovered,
  [targetAgent],
  () => identity,
  { summary: "交由美术继续", message: childMessage, changedPaths: ["docs/design/child-result.md"] }
);
assert.ok(handoff);
assert.equal(handoff.kind, "agent_handoff");
assert.deepEqual(handoff.targetAgentIds, [targetAgent.agentId]);
const targetSession = kernel.findAgentSession(handoff.targetSessionKeys[0]);
assert.ok(targetSession);
assert.equal(targetSession.roomId, kernel.getRoom(targetAgent.roomMemberships[0]).roomId);

coordinator.sealCompletedChild(kernel, recovered, "测试完成");
assert.equal(kernel.findAgentSession(recovered.sessionKey)?.status, "sealed");
assert.equal(kernel.findAgentSession(recovered.sessionKey)?.outgoingCapsuleIds.length, 2);
const reactivated = coordinator.getOrCreateTaskChildSession(kernel, task, agent, room.roomId, identity);
assert.equal(reactivated.epoch, 3);
assert.equal(reactivated.predecessorSessionKey, recovered.sessionKey);
assert.notEqual(reactivated.sessionKey, child.sessionKey);

const snapshot = kernel.toSnapshot();
const restored = createStudioKernelFromSnapshot(JSON.parse(JSON.stringify(snapshot)));
assert.equal(restored.listAgentSessions().length, kernel.listAgentSessions().length);
assert.equal(restored.listContextPackets().length, kernel.listContextPackets().length);
assert.equal(restored.listHandoffCapsules().length, kernel.listHandoffCapsules().length);
assert.equal(restored.findAgentSession(recovered.sessionKey)?.predecessorSessionKey, recovered.predecessorSessionKey);

process.stdout.write("Session context smoke passed: cursor packets, persistent resume records, mutex, health rotation, recovery, child return, handoff, restart persistence\n");

function message(projectId, roomId, messageId, index, senderType = "producer", senderId = "producer") {
  return {
    messageId,
    projectId,
    roomId,
    senderType,
    senderId,
    messageType: "progress_update",
    content: `消息 ${index}：用于验证房间级游标，不允许退化为固定最后 8 条。`,
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString()
  };
}

function layer(packet, kind) {
  const found = packet.layers.find((candidate) => candidate.kind === kind);
  assert.ok(found, `missing context layer: ${kind}`);
  return found;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
