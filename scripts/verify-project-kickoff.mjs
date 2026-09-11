import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "btp-kickoff-test-"));
process.env.GAME_PIPELINE_DATA_ROOT = join(root, "state");
process.env.STUDIO_WORKSPACE_ROOT = join(root, "workspaces");
process.env.GAME_PIPELINE_SECRET_ROOT = join(root, "secrets");
const { StudioProjectStore } = await import("../apps/api/dist/store.js");
let calls = 0;
const modelRuntime = {
  async respond(kernel, message, routePlan, callbacks) {
    calls++;
    assert.ok(kernel.findTask("task_stage_1_design_clarification"), "tasks exist before model clarification");
    assert.ok(routePlan.targets.some((target) => target.agentId === "game_designer"));
    const reply = {
      ...message, messageId: `kickoff_reply_${calls}`, senderType: "agent", senderId: "game_designer",
      messageType: "question", content: "请确认首关目标时长。", mentions: []
    };
    kernel.recordMessage(reply);
    await callbacks.onAgentMessage(reply);
    return { agentMessages: [reply] };
  },
  async executeTask() { throw new Error("clarification must wait for producer input"); }
};
try {
  const store = new StudioProjectStore({ modelRuntime });
  const created = store.createProject({ name: "Kickoff", idea: "塔防玩法和美术需通过验证，不需要上线；未确认门禁不推进。" });
  const started = await store.startProject(created.project.projectId);
  assert.equal(calls, 1, "startup must actually ask configured agents, not silently wait for unasked questions");
  assert.ok(started.agentMessages.some((message) => message.senderId === "game_designer"));
  assert.ok(!started.agentMessages.some((message) => message.content.includes("门禁评审")));
  assert.equal(started.project.currentStage, "concept_discussion");
  const changed = await store.postProducerMessage(created.project.projectId, {
    roomKind: "design-room", content: "@策划 修改首关节奏，保持其余范围。", messageType: "change_request"
  });
  assert.equal(calls, 1, "an explicit change starts work without a redundant model conversation");
  assert.ok(changed.agentMessages.some((message) => message.metadata.generatedBy === "producer_change_request"));
  assert.equal(store.getKernel(created.project.projectId).findTask("task_stage_1_design_clarification").status, "doing");
  store.pauseProject(created.project.projectId);
  // Allow the cancelled loop's queued microtask to observe cancellation before removing its fixture.
  await new Promise((resolve) => setImmediate(resolve));
  console.log("Project kickoff regression passed: model clarification delivered, no accidental gate.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
