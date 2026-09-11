import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "btp-activity-checkpoint-"));
process.env.STUDIO_WORKSPACE_ROOT = join(root, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(root, "state");
const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { AgentLoopService } = await import("../apps/api/dist/agentLoop.js");
const { AgentActivityReporter } = await import("../apps/api/dist/agentActivity.js");
const { StudioProjectStore } = await import("../apps/api/dist/store.js");
try {
  const kernel = createStudioKernel("activity_loop", "Activity", "producer_test", "ephemeral telemetry");
  kernel.updateProject({ executionStatus: "running" });
  const now = new Date().toISOString();
  kernel.addTask({ taskId: "task_activity", projectId: kernel.project.projectId, stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("design-room").roomId, taskLevel: "task", title: "Activity", description: "Activity",
    ownerAgentId: "game_designer", participantAgentIds: [], status: "doing", priority: 100, sortOrder: 1,
    blockers: [], inputArtifacts: [], outputArtifacts: [], acceptanceCriteria: ["No checkpoint storm"], createdAt: now, updatedAt: now });
  let saves = 0;
  const loop = new AgentLoopService({ getKernel: () => kernel, checkpoint: () => { saves++; },
    modelRuntime: { async respondToTask(current, task, input) {
      const before = saves;
      const reporter = new AgentActivityReporter(current, { roomId: task.roomId, agentId: task.ownerAgentId,
        kind: "task_execution", taskId: task.taskId, onChange: input.onAgentActivity });
      for (let i = 0; i < 200; i++) reporter.onHarnessProgress({ type: "model_output", invocationId: "test", createdAt: now });
      assert.equal(saves, before, "model deltas must not run durable evidence reconciliation");
      assert.equal(current.listAgentActivities()[0].label, "模型正在分析并执行", "live UI still sees telemetry");
      return { messageId: "msg_activity", projectId: current.project.projectId, roomId: task.roomId,
        senderType: "agent", senderId: task.ownerAgentId, messageType: "blocker", content: "External fixture dependency",
        mentions: [], relatedTaskIds: [task.taskId], relatedArtifactIds: [],
        metadata: { loopControl: { status: "blocked", reason: "External fixture dependency", handoffAgentIds: [] } }, createdAt: now };
    } } });
  loop.start(kernel.project.projectId, { reason: "activity checkpoint test" });
  const deadline = Date.now() + 2000;
  while (kernel.getAgentLoopState().status === "running" && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(kernel.getAgentLoopState().status, "blocked");
  assert.ok(saves >= 3 && saves < 10, "start, task completion and settlement remain durable");
  loop.pause(kernel.project.projectId);

  const roomKernel = createStudioKernel("activity_room", "Room", "producer_test", "durable producer input");
  roomKernel.updateProject({ executionStatus: "paused" });
  let saved;
  const store = new StudioProjectStore({ persistence: {
    loadAll: () => [roomKernel], load: () => roomKernel,
    listSummaries: () => assert.fail("sidebar polling must not reload full disk histories"), delete: () => {},
    save: (current) => { saved = structuredClone(current.toSnapshot()); return saved; }
  }, modelRuntime: { async respond(current, message, route, options) {
    assert.ok(saved.messages.some(m => m.messageId === message.messageId), "producer intent must be durable BEFORE the model request");
    assert.equal(options.onAgentActivity, undefined, "room activity does not trigger full checkpoints");
    current.updateProject({ executionStatus: "paused" }); // Do not dispatch fixture role workers.
    return { agentMessages: [] };
  } } });
  roomKernel.updateProject({ executionStatus: "running" });
  await store.handleProducerInput(roomKernel.project.projectId, { content: "@策划 说明当前玩法风险", messageType: "plan_submission" },
    { modelReplies: true, scriptedReplies: false, bootstrapProjectState: false, protocolFlows: false });
  const savedAt = saved.savedAt;
  for (let i = 0; i < 100; i++) {
    const summary = store.listProjects()[0];
    assert.equal(summary.projectId, roomKernel.project.projectId);
    assert.equal(summary.executionStatus, "paused");
    assert.equal(summary.savedAt, savedAt);
    summary.name = "caller mutation must not alter cached summary";
  }
  assert.equal(store.listProjects()[0].name, "Room");
  const created = store.createProject({ name: "Second project" });
  assert.equal(store.listProjects().length, 2);
  store.deleteProject(created.project.projectId);
  assert.equal(store.listProjects().length, 1, "deleted projects leave the summary projection too");
  console.log("Activity checkpoints passed: 200 model deltas, live UI state, durable producer input and lifecycle boundaries.");
} finally { rmSync(root, { recursive: true, force: true }); }
