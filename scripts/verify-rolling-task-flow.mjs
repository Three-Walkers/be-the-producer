import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "btp-rolling-flow-"));
process.env.STUDIO_WORKSPACE_ROOT = join(root, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(root, "state");
const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { AgentLoopService } = await import("../apps/api/dist/agentLoop.js");
const { applyProducerChangeRequest, producerChangeTargets } = await import("../apps/api/dist/producerChangeRequest.js");
const { syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");
const kernel = createStudioKernel("rolling_flow", "Rolling Flow", "producer_test", "rolling DAG test");
kernel.updateProject({ executionStatus: "running" });
function add(id, owner, path, inputs = [], target = kernel) {
  const now = new Date().toISOString();
  target.addTask({ taskId: id, projectId: target.project.projectId, stageId: target.project.currentStage,
    roomId: target.getRoom("studio-main").roomId, taskLevel: "task", title: id, description: id,
    ownerAgentId: owner, participantAgentIds: [], status: "doing", priority: 100, sortOrder: kernel.listTasks().length,
    progressPercent: 0, blockers: [], inputArtifacts: inputs, outputArtifacts: [`out_${id}`],
    acceptanceCriteria: ["Real tool-written Markdown"], createdAt: now, updatedAt: now });
  target.addArtifact({ artifactId: `out_${id}`, projectId: target.project.projectId, type: "gdd", path,
    ownerAgentId: owner, stageId: target.project.currentStage, status: "draft", version: 1,
    sourceTaskId: id, sourceDecisionIds: [], metadata: {}, createdAt: now, updatedAt: now });
}
add("slow", "game_designer", "agents/design/slow.md");
add("fast", "art_director", "agents/art/fast.md");
add("follow", "cocos_tech_lead", "agents/engineering/follow.md", ["out_fast"]);
add("same_owner", "game_designer", "agents/design/second.md");
let releaseSlow;
const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
const activeOwners = new Set();
let downstreamBeforeSlow = false;
let slowFinished = false;
const calls = [];
const service = new AgentLoopService({ getKernel: () => kernel, checkpoint: syncProjectWorkspace,
  modelRuntime: { async respondToTask(current, task) {
    assert.ok(!activeOwners.has(task.ownerAgentId), "same role must never run two tasks concurrently");
    activeOwners.add(task.ownerAgentId);
    calls.push(task.taskId);
    if (task.taskId === "slow") { await slowGate; slowFinished = true; }
    if (task.taskId === "follow") { downstreamBeforeSlow = !slowFinished; releaseSlow(); }
    activeOwners.delete(task.ownerAgentId);
    const artifact = current.listArtifacts().find((entry) => entry.artifactId === task.outputArtifacts[0]);
    return { messageId: `reply_${task.taskId}`, projectId: current.project.projectId, roomId: task.roomId,
      senderType: "agent", senderId: task.ownerAgentId, messageType: "progress_update", mentions: [],
      relatedTaskIds: [task.taskId], relatedArtifactIds: [], metadata: {}, createdAt: new Date().toISOString(),
      content: "```json\n" + JSON.stringify({ loopControl: { status: "ready_for_review", reason: "Fixture output ready", handoffAgentIds: [] },
        toolRequests: [{ tool: "write_artifact", taskId: task.taskId, artifactId: artifact.artifactId,
          artifactType: artifact.type, path: artifact.path, content: `# ${task.taskId}\n\nVerified fixture output.\n` }] }) + "\n```" };
  } }
});
try {
  service.start(kernel.project.projectId, { reason: "rolling test" });
  const deadline = Date.now() + 4_000;
  while (kernel.getAgentLoopState().status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(downstreamBeforeSlow, true, `fast branch must launch its dependent task before unrelated slow work finishes: ${JSON.stringify({calls, tasks:kernel.listTasks().map(t=>({id:t.taskId,status:t.status,blockers:t.blockers})),operations:kernel.toSnapshot().artifactOperations})}`);
  assert.equal(calls.length, 4);
  assert.ok(kernel.listTasks().every((task) => task.status === "review"));

  const change = { messageId: "producer_change_1", projectId: kernel.project.projectId,
    roomId: kernel.getRoom("studio-main").roomId, senderType: "producer", senderId: "producer_test",
    messageType: "change_request", content: "@美术 修订布局", mentions: ["art_director"], relatedTaskIds: [],
    relatedArtifactIds: [], metadata: {}, createdAt: new Date().toISOString() };
  assert.deepEqual(producerChangeTargets(kernel, { ...change, messageType: "progress_update" }), [], "progress questions never reopen work");
  assert.deepEqual(producerChangeTargets(kernel, { ...change, mentions: [] }), [], "unaddressed free text must not roll back arbitrary roles");
  assert.deepEqual(producerChangeTargets(kernel, { ...change, content: "@QA 只重试 [task:follow]" }).map((task) => task.taskId), ["follow"], "explicit task scope takes precedence over role mentions");
  assert.deepEqual(producerChangeTargets(kernel, { ...change, relatedTaskIds: ["follow"] }).map((task) => task.taskId), ["follow"]);
  assert.deepEqual(producerChangeTargets(kernel, { ...change, content: "@QA 重试 [task:unknown_task]" }), [], "unknown explicit task must not broaden to all role work");
  kernel.recordMessage(change);
  assert.deepEqual(applyProducerChangeRequest(kernel, change).sort(), ["fast", "follow"]);
  assert.equal(kernel.findTask("fast").status, "doing");
  assert.equal(kernel.findTask("follow").status, "doing");
  assert.equal(kernel.findTask("slow").status, "review", "unrelated design stays complete");
  assert.equal(kernel.listArtifacts().find((a) => a.artifactId === "out_fast").status, "change_requested");
  assert.equal(kernel.listArtifactLedger().find((a) => a.artifactId === "out_fast").status, "verified", "old file evidence is retained, not fabricated or deleted");
  assert.deepEqual(kernel.listMessages().find((m) => m.messageId === change.messageId).relatedTaskIds.sort(), ["fast", "follow"]);
  await verifySupersededReview();
  console.log("Rolling task flow passed: downstream uses free slot, one task per role, explicit producer change invalidates only its dependency cone.");
} finally {
  releaseSlow();
  service.pause(kernel.project.projectId);
  await new Promise((resolve) => setImmediate(resolve));
  rmSync(root, { recursive: true, force: true });
}

async function verifySupersededReview() {
  const current = createStudioKernel("rolling_revision", "Revision Flow", "producer_test", "revision test");
  current.updateProject({ executionStatus: "running" });
  add("author", "game_designer", "agents/design/input.md", [], current);
  const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
  const reply = (task, run) => {
    return { messageId: `revision_${task.taskId}_${run}`, projectId: current.project.projectId,
      roomId: task.roomId, senderType: "agent", senderId: task.ownerAgentId, messageType: "progress_update",
      mentions: [], relatedTaskIds: [task.taskId], relatedArtifactIds: [], metadata: {}, createdAt: new Date().toISOString(),
      content: "```json\n" + JSON.stringify({ loopControl: {status: "ready_for_review", reason: "Fixture", handoffAgentIds: []},
        toolRequests: task.outputArtifacts.map((id) => {
          const artifact = current.listArtifacts().find((a) => a.artifactId === id);
          return {tool: "write_artifact", taskId: task.taskId, artifactId: artifact.artifactId,
            artifactType: artifact.type, path: artifact.path, content: `# Revision ${run}\n\nGrounded fixture.\n`};
        }) }) + "\n```" };
  };
  syncProjectWorkspace(current);
  await executeAgentToolRequests(current, [reply(current.findTask("author"), 0)]);
  const original = current.listArtifacts().find((a) => a.artifactId === "out_author");
  current.addArtifact({...original, artifactId: "out_author_check", path: "agents/design/check.md", status: "draft", metadata: {}});
  current.updateTask("author", {outputArtifacts: ["out_author", "out_author_check"]});
  // An upstream author can revise a previously materialized input while a
  // consumer is reviewing its old snapshot; unrelated work must not be aborted.
  add("reviewer", "art_director", "agents/art/review.md", ["out_author"], current);
  add("unrelated", "cocos_tech_lead", "agents/engineering/unrelated.md", [], current);
  let reviewStarted, releaseUnrelated;
  const reviewReady = new Promise((resolve) => { reviewStarted = resolve; });
  const unrelatedGate = new Promise((resolve) => { releaseUnrelated = resolve; });
  let reviewRuns = 0, cancelled = false, unrelatedCancelled = false;
  const active = new Set();
  const loop = new AgentLoopService({ getKernel: () => current, checkpoint: syncProjectWorkspace,
    modelRuntime: { async respondToTask(k, task, input) {
      assert.ok(!active.has(task.ownerAgentId), "cancelled worker must settle before role reuse");
      active.add(task.ownerAgentId);
      try {
        if (task.taskId === "author") await reviewReady;
        if (task.taskId === "unrelated") {
          input.abortSignal.addEventListener("abort", () => { unrelatedCancelled = true; }, { once: true });
          await unrelatedGate;
        }
        if (task.taskId === "reviewer") {
          reviewRuns++;
          if (reviewRuns === 1) {
            reviewStarted();
            await new Promise((resolve) => input.abortSignal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
            assert.equal(input.inputsAreCurrent(), false);
            // Even a worker ignoring cancellation and returning late success
            // cannot publish this reply or write its obsolete output.
            return reply(task, "obsolete");
          }
          assert.equal(input.inputsAreCurrent(), true);
          assert.equal(unrelatedCancelled, false);
          releaseUnrelated();
        }
        return reply(task, 1);
      } finally { active.delete(task.ownerAgentId); }
    } }
  });
  try {
    loop.start(current.project.projectId, {reason: "supersession test"});
    const deadline = Date.now() + 5_000;
    while (current.getAgentLoopState().status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
    assert.equal(reviewRuns, 2);
    assert.equal(unrelatedCancelled, false);
    assert.ok(current.listTasks().every((t) => t.status === "review"));
    assert.ok(current.listMessages().every((m) => !m.messageId.endsWith("obsolete")), "stale response must never enter chat or claim audit");
    assert.equal(current.getAgentLoopState().lastError, undefined);
  } finally {
    releaseUnrelated(); reviewStarted(); loop.pause(current.project.projectId);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
