import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "game-contract-gates-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { artifactReadyForConsumption } = await import("../apps/api/dist/taskOutputEvidence.js");
const { resolveWorkspacePathTarget, syncProjectWorkspace } = await import("../apps/api/dist/workspaceWriter.js");

try {
  const projectId = "contract_artifact_gates";
  const kernel = createStudioKernel(projectId, "Contract Artifact Gates", "producer_test", "验证契约写入与消费门禁");
  const now = new Date().toISOString();

  addOwnedTask(kernel, {
    taskId: "task_placeholder_contract",
    ownerAgentId: "game_designer",
    outputArtifacts: ["artifact_placeholder_contract"]
  });
  addOwnedTask(kernel, {
    taskId: "task_game_contract",
    ownerAgentId: "game_designer",
    outputArtifacts: ["artifact_game_contract"]
  });
  addOwnedTask(kernel, {
    taskId: "task_scene_blueprint",
    ownerAgentId: "cocos_tech_lead",
    outputArtifacts: ["artifact_scene_blueprint"]
  });
  addOwnedTask(kernel, {
    taskId: "task_playtest_contract",
    ownerAgentId: "qa_evaluator",
    outputArtifacts: ["artifact_playtest_contract"]
  });

  // The registry is the navigation aid for pending strict contracts. Their
  // canonical path must remain absent until a validated tool materializes it.
  kernel.addArtifact({
    artifactId: "artifact_placeholder_contract",
    projectId,
    type: "game_contract",
    path: "agents/design/contracts/placeholder-game-contract.json",
    ownerAgentId: "game_designer",
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: "task_placeholder_contract",
    sourceDecisionIds: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
  syncProjectWorkspace(kernel);
  const placeholderPath = resolveWorkspacePathTarget(projectId, "agents/design/contracts/placeholder-game-contract.json");
  assert.equal(placeholderPath.exists, false, "workspace sync must not create malformed strict-contract placeholder JSON");
  assert.equal(
    kernel.listArtifactLedger().find((entry) => entry.artifactId === "artifact_placeholder_contract")?.status,
    "pending",
    "a generated placeholder must not become verified evidence",
  );
  assert.equal(artifactReadyForConsumption(kernel, "artifact_placeholder_contract"), false);

  const invalidGameContract = gameContractFixture();
  invalidGameContract.identity.revison = 9;
  const gamePath = "agents/design/contracts/game-contract.json";
  const invalidGameResult = await executeSingleWrite(kernel, {
    agentId: "game_designer",
    taskId: "task_game_contract",
    artifactId: "artifact_game_contract",
    path: gamePath,
    artifactType: "game_contract",
    content: invalidGameContract,
  });
  assert.equal(invalidGameResult.status, "failed");
  assert.match(invalidGameResult.error ?? "", /unknown|revison|结构校验/i);
  assert.equal(resolveWorkspacePathTarget(projectId, gamePath).exists, false, "invalid contract must not be materialized");
  assert.equal(kernel.listArtifacts().some((artifact) => artifact.path === gamePath), false, "invalid contract must not be registered");

  const gameContract = gameContractFixture();
  const validGameResult = await executeSingleWrite(kernel, {
    agentId: "game_designer",
    taskId: "task_game_contract",
    artifactId: "artifact_game_contract",
    path: gamePath,
    artifactType: "game_contract",
    content: gameContract,
  });
  assert.equal(validGameResult.status, "completed", validGameResult.error);
  assert.ok(validGameResult.artifactId);
  const gameArtifact = kernel.listArtifacts().find((artifact) => artifact.artifactId === validGameResult.artifactId);
  const gameLedger = kernel.listArtifactLedger().find((entry) => entry.artifactId === validGameResult.artifactId);
  assert.ok(gameArtifact?.metadata.toolExecutedAt, "valid tool write should record tool execution provenance");
  assert.equal(gameLedger?.status, "verified");
  assert.equal(artifactReadyForConsumption(kernel, validGameResult.artifactId), true);

  const sameRevisionMutation = structuredClone(gameContract);
  sameRevisionMutation.identity.title = "Changed Without Revision";
  const staleRevisionResult = await executeSingleWrite(kernel, {
    agentId: "game_designer",
    taskId: "task_game_contract",
    path: gamePath,
    artifactType: "game_contract",
    artifactId: validGameResult.artifactId,
    content: sameRevisionMutation,
  });
  assert.equal(staleRevisionResult.status, "failed");
  assert.match(staleRevisionResult.error ?? "", /revision.*递增/i);
  assert.equal(
    JSON.parse(readFileSync(resolveWorkspacePathTarget(projectId, gamePath).absolutePath, "utf8")).identity.title,
    gameContract.identity.title,
    "rejected same-revision content must not overwrite the verified file",
  );

  const scenePath = "agents/engineering/contracts/scene-blueprint.json";
  const incompatibleScene = sceneBlueprintFixture();
  incompatibleScene.gameContract.revision = 2;
  const incompatibleSceneResult = await executeSingleWrite(kernel, {
    agentId: "cocos_tech_lead",
    taskId: "task_scene_blueprint",
    artifactId: "artifact_scene_blueprint",
    path: scenePath,
    artifactType: "scene_blueprint",
    content: incompatibleScene,
  });
  assert.equal(incompatibleSceneResult.status, "failed");
  assert.match(incompatibleSceneResult.error ?? "", /不兼容|revision/i);
  assert.equal(resolveWorkspacePathTarget(projectId, scenePath).exists, false);

  const validSceneResult = await executeSingleWrite(kernel, {
    agentId: "cocos_tech_lead",
    taskId: "task_scene_blueprint",
    artifactId: "artifact_scene_blueprint",
    path: scenePath,
    artifactType: "scene_blueprint",
    content: sceneBlueprintFixture(),
  });
  assert.equal(validSceneResult.status, "completed", validSceneResult.error);
  assert.ok(validSceneResult.artifactId);

  const playtestPath = "agents/qa/contracts/core-loop.playtest-contract.json";
  const validPlaytestResult = await executeSingleWrite(kernel, {
    agentId: "qa_evaluator",
    taskId: "task_playtest_contract",
    artifactId: "artifact_playtest_contract",
    path: playtestPath,
    artifactType: "playtest_contract",
    content: playtestContractFixture(),
  });
  assert.equal(validPlaytestResult.status, "completed", validPlaytestResult.error);
  assert.ok(validPlaytestResult.artifactId);

  for (const artifactId of [validGameResult.artifactId, validSceneResult.artifactId, validPlaytestResult.artifactId]) {
    assert.equal(
      artifactReadyForConsumption(kernel, artifactId),
      true,
      `${artifactId} should be schema-valid, compatible, verified, and consumable`,
    );
  }

  assert.ok(existsSync(resolveWorkspacePathTarget(projectId, playtestPath).absolutePath));
  const externallyChangedContract = structuredClone(gameContract);
  externallyChangedContract.identity.title = "Schema Compatible External Tamper";
  writeFileSync(resolveWorkspacePathTarget(projectId, gamePath).absolutePath, `${JSON.stringify(externallyChangedContract, null, 2)}\n`);
  assert.equal(
    artifactReadyForConsumption(kernel, validGameResult.artifactId),
    false,
    "schema-compatible external contract edits must fail current file hash/size evidence",
  );
  await verifyRejectedContractDraftEditing();
  console.log("Contract artifact gates passed: placeholder, schema, revision, compatibility, consumption, isolated draft repair");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

async function verifyRejectedContractDraftEditing() {
  const projectRoot = join(tempRoot, "draft-fixture");
  const path = "agents/qa/contracts/core-loop.playtest-contract.json";
  const gamePath = "agents/design/contracts/game-contract.json";
  const scenePath = "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json";
  const reportPath = "agents/qa/playtest-reports/report-001.md";
  const write = (file, text) => { mkdirSync(dirname(join(projectRoot, file)), { recursive: true }); writeFileSync(join(projectRoot, file), text); };
  const body = (document) => `${JSON.stringify(document, null, 2)}\n`;
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const original = body(playtestContractFixture());
  write(path, original); write(gamePath, body(gameContractFixture())); write(scenePath, body(sceneBlueprintFixture()));
  write(reportPath, "# Server QA report\n");
  const authorization = { mode: "task", taskId: "qa_draft_task", inputArtifactIds: ["game", "scene"], outputArtifactIds: ["test", "report"],
    readRoots: [], serviceReadPaths: [], serviceWritePaths: [], artifacts: [
      { artifactId: "game", type: "game_contract", path: gamePath, ownerAgentId: "game_designer" },
      { artifactId: "scene", type: "scene_blueprint", path: scenePath, ownerAgentId: "cocos_tech_lead" },
      { artifactId: "test", type: "playtest_contract", path, ownerAgentId: "qa_evaluator", sourceTaskId: "qa_draft_task" },
      { artifactId: "report", type: "qa_report", path: reportPath, ownerAgentId: "qa_evaluator", sourceTaskId: "qa_draft_task" }
    ] };
  const operations = join(tempRoot, "draft-operations.jsonl");
  const client = () => {
    const child = spawn(process.execPath, [resolve("apps/api/dist/harnessMcpServer.js")], { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BTP_PROJECT_ROOT: projectRoot, BTP_AGENT_ID: "qa_evaluator", BTP_TOOL_MODE: "task",
        BTP_AUTHORIZATION: JSON.stringify(authorization), BTP_OPERATION_LOG_PATH: operations } });
    let id = 0, stderr = "";
    const pending = new Map();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message.result); pending.delete(message.id); });
    return { call: (name, args) => new Promise((done, reject) => {
      const requestId = ++id, timer = setTimeout(() => reject(new Error(`MCP response timeout: ${stderr}`)), 10000);
      pending.set(requestId, (result) => { clearTimeout(timer); done(result); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`);
    }), close: () => new Promise((done) => { child.once("close", done); child.stdin.end(); reader.close(); }) };
  };
  let mcp = client();
  const errorHash = (result) => { assert.equal(result.isError, true); const matched = /rejectedDraftHash=([a-f0-9]{64})/.exec(result.content[0].text); assert.ok(matched, result.content[0].text); return matched[1]; };
  try {
    const document = { ...playtestContractFixture(), revision: 2, typo: true };
    const firstHash = errorHash(await mcp.call("write_artifact", { path, document }));
    assert.equal(firstHash, hash(body(document)));
    assert.equal(readFileSync(join(projectRoot, path), "utf8"), original, "invalid draft leaves published bytes untouched");
    const patch = { path, source: "last_rejected", expectedHash: firstHash, edits: [{ oldText: ',\n  "typo": true', newText: "" }] };
    const ambiguous = await mcp.call("edit_artifact", { ...patch, edits: [{ oldText: '"type"', newText: '"bad_type"' }] });
    assert.match(ambiguous.content[0].text, /edits\[0\].oldText matches multiple/);
    const missing = await mcp.call("edit_artifact", { ...patch, edits: [{ oldText: "nonexistent_span", newText: "replacement" }] });
    assert.match(missing.content[0].text, /edits\[0\].oldText matches zero/);
    assert.equal((await mcp.call("edit_artifact", { ...patch, expectedHash: "0".repeat(64) })).isError, true, "draft hash is mandatory");
    assert.equal((await mcp.call("edit_artifact", { ...patch, path: gamePath })).isError, true, "draft cannot cross task ownership");
    write(path, original + "\n");
    assert.equal((await mcp.call("edit_artifact", patch)).isError, true, "draft cannot overwrite a concurrently changed published file");
    write(path, original);
    assert.equal((await mcp.call("edit_artifact", patch)).isError, undefined);
    const current = readFileSync(join(projectRoot, path), "utf8");
    assert.equal(JSON.parse(current).revision, 2);
    assert.equal(JSON.parse(current).typo, undefined);
    assert.equal((await mcp.call("edit_artifact", patch)).isError, true, "successful publication clears the rejected draft");
    const sameRevision = { ...JSON.parse(current), typo: true };
    const sameHash = errorHash(await mcp.call("write_artifact", { path, document: sameRevision }));
    const invalidRevision = await mcp.call("edit_artifact", { ...patch, expectedHash: sameHash, edits: [
      ...patch.edits, { oldText: '"title": "Complete the primary objective"', newText: '"title": "Changed without a revision"' }
    ] });
    const nextHash = errorHash(invalidRevision);
    assert.match(invalidRevision.content[0].text, /revision|版本/);
    assert.equal(readFileSync(join(projectRoot, path), "utf8"), current);
    assert.equal((await mcp.call("edit_artifact", { path: reportPath, expectedHash: hash("# Server QA report\n"),
      edits: [{ oldText: "Server QA report", newText: "Forged pass" }] })).isError, true, "QA execution receipts remain protected");
    assert.equal(readFileSync(join(projectRoot, reportPath), "utf8"), "# Server QA report\n");
    await mcp.close(); mcp = client();
    assert.equal((await mcp.call("edit_artifact", { ...patch, expectedHash: nextHash })).isError, true, "drafts do not leak across invocations");
    const completed = readFileSync(operations, "utf8").trim().split("\n").map(JSON.parse).filter((operation) => operation.status === "completed");
    assert.equal(completed.length, 1, "only the fully validated publication becomes successful tool evidence");
    assert.equal(completed[0].hash, hash(current));
  } finally { await mcp.close(); }
}

async function executeSingleWrite(kernel, { agentId, taskId, path, artifactType, content, artifactId }) {
  const message = {
    messageId: `msg_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId: kernel.getRoom(agentId === "game_designer" ? "design-room" : agentId === "qa_evaluator" ? "qa-room" : "engineering-room").roomId,
    senderType: "agent",
    senderId: agentId,
    messageType: "progress_update",
    content: `提交版本化契约。\n\n\`\`\`json\n${JSON.stringify({
      toolRequests: [{
        tool: "write_artifact",
        taskId,
        path,
        artifactType,
        ...(artifactId ? { artifactId } : {}),
        content: `${JSON.stringify(content, null, 2)}\n`,
      }],
    })}\n\`\`\``,
    mentions: [],
    relatedTaskIds: [taskId],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString(),
  };
  const results = await executeAgentToolRequests(kernel, [message]);
  assert.equal(results.length, 1, `expected one parsed tool request for ${agentId}`);
  return results[0];
}

function addOwnedTask(kernel, { taskId, ownerAgentId, outputArtifacts }) {
  const now = new Date().toISOString();
  const roomKind = ownerAgentId === "game_designer"
    ? "design-room"
    : ownerAgentId === "qa_evaluator"
      ? "qa-room"
      : "engineering-room";
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom(roomKind).roomId,
    taskLevel: "task",
    title: taskId,
    description: "Contract gate authorization fixture",
    ownerAgentId,
    participantAgentIds: [],
    status: "doing",
    priority: 1,
    sortOrder: 1,
    progressPercent: 0,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts,
    acceptanceCriteria: ["契约必须由任务负责人写入其声明的输出产物"],
    createdAt: now,
    updatedAt: now,
  });
}

function gameContractFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "game_contract",
    identity: {
      contractId: "contract_gate_game.contract",
      gameId: "contract_gate_game",
      title: "Contract Gate Game",
      slug: "contract-gate-game",
      summary: "A compact fixture for contract artifact gate regression tests.",
      revision: 1,
      releaseVersion: "0.1.0",
    },
    genre: {
      primary: "tap_action",
      tags: ["tap_action", "casual"],
      perspective: "2d",
      playerMode: "single_player",
    },
    coreLoop: {
      summary: "Start, tap the target, and reach the objective.",
      steps: [{
        stepId: "play_loop",
        label: "Play",
        description: "Perform the primary action and observe public progress.",
        actionIds: ["tap_target"],
        stateIds: ["playing"],
        emits: ["score"],
      }],
      successConditions: [{ signalId: "score", operator: "gte", value: 1 }],
      failureConditions: [{ signalId: "health", operator: "eq", value: 0 }],
    },
    stateModel: {
      lifecycle: "finite",
      initialState: "ready",
      states: [
        { stateId: "ready", label: "Ready", kind: "boot", terminal: false, description: "Waiting to start." },
        { stateId: "playing", label: "Playing", kind: "active", terminal: false, description: "Main gameplay loop." },
        { stateId: "won", label: "Won", kind: "success", terminal: true, description: "Objective completed." },
        { stateId: "lost", label: "Lost", kind: "failure", terminal: true, description: "Health depleted." },
      ],
      transitions: [
        { transitionId: "start_game", from: "ready", to: "playing", trigger: { type: "system", ref: "start" }, guards: [], emits: ["round_started"] },
        { transitionId: "complete_goal", from: "playing", to: "won", trigger: { type: "signal", ref: "score" }, guards: [{ signalId: "score", operator: "gte", value: 1 }], emits: [] },
        { transitionId: "deplete_health", from: "playing", to: "lost", trigger: { type: "signal", ref: "health" }, guards: [{ signalId: "health", operator: "eq", value: 0 }], emits: [] },
      ],
    },
    inputModel: {
      actions: [{
        actionId: "tap_target",
        label: "Tap target",
        description: "Tap the current gameplay target.",
        bindings: [{ device: "touch", control: "gameplay_area", gesture: "tap" }],
        enabledInStates: ["playing"],
      }],
      simultaneousTouchPoints: 1,
    },
    runtimeSignals: {
      signals: [
        { signalId: "score", label: "Score", description: "Public objective progress.", valueType: "integer", visibility: "public", initialValue: 0 },
        { signalId: "health", label: "Health", description: "Remaining chances.", valueType: "integer", visibility: "public", initialValue: 3 },
        { signalId: "round_started", label: "Round started", description: "Emitted when play starts.", valueType: "event", visibility: "internal" },
      ],
    },
  };
}

function sceneBlueprintFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "scene_blueprint",
    blueprintId: "contract_gate_game.scenes",
    revision: 1,
    gameContract: { contractId: "contract_gate_game.contract", revision: 1 },
    entrySceneId: "main",
    prefabs: [{
      prefabId: "gameplay_shell",
      source: "assets/prefabs/gameplay-shell.prefab",
      rootNodeId: "prefab_root",
      exposedComponentIds: ["gameplay_presenter"],
    }],
    scenes: [{
      sceneId: "main",
      name: "Main",
      role: "gameplay",
      nodes: [{
        nodeId: "gameplay_root",
        testId: "gameplay_surface",
        name: "GameplayRoot",
        kind: "container",
        prefabId: "gameplay_shell",
        transform: { position: [0, 0], rotation: 0, scale: [1, 1], size: [750, 1334] },
        components: [{
          componentId: "gameplay_presenter",
          type: "GameContractPresenter",
          properties: { accessible: true },
          bindings: [
            { property: "primaryAction", source: { type: "input_action", ref: "tap_target" } },
            { property: "progress", source: { type: "runtime_signal", ref: "score" } },
            { property: "state", source: { type: "game_state", ref: "playing" } },
          ],
          references: [{ property: "gameplayRoot", kind: "node", sceneId: "main", nodeId: "gameplay_root" }],
        }],
        tags: ["gameplay"],
      }],
    }],
  };
}

function playtestContractFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "playtest_contract",
    playtestId: "contract_gate_game.playtest",
    revision: 1,
    gameContract: { contractId: "contract_gate_game.contract", revision: 1 },
    environment: {
      target: "web",
      orientation: "portrait",
      viewport: { width: 750, height: 1334, deviceScaleFactor: 1 },
      maxScenarioDurationMs: 30000,
    },
    scenarios: [{
      scenarioId: "winning_path",
      title: "Complete the primary objective",
      required: true,
      priority: "critical",
      startState: "ready",
      steps: [
        { stepId: "start", required: true, action: { type: "system", command: "start" }, assertions: [{ type: "state", stateId: "playing" }], timeoutMs: 1000 },
        {
          stepId: "act",
          required: true,
          action: { type: "input", actionId: "tap_target", phase: "perform" },
          assertions: [
            { type: "signal", signalId: "score", operator: "gte", expected: 1 },
            { type: "node", testId: "gameplay_surface", expectation: "visible" },
          ],
          repeat: { maxIterations: 3, until: [{ type: "signal", signalId: "score", operator: "gte", expected: 1 }] },
          timeoutMs: 5000,
        },
        { stepId: "finish", required: true, assertions: [{ type: "state", stateId: "won" }], timeoutMs: 1000 },
      ],
      expectedEndState: "won",
      requiredArtifacts: ["screenshot", "runtime_trace"],
    }],
    qualityGates: [{ gateId: "objective_reached", signalId: "score", aggregation: "last", operator: "gte", expected: 1 }],
  };
}
