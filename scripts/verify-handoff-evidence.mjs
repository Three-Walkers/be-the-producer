import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "btp-handoff-evidence-"));
process.env.STUDIO_WORKSPACE_ROOT = join(root, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(root, "state");
const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { AgentLoopService } = await import("../apps/api/dist/agentLoop.js");
const { syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");

try {
  for (const mode of ["missing", "fixed", "upstream", "manual"]) {
    const kernel = createStudioKernel(`handoff_${mode}`, "Handoff", "producer_test", "handoff evidence regression");
    kernel.updateProject({ executionStatus: "running" });
    add(kernel, "author", "game_designer", "agents/design/author.md");
    add(kernel, "reviewer", "art_director", "agents/art/review.md", ["out_author"]);
    add(kernel, "consumer", "cocos_tech_lead", "agents/engineering/consumer.md", ["out_reviewer"]);
    let calls = 0;
    const errors = [];
    const service = new AgentLoopService({
      getKernel: () => kernel,
      checkpoint: (current) => { syncProjectWorkspace(current); },
      modelRuntime: { async respondToTask(current, task) {
        calls++;
        errors.push(task.description);
        const publish = mode === "fixed" && calls > 1;
        const control = { status: mode === "manual" ? "blocked" : "handoff",
          reason: mode === "manual" ? "需要外部访问权限" : "口头交接并不证明文件已提交",
          handoffAgentIds: [mode === "upstream" ? "producer" : "cocos_tech_lead"] };
        const output = current.listArtifacts().find((a) => a.artifactId === task.outputArtifacts[0]);
        return { messageId: `msg_${mode}_${calls}`, projectId: current.project.projectId, roomId: task.roomId,
          senderType: "agent", senderId: task.ownerAgentId, messageType: "progress_update",
          content: "```json\n" + JSON.stringify({ loopControl: control, toolRequests: publish ? [{
            tool: "write_artifact", taskId: task.taskId, artifactId: output.artifactId,
            artifactType: output.type, path: output.path, content: "# Actual author submission\n\nReady for independent inspection.\n"
          }] : [] }) + "\n```",
          relatedTaskIds: [task.taskId], relatedArtifactIds: [], mentions: [], metadata: {}, createdAt: new Date().toISOString() };
      } }
    });
    // Preserve a separate completed review: it must not conceal a real blocker.
    add(kernel, "unrelated", "qa_evaluator", "agents/qa/completed.md");
    syncProjectWorkspace(kernel);
    await executeAgentToolRequests(kernel, [{ messageId: `seed_${mode}`, projectId: kernel.project.projectId,
      roomId: kernel.getRoom("studio-main").roomId, senderType: "agent", senderId: "qa_evaluator",
      messageType: "progress_update", mentions: [], relatedTaskIds: ["unrelated"], relatedArtifactIds: [], metadata: {},
      createdAt: new Date().toISOString(), content: "```json\n" + JSON.stringify({ toolRequests: [{
        tool: "write_artifact", taskId: "unrelated", artifactId: "out_unrelated", artifactType: "gdd",
        path: "agents/qa/completed.md", content: "# Independent completed notes\n\nUnrelated to the missing author output.\n"
      }] }) + "\n```" }]);
    kernel.updateTask("unrelated", { status: "review" });
    service.start(kernel.project.projectId, { reason: "verify bounded handoff feedback" });
    const deadline = Date.now() + 5000;
    while (kernel.getAgentLoopState().status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      assert.notEqual(kernel.getAgentLoopState().status, "running", "handoff retry must terminate");
      if (mode === "missing") {
        assert.equal(calls, 3, "incomplete downstream handoff retries its owner only, with a finite budget");
        assert.match(errors[1], /out_author.*agents\/design\/author.md/);
        assert.equal(kernel.findTask("author").status, "blocked");
        assert.equal(kernel.getAgentLoopState().status, "blocked", "review siblings cannot mask incomplete work as producer approval");
      } else if (mode === "fixed") {
        assert.equal(kernel.findTask("author").status, "review");
        assert.equal(kernel.findTask("reviewer").status, "review");
        assert.equal(kernel.findTask("consumer").status, "review");
        assert.doesNotMatch(kernel.findTask("author").description, /HANDOFF_EVIDENCE_REPAIR/);
        assert.equal(kernel.getAgentLoopState().status, "waiting_for_producer");
      } else {
        assert.equal(calls, 1, "upstream/producer requests and explicit manual blockers must not auto-retry");
        assert.equal(kernel.findTask("author").status, "blocked");
      }
    } finally { service.pause(kernel.project.projectId); }
  }
  console.log("Handoff evidence passed: transitive downstream gaps, bounded retries, real repair and manual/upstream preservation.");
} finally { rmSync(root, { recursive: true, force: true }); }

function add(kernel, id, owner, path, inputs = []) {
  const now = new Date().toISOString();
  kernel.addTask({ taskId: id, projectId: kernel.project.projectId, stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("studio-main").roomId, taskLevel: "task", title: id, description: id,
    ownerAgentId: owner, participantAgentIds: [], status: "doing", priority: 100, sortOrder: kernel.listTasks().length,
    progressPercent: 0, blockers: [], inputArtifacts: inputs, outputArtifacts: [`out_${id}`],
    acceptanceCriteria: ["Tool-written evidence"], createdAt: now, updatedAt: now });
  kernel.addArtifact({ artifactId: `out_${id}`, projectId: kernel.project.projectId, type: "gdd", path,
    ownerAgentId: owner, stageId: kernel.project.currentStage, status: "draft", version: 1,
    sourceTaskId: id, sourceDecisionIds: [], metadata: {}, createdAt: now, updatedAt: now });
}
