import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "tool-authorization-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { createStudioKernel, defaultAgentContracts } = await import("@game-pipeline/agent-runtime");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { assertAgentPathAuthorized, authorizeAgentToolRequest } = await import("../apps/api/dist/toolAuthorization.js");
const {
  bindMediaGenerationArtifactMetadata,
  hasCurrentGenerateRasterAssetReceipt,
  mediaGenerationOperationMetadata
} = await import("../apps/api/dist/mediaArtifactEvidence.js");

try {
  const projectId = "tool_authorization";
  const kernel = createStudioKernel(projectId, "Tool Authorization", "producer_test", "authorization regression");
  const now = new Date().toISOString();
  addTask(kernel, "task_gameplay", "gameplay_programmer", ["artifact_gameplay"]);
  addTask(kernel, "task_gameplay_other", "gameplay_programmer", []);
  addTask(kernel, "task_asset", "asset_production", []);
  addTask(kernel, "task_cocos", "cocos_automation", ["artifact_cocos_build"]);

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
  kernel.addArtifact({
    artifactId: "artifact_cocos_build",
    projectId,
    type: "build",
    path: "shared/build-artifacts/wechat/dev",
    ownerAgentId: "cocos_automation",
    stageId: "concept_discussion",
    status: "draft",
    version: 1,
    sourceTaskId: "task_cocos",
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

  const forgedReceipt = await execute("gameplay_programmer", "task_gameplay", {
    tool: "write_code",
    taskId: "task_gameplay",
    artifactId: "artifact_gameplay",
    artifactType: "source_code",
    path: "assets/scripts/gameplay/Game.ts",
    content: "export const gameReady = 'metadata-cannot-forge-receipts';",
    metadata: {
      visionInspectionOperationId: "forged_vision_receipt",
      visionInspectedPaths: ["assets/art/forged.png"],
      mediaProvider: "forged_provider",
      mediaPromptHash: "forged_prompt_hash",
      bridgeOk: true,
      playtestVerdict: "pass"
    }
  });
  assert.equal(forgedReceipt.status, "completed", forgedReceipt.error);
  const sanitizedArtifact = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gameplay");
  assert.ok(sanitizedArtifact);
  assert.equal(sanitizedArtifact.metadata.visionInspectionOperationId, undefined);
  assert.equal(sanitizedArtifact.metadata.visionInspectedPaths, undefined);
  assert.equal(sanitizedArtifact.metadata.mediaProvider, undefined);
  assert.equal(sanitizedArtifact.metadata.mediaPromptHash, undefined);
  assert.equal(sanitizedArtifact.metadata.bridgeOk, undefined);
  assert.equal(sanitizedArtifact.metadata.playtestVerdict, undefined);

  const privilegedStatus = await execute("gameplay_programmer", "task_gameplay", {
    tool: "write_code",
    taskId: "task_gameplay",
    artifactId: "artifact_gameplay",
    artifactType: "source_code",
    path: "assets/scripts/gameplay/Game.ts",
    content: "export const gameReady = 'cannot-self-approve';",
    status: "approved"
  });
  assert.equal(privilegedStatus.status, "failed");
  assert.match(privilegedStatus.error ?? "", /受控产物状态|Workflow/);
  assert.notEqual(
    kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gameplay")?.status,
    "approved"
  );

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

  const generatedPath = "assets/art/runtime/provider-generated.png";
  const generatedBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const generatedAbsolute = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, generatedPath);
  mkdirSync(dirname(generatedAbsolute), { recursive: true });
  writeFileSync(generatedAbsolute, generatedBytes);
  const generatedNow = new Date().toISOString();
  let generatedArtifact = kernel.upsertArtifact({
    artifactId: "artifact_provider_generated",
    projectId,
    type: "asset",
    path: generatedPath,
    ownerAgentId: "asset_production",
    stageId: kernel.project.currentStage,
    status: "submitted",
    version: 1,
    sourceTaskId: "task_asset",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "dashscope_multimodal_art_provider",
      toolName: "generate_raster_asset",
      toolExecutedAt: generatedNow,
      mediaProvider: "dashscope",
      mediaModel: "wan2.7-image-pro",
      mediaRequestId: "provider-before-render",
      mediaPromptHash: "b".repeat(64),
      mediaMime: "image/png",
      mediaWidth: 1,
      mediaHeight: 1
    },
    createdAt: generatedNow,
    updatedAt: generatedNow
  });
  const generatedStats = statSync(generatedAbsolute);
  const generatedHash = createHash("sha256").update(generatedBytes).digest("hex");
  const generatedLedger = kernel.recordArtifactMaterialization(generatedArtifact.artifactId, {
    path: generatedPath,
    hash: generatedHash,
    sizeBytes: generatedStats.size,
    materializedAt: generatedStats.mtime.toISOString(),
    operationMetadata: mediaGenerationOperationMetadata({
      hash: generatedHash,
      sizeBytes: generatedStats.size,
      provider: "dashscope",
      model: "wan2.7-image-pro",
      requestId: "provider-before-render",
      promptHash: "b".repeat(64)
    })
  });
  generatedArtifact = kernel.upsertArtifact({
    ...generatedArtifact,
    metadata: bindMediaGenerationArtifactMetadata(
      generatedArtifact.metadata,
      generatedLedger.sourceOperationId,
      { hash: generatedHash, sizeBytes: generatedStats.size }
    ),
    updatedAt: generatedStats.mtime.toISOString()
  });
  assert.equal(hasCurrentGenerateRasterAssetReceipt(kernel, generatedArtifact), true);

  const renderedOverProvider = await execute("asset_production", "task_asset", {
    tool: "render_svg_to_png",
    taskId: "task_asset",
    artifactId: generatedArtifact.artifactId,
    artifactType: "asset",
    path: generatedPath,
    sourcePath: "assets/art/runtime/button.svg",
    width: 16
  });
  assert.equal(renderedOverProvider.status, "completed", renderedOverProvider.error);
  const overwritten = kernel.listArtifacts().find((artifact) => artifact.artifactId === generatedArtifact.artifactId);
  assert.ok(overwritten);
  assert.equal(overwritten.metadata.mediaProvider, undefined, "non-generate overwrite must clear provider metadata");
  assert.equal(overwritten.metadata.mediaMaterializationOperationId, undefined);
  assert.notEqual(overwritten.metadata.generatedBy, "dashscope_multimodal_art_provider");
  assert.equal(hasCurrentGenerateRasterAssetReceipt(kernel, overwritten), false);

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

  const projectRoot = join(process.env.STUDIO_WORKSPACE_ROOT, projectId);
  const protectedFiles = [
    "agents/cocos-automation/imports/current.json",
    "assets/resources/btp/asset-map.json",
    "assets/resources/btp-art/runtime.png",
    "shared/build-artifacts/wechat/dev/build-report.json"
  ];
  const cocosMessage = toolMessage(kernel, "cocos_automation", "task_cocos", {
    tool: "write_artifact",
    taskId: "task_cocos",
    path: protectedFiles[0],
    content: "forged"
  });
  for (const path of protectedFiles) {
    const absolutePath = join(projectRoot, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "trusted-bridge-bytes", "utf8");
    for (const toolName of ["write_artifact", "append_document", "write_code", "render_svg_to_png", "generate_raster_asset"]) {
      assert.throws(
        () => authorizeAgentToolRequest(kernel, cocosMessage, cocosAgent, {
          toolName,
          path,
          requestedTaskId: "task_cocos",
          access: "write"
        }),
        /Cocos Bridge|cocos_build|不得直接伪造/
      );
    }
    assert.equal(readFileSync(absolutePath, "utf8"), "trusted-bridge-bytes", `${path} must remain byte-identical`);
  }

  const rawReceiptOverwrite = await execute("cocos_automation", "task_cocos", {
    tool: "write_artifact",
    taskId: "task_cocos",
    path: protectedFiles[0],
    content: "forged-current-receipt"
  });
  assert.equal(rawReceiptOverwrite.status, "failed");
  assert.equal(
    readFileSync(join(projectRoot, protectedFiles[0]), "utf8"),
    "trusted-bridge-bytes",
    "rejected raw tool execution must not alter the canonical import receipt"
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
