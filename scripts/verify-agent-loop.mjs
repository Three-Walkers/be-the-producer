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
    artifactId: "artifact_game_contract_draft",
    type: "game_contract",
    path: "agents/design/contracts/game-contract.json",
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
for (const artifactId of ["artifact_gdd_baseline_draft", "artifact_game_contract_draft", "artifact_art_bible_baseline_draft"]) {
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  assert.equal(ledger?.status, "pending", `${artifactId} 的工作区占位文件不得成为已验证证据`);
}

let activeCalls = 0;
let maximumConcurrency = 0;
let modelCallCount = 0;
let responseDelayMs = 40;
let forcedFailureKind;
const fakeModelRuntime = {
  async respondToTask(currentKernel, task, input) {
    activeCalls += 1;
    modelCallCount += 1;
    maximumConcurrency = Math.max(maximumConcurrency, activeCalls);
    await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    activeCalls -= 1;

    if (forcedFailureKind) {
      return {
        messageId: `msg_${task.ownerAgentId}_failure_${modelCallCount}`,
        projectId,
        roomId: task.roomId ?? currentKernel.getRoom("studio-main").roomId,
        senderType: "agent",
        senderId: task.ownerAgentId,
        messageType: "blocker",
        content: "Harness 没有产生工具写入。",
        mentions: [],
        relatedTaskIds: [task.taskId],
        relatedArtifactIds: [],
        metadata: {
          failure: true,
          failureKind: forcedFailureKind,
          loopIteration: input.iteration
        },
        createdAt: new Date().toISOString()
      };
    }

    const title = task.ownerAgentId === "game_designer" ? "GDD Baseline" : "Art Bible Baseline";
    const toolRequests = task.outputArtifacts.map((artifactId) => {
      const artifact = currentKernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
      assert.ok(artifact, `missing fixture artifact for ${task.taskId}`);
      return {
        tool: "write_artifact",
        path: artifact.path,
        artifactId,
        artifactType: artifact.type,
        taskId: task.taskId,
        content: artifact.type === "game_contract"
          ? `${JSON.stringify(gameContractFixture(), null, 2)}\n`
          : `# ${title}\n\n由 ${task.ownerAgentId} 在 Agent Loop 第 ${input.iteration} 轮生成。`
      };
    });
    const payload = {
      loopControl: {
        status: "ready_for_review",
        reason: "基线内容已通过服务端工具提交，等待制作人评审。",
        handoffAgentIds: []
      },
      toolRequests
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

for (const artifactId of ["artifact_gdd_baseline_draft", "artifact_game_contract_draft", "artifact_art_bible_baseline_draft"]) {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  assert.ok(artifact?.metadata.toolExecutedAt, `${artifactId} 缺少工具执行证据`);
  assert.equal(ledger?.status, "verified", `${artifactId} 未通过 Artifact Ledger 验证`);
  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, artifact.path);
  assert.ok(existsSync(absolutePath), `${artifact.path} 未实际写入`);
  const materialized = readFileSync(absolutePath, "utf8");
  if (artifact?.type === "game_contract") {
    assert.equal(JSON.parse(materialized).kind, "game_contract");
  } else {
    assert.match(materialized, /Baseline/);
  }
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

kernel.addTask({
  taskId: "task_harness_no_progress",
  projectId,
  stageId: "concept_discussion",
  roomId: kernel.getRoom("design-room").roomId,
  parentTaskId: "task_group_stage_1",
  taskLevel: "task",
  title: "验证无进展 Harness 重试上限",
  description: "模拟 Claude CLI 没有调用任何工具。",
  ownerAgentId: "game_designer",
  participantAgentIds: [],
  status: "doing",
  priority: 200,
  sortOrder: 5,
  progressPercent: 0,
  blockers: [],
  inputArtifacts: [],
  outputArtifacts: [],
  acceptanceCriteria: ["两次无进展后停止自动重试"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});
forcedFailureKind = "harness_timeout_no_progress";
responseDelayMs = 0;
const callsBeforeNoProgressFailure = modelCallCount;
service.start(projectId, { reason: "no-progress retry limit smoke" });
await waitFor(() => kernel.getAgentLoopState().status !== "running", 4_000);
assert.equal(modelCallCount - callsBeforeNoProgressFailure, 2, "无工具进展的 Harness 超时最多自动尝试两次");
assert.equal(kernel.findTask("task_harness_no_progress")?.status, "blocked");
assert.match(kernel.findTask("task_harness_no_progress")?.blockers.join("；") ?? "", /连续失败 2 次/);
forcedFailureKind = undefined;

addDirectToolFixture({
  taskId: "task_smoke_asset_tool",
  ownerAgentId: "asset_production",
  artifactId: "artifact_smoke_ball",
  artifactType: "asset",
  path: "assets/art/smoke-ball.svg"
});
addDirectToolFixture({
  taskId: "task_smoke_code_tool",
  ownerAgentId: "gameplay_programmer",
  artifactId: "artifact_smoke_controller",
  artifactType: "source_code",
  path: "assets/scripts/SmokeController.ts"
});

const toolMessages = [
  createToolMessage("asset_production", "task_smoke_asset_tool", {
    loopControl: { status: "continue", reason: "继续生成配套资产。", handoffAgentIds: [] },
    toolRequests: [
      {
        tool: "generate_image",
        taskId: "task_smoke_asset_tool",
        artifactId: "artifact_smoke_ball",
        path: "assets/art/smoke-ball.svg",
        artifactType: "asset",
        content: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="#54b895"/></svg>'
      }
    ]
  }),
  createToolMessage("gameplay_programmer", "task_smoke_code_tool", {
    loopControl: { status: "continue", reason: "代码已写入并完成语法检查。", handoffAgentIds: [] },
    toolRequests: [
      {
        tool: "write_code",
        taskId: "task_smoke_code_tool",
        artifactId: "artifact_smoke_controller",
        path: "assets/scripts/SmokeController.ts",
        artifactType: "source_code",
        content: "export class SmokeController { private score = 0; addScore(): number { return ++this.score; } }"
      },
      {
        tool: "run_typecheck",
        taskId: "task_smoke_code_tool",
        path: "assets/scripts/SmokeController.ts"
      }
    ]
  })
];
const directToolResults = await executeAgentToolRequests(kernel, toolMessages);
syncProjectWorkspace(kernel);
assert.deepEqual(directToolResults.map((result) => result.status), ["completed", "completed", "completed"]);
assert.ok(existsSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "assets/art/smoke-ball.svg")));
assert.ok(existsSync(join(process.env.STUDIO_WORKSPACE_ROOT, projectId, "assets/scripts/SmokeController.ts")));

rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write(`Agent Loop smoke passed: concurrency=${maximumConcurrency}, modelCalls=${modelCallCount}\n`);

function createToolMessage(agentId, taskId, payload) {
  return {
    messageId: `msg_tool_${agentId}`,
    projectId,
    roomId: kernel.getRoom(agentId === "asset_production" ? "art-room" : "engineering-room").roomId,
    senderType: "agent",
    senderId: agentId,
    messageType: "progress_update",
    content: `执行工具。\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    mentions: [],
    relatedTaskIds: [taskId],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

function addDirectToolFixture({ taskId, ownerAgentId, artifactId, artifactType, path }) {
  const createdAt = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom(ownerAgentId === "asset_production" ? "art-room" : "engineering-room").roomId,
    parentTaskId: "task_group_stage_1",
    taskLevel: "task",
    title: `验证 ${ownerAgentId} 直接工具执行`,
    description: "为工具授权回归提供真实的 owned task 与声明式输出产物。",
    ownerAgentId,
    participantAgentIds: [],
    status: "doing",
    priority: 150,
    sortOrder: 6,
    progressPercent: 0,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts: [artifactId],
    acceptanceCriteria: ["只能在任务声明的产物路径执行工具"],
    createdAt,
    updatedAt: createdAt
  });
  kernel.addArtifact({
    artifactId,
    projectId,
    type: artifactType,
    path,
    ownerAgentId,
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: { generatedBy: "agent_loop_direct_tool_fixture" },
    createdAt,
    updatedAt: createdAt
  });
}

function gameContractFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "game_contract",
    identity: {
      contractId: "agent_loop_smoke.contract",
      gameId: "agent_loop_smoke",
      title: "Agent Loop Smoke",
      slug: "agent-loop-smoke",
      summary: "Contract fixture used to prove that design outputs are validated before review.",
      revision: 1,
      releaseVersion: "0.1.0"
    },
    genre: {
      primary: "interaction_test",
      tags: ["interaction_test"],
      perspective: "2d",
      playerMode: "single_player"
    },
    coreLoop: {
      summary: "Start the session, perform the primary action, and reach the objective.",
      steps: [{
        stepId: "primary_loop",
        label: "Primary loop",
        description: "Exercise the public input and progress signal.",
        actionIds: ["primary_action"],
        stateIds: ["playing"],
        emits: ["progress"]
      }],
      successConditions: [{ signalId: "progress", operator: "gte", value: 1 }],
      failureConditions: []
    },
    stateModel: {
      lifecycle: "finite",
      initialState: "ready",
      states: [
        { stateId: "ready", label: "Ready", kind: "boot", terminal: false, description: "Waiting to start." },
        { stateId: "playing", label: "Playing", kind: "active", terminal: false, description: "Main loop." },
        { stateId: "won", label: "Won", kind: "success", terminal: true, description: "Objective reached." }
      ],
      transitions: [
        { transitionId: "start", from: "ready", to: "playing", trigger: { type: "system", ref: "start" }, guards: [], emits: [] },
        { transitionId: "win", from: "playing", to: "won", trigger: { type: "signal", ref: "progress" }, guards: [{ signalId: "progress", operator: "gte", value: 1 }], emits: [] }
      ]
    },
    inputModel: {
      actions: [{
        actionId: "primary_action",
        label: "Primary action",
        description: "The fixture's primary input.",
        bindings: [{ device: "touch", control: "gameplay_area", gesture: "tap" }],
        enabledInStates: ["playing"]
      }],
      simultaneousTouchPoints: 1
    },
    runtimeSignals: {
      signals: [{
        signalId: "progress",
        label: "Progress",
        description: "Public objective progress.",
        valueType: "integer",
        visibility: "public",
        initialValue: 0
      }]
    }
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
