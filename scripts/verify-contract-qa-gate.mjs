import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "be-the-producer-contract-qa-gate-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { createStudioKernel } = await import("../packages/agent-runtime/dist/index.js");
const { artifactReadyForConsumption, taskOutputsVerified } = await import("../apps/api/dist/taskOutputEvidence.js");
const { reconcileQaPlaytestResults } = await import("../apps/api/dist/qaResultIngestion.js");
const { writeQaPlaytestReceipt } = await import("../apps/api/dist/qaPlaytestReceipt.js");
const { renderPlaytestMarker } = await import("../apps/api/dist/playtestEvidence.js");

try {
  const current = createContractQaCase("current", true);
  assert.equal(
    taskOutputsVerified(current.kernel, current.kernel.findTask(current.taskId)),
    true,
    "a v2 QA report bound to the current PlaytestContract should be consumable when every required scenario passes",
  );

  const staleBuild = createContractQaCase("stale_build", true);
  assert.equal(taskOutputsVerified(staleBuild.kernel, staleBuild.kernel.findTask(staleBuild.taskId)), true);
  materializeBuild(staleBuild.kernel, staleBuild.buildArtifactId, staleBuild.buildRootPath, "bundle-v2\n");
  assert.equal(artifactReadyForConsumption(staleBuild.kernel, staleBuild.buildArtifactId), true);
  assert.equal(
    taskOutputsVerified(staleBuild.kernel, staleBuild.kernel.findTask(staleBuild.taskId)),
    false,
    "QA evidence tested against the previous build digest must become stale when the build changes",
  );

  const previousContractHash = current.contractEvidence.hash;
  const revisedPlaytestContract = structuredClone(current.playtestContract);
  revisedPlaytestContract.revision = 2;
  const revisedArtifact = materializeArtifact(current.kernel, {
    artifactId: current.playtestArtifactId,
    type: "playtest_contract",
    path: current.playtestPath,
    ownerAgentId: "qa_evaluator",
    content: json(revisedPlaytestContract),
  });
  const revisedLedger = current.kernel.listArtifactLedger().find((entry) => entry.artifactId === revisedArtifact.artifactId);
  assert.ok(revisedLedger?.hash);
  assert.notEqual(revisedLedger.hash, previousContractHash, "revision advance must produce a different current contract hash");
  assert.equal(artifactReadyForConsumption(current.kernel, revisedArtifact.artifactId), true, "the revised contract itself should remain valid and consumable");
  assert.equal(
    taskOutputsVerified(current.kernel, current.kernel.findTask(current.taskId)),
    false,
    "a report bound to the previous PlaytestContract revision/hash must not be consumable",
  );

  const failedRequiredScenario = createContractQaCase("required_scenario_failed", false);
  assert.equal(
    taskOutputsVerified(failedRequiredScenario.kernel, failedRequiredScenario.kernel.findTask(failedRequiredScenario.taskId)),
    false,
    "a pass verdict must not bypass a failed required contract scenario",
  );

  process.stdout.write(
    "Contract QA gate passed: current v2 evidence consumed; stale contract and failed required scenario rejected\n",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function createContractQaCase(caseId, requiredScenarioPassed) {
  const projectId = `contract_qa_gate_${caseId}`;
  const kernel = createStudioKernel(projectId, `Contract QA ${caseId}`, "producer_test", "验证 v2 契约试玩门禁");
  const projectRoot = join(process.env.STUDIO_WORKSPACE_ROOT, projectId);
  const contracts = contractFixtures(projectId);

  materializeArtifact(kernel, {
    artifactId: `artifact_${caseId}_game_contract`,
    type: "game_contract",
    path: "agents/design/contracts/game-contract.json",
    ownerAgentId: "game_designer",
    content: json(contracts.gameContract),
  });
  materializeArtifact(kernel, {
    artifactId: `artifact_${caseId}_scene_blueprint`,
    type: "scene_blueprint",
    path: "agents/engineering/contracts/scene-blueprint.json",
    ownerAgentId: "cocos_tech_lead",
    content: json(contracts.sceneBlueprint),
  });
  const playtestPath = "agents/qa/contracts/core-loop.playtest-contract.json";
  const playtestArtifactId = `artifact_${caseId}_playtest_contract`;
  materializeArtifact(kernel, {
    artifactId: playtestArtifactId,
    type: "playtest_contract",
    path: playtestPath,
    ownerAgentId: "qa_evaluator",
    content: json(contracts.playtestContract),
  });
  assert.equal(artifactReadyForConsumption(kernel, playtestArtifactId), true);
  const buildArtifactId = `artifact_${caseId}_tested_build`;
  const buildRootPath = `shared/build-artifacts/playtest/${caseId}`;
  materializeBuild(kernel, buildArtifactId, buildRootPath, "bundle-v1\n");
  assert.equal(artifactReadyForConsumption(kernel, buildArtifactId), true);

  const taskId = `task_${caseId}_contract_qa`;
  const reportArtifactId = `artifact_${caseId}_qa_report`;
  const reportPath = `agents/qa/playtest-reports/${caseId}.md`;
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("qa-room").roomId,
    taskLevel: "task",
    ownerAgentId: "qa_evaluator",
    title: "执行契约驱动试玩",
    description: "通过 Runtime Adapter 执行 PlaytestContract 并保存受保护证据。",
    status: "doing",
    priority: 100,
    sortOrder: 1,
    progressPercent: 50,
    childrenSummary: emptySummary(),
    inputArtifacts: [playtestArtifactId, buildArtifactId],
    outputArtifacts: [reportArtifactId],
    acceptanceCriteria: ["当前 PlaytestContract 的全部 required scenarios 通过"],
    blockers: [],
    createdAt: now,
    updatedAt: now,
  });
  kernel.addArtifact({
    artifactId: reportArtifactId,
    projectId,
    type: "qa_report",
    path: reportPath,
    ownerAgentId: "qa_evaluator",
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });

  const contractEvidence = fileEvidence(projectRoot, playtestPath);
  const evidencePaths = [
    `agents/qa/playtest-runs/${caseId}/scenario.png`,
    `agents/qa/playtest-runs/${caseId}/runtime-trace.json`,
    `agents/qa/playtest-runs/${caseId}/console.json`,
    `agents/qa/playtest-runs/${caseId}/contract-result.json`,
  ];
  for (const [index, path] of evidencePaths.entries()) {
    writeWorkspaceFile(projectRoot, path, `contract-evidence-${caseId}-${index}\n`);
  }

  const operationId = `playtest_contract_${caseId}`;
  const result = {
    schemaVersion: 2,
    operationId,
    verdict: "pass",
    completedAt: now,
    checks: ["launch", "adapter_handshake", "contract_conformance", "console_errors"].map((checkId) => ({
      checkId,
      label: checkId,
      status: "passed",
      details: "verified by contract runner",
    })),
    defects: [],
    evidencePaths,
    contract: {
      schemaVersion: "1.0.0",
      playtestId: contracts.playtestContract.playtestId,
      revision: contracts.playtestContract.revision,
      path: playtestPath,
      hash: contractEvidence.hash,
      sizeBytes: contractEvidence.sizeBytes,
      runtimeProtocol: "1.0.0",
      adapterMode: "runtime_adapter",
      runtimeContractHash: contractEvidence.hash,
      hashVerified: true,
    },
    scenarios: [{
      scenarioId: "winning_path",
      title: "Complete the primary objective",
      required: true,
      passed: requiredScenarioPassed,
      initialState: "ready",
      finalState: requiredScenarioPassed ? "won" : "playing",
      requiredStepIds: ["start", "act", "finish"],
      passedStepIds: requiredScenarioPassed ? ["start", "act", "finish"] : ["start"],
      evidencePaths,
      details: requiredScenarioPassed ? "all required steps passed" : "required action assertion failed",
    }],
    runtime: {
      initialState: "ready",
      playingState: "playing",
      ...(requiredScenarioPassed ? { terminalState: "won" } : {}),
      consoleErrorCount: 0,
      durationMs: 250,
    },
  };
  writeWorkspaceFile(projectRoot, reportPath, `# Contract QA Report\n\n${renderPlaytestMarker(result)}\n`);
  const receiptEvidence = [reportPath, ...evidencePaths].map((path) => fileEvidence(projectRoot, path));
  const buildLedger = kernel.listArtifactLedger().find((entry) => entry.artifactId === buildArtifactId);
  const playtestInputReceipt = [{
    artifactId: playtestArtifactId,
    version: kernel.listArtifacts().find((artifact) => artifact.artifactId === playtestArtifactId).version,
    path: playtestPath,
    evidencePath: playtestPath,
    hash: contractEvidence.hash,
    sizeBytes: contractEvidence.sizeBytes,
  }, {
    artifactId: buildArtifactId,
    version: kernel.listArtifacts().find((artifact) => artifact.artifactId === buildArtifactId).version,
    path: buildRootPath,
    evidencePath: buildLedger.path,
    hash: buildLedger.hash,
    sizeBytes: buildLedger.sizeBytes,
    directoryManifestDigest: buildLedger.directoryManifest.digest,
  }].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  writeQaPlaytestReceipt(projectRoot, reportPath, result, receiptEvidence, playtestInputReceipt);
  assert.deepEqual(reconcileQaPlaytestResults(kernel).processedOperationIds, [operationId]);

  return {
    kernel,
    taskId,
    playtestArtifactId,
    playtestPath,
    playtestContract: contracts.playtestContract,
    contractEvidence,
    buildArtifactId,
    buildRootPath,
  };
}

