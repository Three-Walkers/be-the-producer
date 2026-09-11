import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { CocosPlaytestHarness } from "../apps/api/dist/cocosPlaytestHarness.js";
import { CocosEngineBridge } from "../apps/api/dist/cocosEngineBridge.js";
import { readVerifiedQaPlaytestReceipts } from "../apps/api/dist/qaPlaytestReceipt.js";
import { createStudioKernel, defaultAgentContracts } from "../packages/agent-runtime/dist/index.js";
import { captureWorkspaceSnapshot, analyzeHarnessWorkspaceChanges } from "../apps/api/dist/harnessWorkspaceEvidence.js";

const root = mkdtempSync(join(tmpdir(), "btp-qa-launch-"));
const launch = chromium.launch;
const build = CocosEngineBridge.prototype.build;
const put = (path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
  return { path, hash: createHash("sha256").update(body).digest("hex"), sizeBytes: Buffer.byteLength(body) };
};
try {
  const contractPath = "agents/qa/contracts/core-loop.playtest-contract.json";
  const contract = put(contractPath, JSON.stringify({
    schemaVersion: "1.0.0", kind: "playtest_contract", playtestId: "fixture.playtest", revision: 1,
    gameContract: { contractId: "fixture.game", revision: 1 },
    environment: { target: "web", orientation: "adaptive", viewport: { width: 390, height: 844, deviceScaleFactor: 1 }, maxScenarioDurationMs: 10000 },
    scenarios: [{ scenarioId: "start", title: "Start", required: true, priority: "critical", startState: "menu",
      steps: [{ stepId: "start", required: true, action: { type: "system", command: "start" }, assertions: [{ type: "state", stateId: "play" }], timeoutMs: 100 }],
      expectedEndState: "play", requiredArtifacts: ["runtime_trace"] }], qualityGates: []
  }));
  const kernel = createStudioKernel("qa_diagnostic_fixture", "QA fixture", "producer_test", "launch diagnostics");
  const now = new Date().toISOString();
  const reportPath = "agents/qa/playtest-reports/report-001.md";
  kernel.addTask({ taskId: "task_qa", projectId: kernel.project.projectId, stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("qa-room").roomId, taskLevel: "task", ownerAgentId: "qa_evaluator", title: "Playtest", description: "Run",
    status: "doing", priority: 100, sortOrder: 1, inputArtifacts: [], outputArtifacts: ["report"], acceptanceCriteria: [], blockers: [], createdAt: now, updatedAt: now });
  kernel.addArtifact({ artifactId: "report", projectId: kernel.project.projectId, stageId: kernel.project.currentStage, type: "qa_report",
    path: reportPath, ownerAgentId: "qa_evaluator", sourceTaskId: "task_qa", status: "draft", version: 1, sourceDecisionIds: [], metadata: {}, createdAt: now, updatedAt: now });
  const task = kernel.findTask("task_qa");
  const agent = defaultAgentContracts.find((a) => a.agentId === "qa_evaluator");
  let phase;
  CocosEngineBridge.prototype.build = function(input) {
    assert.equal(input.platform, "web-desktop");
    const operationId = `cocos_build_20260911090000_${phase === "scene_load" ? "aaaaaaaa" : "bbbbbbbb"}`;
    const index = put(`${input.outputDir}/index.html`, "<!doctype html><canvas></canvas>");
    const evidence = [put(`${input.outputDir}/build-report.json`, JSON.stringify({ operationId, platform: input.platform, status: "success" })),
      put(`agents/cocos-automation/build-ops/${operationId}.json`, JSON.stringify({ operationId, status: "success" })),
      put(`agents/cocos-automation/cocos-build-logs/${operationId}.log`, "fixture build log")];
    return { ok: true, operationId, operationType: "build", evidence, details: { outputFiles: [index.path] } };
  };
  for (phase of ["scene_load", "runtime_adapter"]) {
    let waits = 0;
    let closed = false;
    chromium.launch = async () => ({
      newPage: async () => ({
        on: (event, callback) => { if (event === "pageerror") callback(new Error("Fixture missing gameplay component")); },
        goto: async () => {}, waitForTimeout: async () => {},
        waitForFunction: async () => { if (++waits === (phase === "scene_load" ? 1 : 2)) throw new Error("Fixture readiness timeout"); },
        screenshot: async ({ path }) => writeFileSync(path, "fixture screenshot")
      }),
      close: async () => { closed = true; }
    });
    const before = captureWorkspaceSnapshot(root);
    const result = await new CocosPlaytestHarness(root, {}).run({ taskInputEvidence: [{ artifactId: "contract", version: 1,
      path: contract.path, evidencePath: contract.path, hash: contract.hash, sizeBytes: contract.sizeBytes }] });
    assert.equal(closed, true, result.summary);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.runtime.consoleErrorCount, 1, "startup errors must never be silently reported as zero");
    assert.match(result.summary, /web-desktop/);
    assert.match(result.summary, /Fixture missing gameplay component/);
    assert.equal(result.defects[0].ownerAgentId, phase === "runtime_adapter" ? "gameplay_programmer" : "cocos_automation");
    const diagnostics = JSON.parse(readFileSync(join(root, result.evidencePaths.find((p) => p.endsWith("launch.json")))));
    assert.equal(diagnostics.phase, phase);
    assert.equal(diagnostics.sceneLoaded, phase === "runtime_adapter");
    assert.ok(result.evidence.some((item) => item.path.endsWith("index.html")), "nested build survives browser failure");
    assert.equal(readVerifiedQaPlaytestReceipts(root).at(-1).result.verdict, "blocked");
    const operations = result.evidence.map((item) => ({ ...item, toolName: "run_playtest", status: "completed", operationType: "playtest", operationId: result.operationId }));
    const after = captureWorkspaceSnapshot(root);
    const analyze = (ops) => analyzeHarnessWorkspaceChanges(kernel, task, agent, before, after, undefined, ops, { authoritativeWorkspace: true });
    assert.deepEqual(analyze(operations).violations, []);
    assert.ok(analyze(operations.map((op) => ({ ...op, toolName: "write_artifact" }))).violations.length > 0);
    assert.ok(analyze(operations.map((op) => ({ ...op, hash: "0".repeat(64) }))).violations.length > 0);
    assert.ok(analyze(operations.map((op) => ({ ...op, operationId: "playtest_20260911090000_ffffffff" }))).violations.length > 0);
    const extra = put("shared/build-artifacts/playtest/unreceipted/game.js", `unauthorized ${phase}`);
    const source = put("assets/scripts/gameplay/forbidden.ts", `unauthorized ${phase}`);
    assert.ok(analyzeHarnessWorkspaceChanges(kernel, task, agent, after, captureWorkspaceSnapshot(root), undefined,
      [...operations, ...[extra, source].map((item) => ({ ...item, toolName: "run_playtest", status: "completed", operationType: "playtest", operationId: result.operationId }))],
      { authoritativeWorkspace: true }).violations.length >= 2, "no general output-directory or source authorization");
  }
  console.log("QA launch diagnostics passed: nested build preservation, byte-bound service scope, console/screenshot evidence, phase-based ownership, blocked remains blocked.");
} finally {
  chromium.launch = launch;
  CocosEngineBridge.prototype.build = build;
  rmSync(root, { recursive: true, force: true });
}
