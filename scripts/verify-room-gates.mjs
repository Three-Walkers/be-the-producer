import assert from "node:assert/strict";
import {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  LocalAgentRuntime
} from "../packages/agent-runtime/dist/index.js";

const kernel = createStudioKernel("game_room_gate_test", "Room gate test", "producer_test", "test idea");
const designRoom = kernel.getRoom("design-room");
assert.ok(designRoom.participants.includes("game_designer"));

const removed = kernel.updateRoomParticipant("design-room", "game_designer", "remove");
assert.equal(removed.changed, true);
assert.ok(!removed.room.participants.includes("game_designer"));

const removedRoute = kernel.postMessage(producerMessage(kernel, designRoom.roomId, "@策划 请回复", ["game_designer"]));
assert.ok(!removedRoute.targets.some((target) => target.agentId === "game_designer"));

const invited = kernel.updateRoomParticipant("design-room", "game_designer", "invite");
assert.equal(invited.changed, true);
const invitedRoute = kernel.postMessage(producerMessage(kernel, designRoom.roomId, "@策划 请回复", ["game_designer"]));
assert.ok(invitedRoute.targets.some((target) => target.agentId === "game_designer"));

const restored = createStudioKernelFromSnapshot(kernel.toSnapshot());
assert.ok(restored.getRoom("design-room").participants.includes("game_designer"));

const gateKernel = createStudioKernel("game_gate_test", "Gate test", "producer_test", "test idea");
const runtime = new LocalAgentRuntime();
const first = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "发起立项阶段的门禁评审"),
  { scriptedReplies: false }
);
assert.ok(first.agentMessages.some((message) => message.content.includes("二次确认口令：执行确认：确认立项")));

const second = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "确认"),
  { scriptedReplies: false }
);
assert.ok(second.agentMessages.some((message) => message.messageType === "blocker" && message.content.includes("缺少已验证产物证据")));
assert.ok(!second.agentMessages.some((message) => message.content.includes("二次确认口令：执行确认：确认立项")));

console.log("Room membership and natural-language gate smoke passed");

function producerMessage(targetKernel, roomId, content, mentions = []) {
  return {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: targetKernel.project.projectId,
    roomId,
    senderType: "producer",
    senderId: targetKernel.project.producerId,
    messageType: "plan_submission",
    content,
    mentions,
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}