function materializeBuild(kernel, artifactId, rootPath, bundleContent) {
  const now = new Date().toISOString();
  const bundlePath = `${rootPath}/game.js`;
  const reportPath = `${rootPath}/build-report.json`;
  writeWorkspaceFile(join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId), bundlePath, bundleContent);
  const bundle = fileEvidence(join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId), bundlePath);
  const files = [bundle];
  const digest = createHash("sha256")
    .update(files.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.hash}\n`).join(""))
    .digest("hex");
  const reportContent = json({ status: "success", outputPath: rootPath, outputManifest: { schemaVersion: 1, rootPath, files, digest } });
  writeWorkspaceFile(join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId), reportPath, reportContent);
  const report = fileEvidence(join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId), reportPath);
  const existing = kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type: "build",
    path: rootPath,
    ownerAgentId: "cocos_automation",
    stageId: kernel.project.currentStage,
    status: "submitted",
    version: (existing?.version ?? 0) + 1,
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: { ...(existing?.metadata ?? {}), toolName: "cocos_build", toolExecutedAt: now, bridgeOperationId: `build_${artifactId}_${Date.now()}`, bridgeOk: true },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: reportPath,
    hash: report.hash,
    sizeBytes: report.sizeBytes,
    materializedAt: now,
    directoryManifest: { schemaVersion: 1, rootPath, files, digest },
  });
}

function materializeArtifact(kernel, { artifactId, type, path, ownerAgentId, content }) {
  const now = new Date().toISOString();
  const projectId = kernel.project.projectId;
  const projectRoot = join(process.env.STUDIO_WORKSPACE_ROOT, projectId);
  writeWorkspaceFile(projectRoot, path, content);
  const body = Buffer.from(content);
  const existing = kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId,
    type,
    path,
    ownerAgentId,
    stageId: kernel.project.currentStage,
    status: "submitted",
    version: (existing?.version ?? 0) + 1,
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: {
      ...(existing?.metadata ?? {}),
      toolName: "write_artifact",
      toolExecutedAt: now,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path,
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength,
    materializedAt: now,
  });
  return artifact;
}

function contractFixtures(id) {
  const contractId = `${id}.contract`;
  const gameContract = {
    schemaVersion: "1.0.0",
    kind: "game_contract",
    identity: {
      contractId,
      gameId: id,
      title: "Contract QA Fixture",
      slug: id.replaceAll("_", "-"),
      summary: "A compact fixture for contract-bound QA evidence regression tests.",
      revision: 1,
      releaseVersion: "0.1.0",
    },
    genre: { primary: "tap_action", tags: ["tap_action", "casual"], perspective: "2d", playerMode: "single_player" },
    coreLoop: {
      summary: "Start, perform the primary action, and reach the objective.",
      steps: [{
        stepId: "play_loop",
        label: "Play",
        description: "Tap the gameplay target and observe public progress.",
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
  const sceneBlueprint = {
    schemaVersion: "1.0.0",
    kind: "scene_blueprint",
    blueprintId: `${id}.scenes`,
    revision: 1,
    gameContract: { contractId, revision: 1 },
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
  const playtestContract = {
    schemaVersion: "1.0.0",
    kind: "playtest_contract",
    playtestId: `${id}.playtest`,
    revision: 1,
    gameContract: { contractId, revision: 1 },
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
  return { gameContract, sceneBlueprint, playtestContract };
}

function writeWorkspaceFile(projectRoot, path, content) {
  const absolutePath = join(projectRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function fileEvidence(projectRoot, path) {
  const body = readFileSync(join(projectRoot, path));
  return {
    path,
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength,
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function emptySummary() {
  return { doing: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 };
}
