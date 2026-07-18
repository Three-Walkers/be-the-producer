import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "be-the-producer-loop-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { AgentLoopService } = await import("../apps/api/dist/agentLoop.js");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");
const { createStudioKernel, createStudioKernelFromSnapshot, LocalAgentRuntime } = await import("@game-pipeline/agent-runtime");

const projectId = "agent_loop_smoke";
const kernel = createStudioKernel(projectId, "Agent Loop Smoke", "producer_test", "做一个可爱的毛线球防守微信小游戏");
kernel.updateProject({ executionStatus: "running", startedAt: new Date().toISOString() });

const producerMessage = {
  messageId: "msg_smoke_bootstrap",
  projectId,
  roomId: kernel.getRoom("studio-main").roomId,
  senderType: "producer",
  senderId: "producer_test",
  messageType: "plan_submission",
  content: "单局 90 秒，点击毛线球防守篮子，轻松可爱，继续执行策划和美术基线。",
  mentions: [],
  relatedTaskIds: [],
  relatedArtifactIds: [],
  metadata: {},
  createdAt: new Date().toISOString()
};
new LocalAgentRuntime().handleProducerMessage(kernel, producerMessage, {
  scriptedReplies: false,
  protocolFlows: false,
  bootstrapProjectState: true
});

const now = new Date().toISOString();
for (const artifact of [
  {
    artifactId: "artifact_gdd_baseline_draft",
    type: "gdd",
    path: "agents/design/gdd/00_overview.md",
    ownerAgentId: "game_designer",
    sourceTaskId: "task_stage_1_design_clarification"
  },
  {
    artifactId: "artifact_art_bible_baseline_draft",
    type: "art_bible",
    path: "agents/art/art-bible.md",
    ownerAgentId: "art_director",
    sourceTaskId: "task_stage_1_art_direction"
  }
]) {
  kernel.upsertArtifact({
    ...artifact,
    projectId,
    stageId: "concept_discussion",
    status: "draft",
    version: 1,
    sourceDecisionIds: [],
    metadata: { generatedBy: "agent_loop_smoke_fixture" },
    createdAt: now,
    updatedAt: now
  });
}
syncProjectWorkspace(kernel);

