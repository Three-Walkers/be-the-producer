import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "tool-authorization-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { createStudioKernel, defaultAgentContracts } = await import("@game-pipeline/agent-runtime");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { assertAgentPathAuthorized } = await import("../apps/api/dist/toolAuthorization.js");

try {
  const projectId = "tool_authorization";
  const kernel = createStudioKernel(projectId, "Tool Authorization", "producer_test", "authorization regression");
  const now = new Date().toISOString();
  addTask(kernel, "task_gameplay", "gameplay_programmer", ["artifact_gameplay"]);
  addTask(kernel, "task_gameplay_other", "gameplay_programmer", []);
  addTask(kernel, "task_asset", "asset_production", []);
  addTask(kernel, "task_cocos", "cocos_automation", []);

  kernel.addArtifact({
    artifactId: "artifact_gameplay",
    projectId,
    type: "source_code",
    path: "assets/scripts/gameplay/Game.ts",
    ownerAgentId: "gameplay_programmer",
    stageId: "concept_discussion",
    status: "draft",
    version: 1,
    sourceTaskId: "task_gameplay",
    sourceDecisionIds: [],
    metadata: {},
    createdAt: now,
    updatedAt: now
  });

  const legalCode = await execute("gameplay_programmer", "task_gameplay", {
    tool: "write_code",
    taskId: "task_gameplay",
    artifactId: "artifact_gameplay",
    artifactType: "source_code",
    path: "assets/scripts/gameplay/Game.ts",
    content: "export const gameReady = true;"
  });
  assert.equal(legalCode.status, "completed", legalCode.error);

  const typeDowngrade = await execute("gameplay_programmer", "task_gameplay", {
    tool: "write_code",
    taskId: "task_gameplay",
    artifactId: "artifact_gameplay",
    artifactType: "gdd",
    path: "assets/scripts/gameplay/Game.ts",
    content: "downgrade"
  });
  assert.equal(typeDowngrade.status, "failed");
  assert.match(typeDowngrade.error ?? "", /类型|artifactType|immutable/i);

  const pathRewrite = await execute("gameplay_programmer", "task_gameplay", {
    tool: "write_code",
    taskId: "task_gameplay",
    artifactId: "artifact_gameplay",
    artifactType: "source_code",
    path: "assets/scripts/gameplay/Moved.ts",
    content: "moved"
  });
  assert.equal(pathRewrite.status, "failed");
  assert.match(pathRewrite.error ?? "", /路径|path/i);

  const crossTask = await execute("gameplay_programmer", "task_gameplay_other", {
    tool: "write_code",
    taskId: "task_gameplay_other",
    artifactId: "artifact_gameplay",
    artifactType: "source_code",
    path: "assets/scripts/gameplay/Game.ts",
    content: "cross task"
  });
  assert.equal(crossTask.status, "failed");
  assert.match(crossTask.error ?? "", /任务|task/i);

  const crossRole = await execute("asset_production", "task_asset", {
    tool: "generate_image",
    taskId: "task_asset",
    artifactId: "artifact_gameplay",
    artifactType: "asset",
    path: "assets/scripts/gameplay/Game.ts",
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
  });
  assert.equal(crossRole.status, "failed");
  assert.match(crossRole.error ?? "", /不得覆盖|没有写入权限|拥有/i);

  const wrongOwnerTask = await execute("asset_production", "task_gameplay", {
    tool: "generate_image",
    taskId: "task_gameplay",
    path: "assets/art/wrong-owner.svg",
    artifactType: "asset",
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
  });
  assert.equal(wrongOwnerTask.status, "failed");
  assert.match(wrongOwnerTask.error ?? "", /属于|当前 Agent/i);

  const pathEscape = await execute("asset_production", "task_asset", {
    tool: "generate_image",
    taskId: "task_asset",
    path: "../outside.svg",
    artifactType: "asset",
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
  });
  assert.equal(pathEscape.status, "failed");
  assert.match(pathEscape.error ?? "", /不安全|unsafe/i);

  const legalAsset = await execute("asset_production", "task_asset", {
    tool: "generate_image",
    taskId: "task_asset",
    path: "assets/art/runtime/button.svg",
    artifactType: "asset",
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="#fff"/></svg>'
  });
  assert.equal(legalAsset.status, "completed", legalAsset.error);
  assert.equal(kernel.listArtifacts().find((artifact) => artifact.artifactId === legalAsset.artifactId)?.sourceTaskId, "task_asset");

  const noTaskKernel = createStudioKernel("no_task", "No Task", "producer_test", "no task must reject");
  const noTaskMessage = toolMessage(noTaskKernel, "producer", undefined, {
    tool: "write_artifact",
    path: "agents/producer/notes.md",
    artifactType: "gdd",
    content: "unbound"
  });
  const [noTask] = await executeAgentToolRequests(noTaskKernel, [noTaskMessage]);
  assert.equal(noTask.status, "failed");
  assert.match(noTask.error ?? "", /taskId|候选任务/i);

  const gameplayAgent = defaultAgentContracts.find((agent) => agent.agentId === "gameplay_programmer");
  const cocosAgent = defaultAgentContracts.find((agent) => agent.agentId === "cocos_automation");
  assert.ok(gameplayAgent && cocosAgent);
  const cocosTask = kernel.findTask("task_cocos");
  const gameplayTask = kernel.findTask("task_gameplay");
  assert.ok(cocosTask && gameplayTask);
  assert.doesNotThrow(() => assertAgentPathAuthorized(kernel, cocosAgent, cocosTask, "assets/scenes/Main.scene", "write"));
  assert.doesNotThrow(() => assertAgentPathAuthorized(kernel, cocosAgent, cocosTask, "settings/v2/packages/builder.json", "write"));
  assert.doesNotThrow(() => assertAgentPathAuthorized(kernel, cocosAgent, cocosTask, "shared/build-artifacts/wechat/dev", "write"));
  assert.throws(
    () => assertAgentPathAuthorized(kernel, cocosAgent, cocosTask, "assets/scripts/gameplay/Backdoor.ts", "write"),
    /没有写入/
  );
  assert.throws(
    () => assertAgentPathAuthorized(kernel, gameplayAgent, gameplayTask, "assets/scripts/btp/Generated.ts", "write"),
    /受控角色域/
  );

  assert.throws(
    () => kernel.upsertArtifact({
      ...kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gameplay"),
      type: "gdd",
      updatedAt: new Date().toISOString()
    }),
    /immutable type/
  );
  assert.throws(
    () => kernel.upsertArtifact({
      ...kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gameplay"),
      sourceTaskId: "task_gameplay_other",
      updatedAt: new Date().toISOString()
    }),
    /cannot move|already bound/
  );

  process.stdout.write("Tool authorization passed: identity, task, role, path, and controlled-engine boundaries\n");

  async function execute(agentId, taskId, request) {
    const [result] = await executeAgentToolRequests(kernel, [toolMessage(kernel, agentId, taskId, request)]);
    assert.ok(result, `expected a tool result for ${agentId}`);
    return result;
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function addTask(kernel, taskId, ownerAgentId, outputArtifacts) {
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    taskLevel: "task",
    ownerAgentId,
    title: taskId,
    description: "authorization fixture",
    status: "doing",
    priority: 1,
    sortOrder: 1,
    childrenSummary: { doing: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 },
    inputArtifacts: [],
    outputArtifacts,
    acceptanceCriteria: [],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
}

function toolMessage(kernel, agentId, taskId, request) {
  const roomKind = agentId === "asset_production" ? "art-room" : agentId === "producer" ? "studio-main" : "engineering-room";
  return {
    messageId: `msg_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId: kernel.getRoom(roomKind).roomId,
    senderType: "agent",
    senderId: agentId,
    messageType: "progress_update",
    content: `authorization\n\n\`\`\`json\n${JSON.stringify({ toolRequests: [request] })}\n\`\`\``,
    mentions: [],
    relatedTaskIds: taskId ? [taskId] : [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}