let activeCalls = 0;
let maximumConcurrency = 0;
let modelCallCount = 0;
let responseDelayMs = 40;
const fakeModelRuntime = {
  async respondToTask(currentKernel, task, input) {
    activeCalls += 1;
    modelCallCount += 1;
    maximumConcurrency = Math.max(maximumConcurrency, activeCalls);
    await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    activeCalls -= 1;

    const artifactId = task.outputArtifacts[0];
    const artifact = currentKernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    assert.ok(artifact, `missing fixture artifact for ${task.taskId}`);
    const title = task.ownerAgentId === "game_designer" ? "GDD Baseline" : "Art Bible Baseline";
    const payload = {
      loopControl: {
        status: "ready_for_review",
        reason: "基线内容已通过服务端工具提交，等待制作人评审。",
        handoffAgentIds: []
      },
      toolRequests: [
        {
          tool: "write_artifact",
          path: artifact.path,
          artifactId,
          artifactType: artifact.type,
          taskId: task.taskId,
          content: `# ${title}\n\n由 ${task.ownerAgentId} 在 Agent Loop 第 ${input.iteration} 轮生成。`
        }
      ]
    };
    return {
      messageId: `msg_${task.ownerAgentId}_${modelCallCount}`,
      projectId,
      roomId: task.roomId ?? currentKernel.getRoom("studio-main").roomId,
      senderType: "agent",
      senderId: task.ownerAgentId,
      messageType: "progress_update",
      content: `提交 ${title} 供制作人评审。\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      mentions: [],
      relatedTaskIds: [task.taskId],
      relatedArtifactIds: [],
      metadata: {
        generatedBy: "agent_loop_smoke_model",
        loopIteration: input.iteration
      },
      createdAt: new Date().toISOString()
    };
  }
};

const service = new AgentLoopService({
  getKernel: () => kernel,
  checkpoint: (currentKernel) => {
    syncProjectWorkspace(currentKernel);
  },
  modelRuntime: fakeModelRuntime
});

service.start(projectId, {
  reason: "smoke test producer wake",
  unlockProducerWaits: true
});
await waitFor(() => kernel.getAgentLoopState().status !== "running", 4_000);

assert.equal(maximumConcurrency, 2, "策划和美术应在同一回合并行执行");
assert.equal(kernel.findTask("task_stage_1_design_clarification")?.status, "review");
assert.equal(kernel.findTask("task_stage_1_art_direction")?.status, "review");
assert.equal(kernel.getAgentLoopState().status, "waiting_for_producer");
assert.match(kernel.getAgentLoopState().waitingReason ?? "", /评审/);

for (const artifactId of ["artifact_gdd_baseline_draft", "artifact_art_bible_baseline_draft"]) {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  assert.ok(artifact?.metadata.toolExecutedAt, `${artifactId} 缺少工具执行证据`);
  assert.equal(ledger?.status, "verified", `${artifactId} 未通过 Artifact Ledger 验证`);
  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, artifact.path);
  assert.ok(existsSync(absolutePath), `${artifact.path} 未实际写入`);
  assert.match(readFileSync(absolutePath, "utf8"), /Baseline/);
}

const restored = createStudioKernelFromSnapshot(kernel.toSnapshot());
assert.equal(restored.getAgentLoopState().status, "waiting_for_producer", "重启后应保留 Loop 状态");
assert.equal(restored.getAgentLoopState().iteration, kernel.getAgentLoopState().iteration, "重启后应保留 Loop 轮次");

kernel.updateTask("task_stage_1_design_clarification", {
  status: "doing",
  blockers: [],
  updatedAt: new Date().toISOString()
});
responseDelayMs = 120;
const versionBeforePause = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gdd_baseline_draft")?.version;
service.start(projectId, { reason: "pause cancellation smoke" });
await new Promise((resolve) => setTimeout(resolve, 15));
service.pause(projectId, "smoke pause");
await new Promise((resolve) => setTimeout(resolve, responseDelayMs + 40));
assert.equal(kernel.getAgentLoopState().status, "paused");
assert.equal(
  kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gdd_baseline_draft")?.version,
  versionBeforePause,
  "暂停后迟到的模型结果不得写入产物"
);

const toolMessages = [
  createToolMessage("asset_production", {
    loopControl: { status: "continue", reason: "继续生成配套资产。", handoffAgentIds: [] },
    toolRequests: [
      {
        tool: "generate_image",
        path: "assets/art/smoke-ball.svg",
        artifactType: "asset",
        content: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="#54b895"/></svg>'
      }
    ]
  }),
  createToolMessage("gameplay_programmer", {
    loopControl: { status: "continue", reason: "代码已写入并完成语法检查。", handoffAgentIds: [] },
    toolRequests: [
      {
        tool: "write_code",
        path: "assets/scripts/SmokeController.ts",
        artifactType: "source_code",
        content: "export class SmokeController { private score = 0; addScore(): number { return ++this.score; } }"
      },
      {
        tool: "run_typecheck",
        path: "assets/scripts/SmokeController.ts"
      }
    ]
  })
];
const directToolResults = executeAgentToolRequests(kernel, toolMessages);
syncProjectWorkspace(kernel);
assert.deepEqual(directToolResults.map((result) => result.status), ["completed", "completed", "completed"]);
assert.ok(existsSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "assets/art/smoke-ball.svg")));
assert.ok(existsSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "assets/scripts/SmokeController.ts")));

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write(`Agent Loop smoke passed: concurrency=${maximumConcurrency}, modelCalls=${modelCallCount}\n`);

function createToolMessage(agentId, payload) {
  return {
    messageId: `msg_tool_${agentId}`,
    projectId,
    roomId: kernel.getRoom(agentId === "asset_production" ? "art-room" : "engineering-room").roomId,
    senderType: "agent",
    senderId: agentId,
    messageType: "progress_update",
    content: `执行工具。\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
