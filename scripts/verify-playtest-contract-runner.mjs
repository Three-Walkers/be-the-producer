import assert from "node:assert/strict";

const { runPlaytestContract } = await import("../apps/api/dist/playtestContractRunner.js");

class FakeAdapter {
  constructor(contract, initialState, reducer, signals = {}) {
    this.contract = contract;
    this.state = initialState;
    this.reducer = reducer;
    this.signals = { ...signals };
    this.sequence = 0;
    this.initialState = initialState;
    this.initialSignals = { ...signals };
  }

  async getHandshake() {
    return {
      protocolVersion: "1.0.0",
      playtestId: this.contract.playtestId,
      revision: this.contract.revision,
      contractHash: "fixture-hash"
    };
  }

  async getSnapshot() {
    return {
      sequence: this.sequence,
      timestampMs: this.sequence,
      state: this.state,
      signals: { ...this.signals },
      nodes: {},
      recentEvents: []
    };
  }

  async perform(action) {
    if (action.type === "wait") return { ok: true };
    this.sequence += 1;
    this.reducer(this, action);
    return { ok: true };
  }

  async wait() {}

  async reset() {
    this.state = this.initialState;
    this.signals = { ...this.initialSignals };
    this.sequence = 0;
  }
}

class SlowAdapter extends FakeAdapter {
  async perform(action) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    return super.perform(action);
  }
}

class HungAdapter extends FakeAdapter {
  async perform() {
    return await new Promise(() => undefined);
  }
}

const environment = {
  target: "web",
  orientation: "adaptive",
  viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
  maxScenarioDurationMs: 10_000
};

function contract(playtestId, gameId, scenario, qualityGates = []) {
  return {
    schemaVersion: "1.0.0",
    kind: "playtest_contract",
    playtestId,
    revision: 1,
    gameContract: { contractId: gameId, revision: 1 },
    environment,
    scenarios: [scenario],
    qualityGates
  };
}

const tapContract = contract("tap.defence", "tap.game", {
  scenarioId: "complete.round",
  title: "Complete one tap round",
  required: true,
  priority: "critical",
  startState: "MENU",
  steps: [
    {
      stepId: "start",
      required: true,
      action: { type: "system", command: "start" },
      assertions: [{ type: "state", stateId: "ACTIVE" }],
      timeoutMs: 100
    },
    {
      stepId: "tap.until.win",
      required: true,
      action: { type: "input", actionId: "tap.target", phase: "perform" },
      assertions: [{ type: "signal", signalId: "score", operator: "gte", expected: 3 }],
      repeat: { maxIterations: 5, until: [{ type: "state", stateId: "WIN" }] },
      timeoutMs: 100
    }
  ],
  expectedEndState: "WIN",
  requiredArtifacts: ["runtime_trace"]
}, [{ gateId: "score.minimum", signalId: "score", aggregation: "max", operator: "gte", expected: 3 }]);

const tapAdapter = new FakeAdapter(tapContract, "MENU", (adapter, action) => {
  if (action.type === "system") adapter.state = "ACTIVE";
  if (action.type === "input") {
    adapter.signals.score = Number(adapter.signals.score ?? 0) + 1;
    if (adapter.signals.score >= 3) adapter.state = "WIN";
  }
}, { score: 0 });

const puzzleContract = contract("puzzle.solve", "puzzle.game", {
  scenarioId: "solve.board",
  title: "Solve a puzzle",
  required: true,
  priority: "critical",
  startState: "SOLVING",
  steps: [{
    stepId: "move.until.complete",
    required: true,
    action: { type: "input", actionId: "move.tile", phase: "perform" },
    assertions: [{ type: "signal", signalId: "moves", operator: "lte", expected: 4 }],
    repeat: { maxIterations: 4, until: [{ type: "state", stateId: "COMPLETE" }] },
    timeoutMs: 100
  }],
  expectedEndState: "COMPLETE",
  requiredArtifacts: ["runtime_trace"]
});

const puzzleAdapter = new FakeAdapter(puzzleContract, "SOLVING", (adapter) => {
  adapter.signals.moves = Number(adapter.signals.moves ?? 0) + 1;
  if (adapter.signals.moves >= 4) adapter.state = "COMPLETE";
}, { moves: 0 });

const endlessContract = contract("endless.progress", "idle.game", {
  scenarioId: "gain.progress",
  title: "Gain progress without a terminal state",
  required: true,
  priority: "high",
  startState: "RUNNING",
  steps: [{
    stepId: "collect.until.progress",
    required: true,
    action: { type: "input", actionId: "collect", phase: "perform" },
    assertions: [{ type: "signal", signalId: "progress", operator: "gte", expected: 2 }],
    repeat: { maxIterations: 2, until: [{ type: "signal", signalId: "progress", operator: "gte", expected: 2 }] },
    timeoutMs: 100
  }],
  expectedEndState: "RUNNING",
  requiredArtifacts: ["runtime_trace"]
});

const endlessAdapter = new FakeAdapter(endlessContract, "RUNNING", (adapter) => {
  adapter.signals.progress = Number(adapter.signals.progress ?? 0) + 1;
}, { progress: 0 });

for (const [name, testContract, adapter] of [
  ["tap", tapContract, tapAdapter],
  ["puzzle", puzzleContract, puzzleAdapter],
  ["endless", endlessContract, endlessAdapter]
]) {
  const result = await runPlaytestContract({ contract: testContract, contractHash: "fixture-hash", adapter, pollIntervalMs: 1 });
  assert.equal(result.passed, true, `${name} contract should pass without changing the runner`);
  assert.equal(result.hashVerified, true);
  assert.equal(result.scenarios[0].passed, true);
}

const wrongHandshake = new FakeAdapter(tapContract, "MENU", () => undefined, { score: 0 });
wrongHandshake.getHandshake = async () => ({
  protocolVersion: "1.0.0",
  playtestId: "wrong.id",
  revision: 1,
  contractHash: "fixture-hash"
});
await assert.rejects(
  runPlaytestContract({ contract: tapContract, contractHash: "fixture-hash", adapter: wrongHandshake }),
  /id 不匹配/,
  "a present contract must not silently fall back when the runtime handshake is wrong"
);

const missingHashHandshake = new FakeAdapter(tapContract, "MENU", () => undefined, { score: 0 });
missingHashHandshake.getHandshake = async () => ({
  protocolVersion: "1.0.0",
  playtestId: tapContract.playtestId,
  revision: tapContract.revision
});
await assert.rejects(
  runPlaytestContract({ contract: tapContract, contractHash: "fixture-hash", adapter: missingHashHandshake }),
  /缺少 contractHash/,
  "a runtime build must prove it consumed the exact PlaytestContract content"
);

const twoScenarioContract = {
  ...endlessContract,
  playtestId: "multi.scenario",
  scenarios: [
    endlessContract.scenarios[0],
    {
      ...endlessContract.scenarios[0],
      scenarioId: "gain.progress.again",
      title: "A second isolated scenario"
    },
    {
      ...endlessContract.scenarios[0],
      scenarioId: "optional.failure",
      title: "An optional failure must not block the verdict",
      required: false,
      expectedEndState: "IMPOSSIBLE"
    }
  ]
};
const twoScenarioAdapter = new FakeAdapter(twoScenarioContract, "RUNNING", (adapter) => {
  adapter.signals.progress = Number(adapter.signals.progress ?? 0) + 1;
}, { progress: 0 });
const multiResult = await runPlaytestContract({
  contract: twoScenarioContract,
  contractHash: "fixture-hash",
  adapter: twoScenarioAdapter,
  pollIntervalMs: 1
});
assert.equal(multiResult.scenarios[0].initialState, "RUNNING");
assert.equal(multiResult.scenarios[1].initialState, "RUNNING", "each scenario must start from a reset runtime");
assert.equal(multiResult.scenarios[1].passed, true);
assert.equal(multiResult.scenarios[2].passed, false);
assert.equal(multiResult.passed, true, "optional scenario failure must not block the overall verdict");

const watchdogContract = {
  ...endlessContract,
  playtestId: "scenario.watchdog",
  environment: { ...environment, maxScenarioDurationMs: 5 },
  scenarios: [{
    ...endlessContract.scenarios[0],
    steps: [{ ...endlessContract.scenarios[0].steps[0], timeoutMs: 5 }]
  }]
};
const slowAdapter = new SlowAdapter(watchdogContract, "RUNNING", (adapter) => {
  adapter.signals.progress = Number(adapter.signals.progress ?? 0) + 1;
}, { progress: 0 });
const watchdogResult = await runPlaytestContract({
  contract: watchdogContract,
  contractHash: "fixture-hash",
  adapter: slowAdapter,
  pollIntervalMs: 1
});
assert.equal(watchdogResult.passed, false, "scenario absolute watchdog must fail over-budget adapter work");
assert.match(watchdogResult.scenarios[0].steps[0].details, /预算/);

const hungContract = {
  ...watchdogContract,
  playtestId: "scenario.hung-promise",
  environment: { ...environment, maxScenarioDurationMs: 20 },
  scenarios: [{
    ...watchdogContract.scenarios[0],
    steps: [{ ...watchdogContract.scenarios[0].steps[0], timeoutMs: 20 }]
  }]
};
const hungAdapter = new HungAdapter(hungContract, "RUNNING", () => undefined, { progress: 0 });
const hungStartedAt = Date.now();
const hungResult = await runPlaytestContract({
  contract: hungContract,
  contractHash: "fixture-hash",
  adapter: hungAdapter,
  pollIntervalMs: 1
});
assert.equal(hungResult.passed, false, "an adapter promise that never settles must be cut off by the watchdog");
assert.match(hungResult.scenarios[0].steps[0].details, /预算/);
assert.ok(Date.now() - hungStartedAt < 500, "watchdog must return instead of hanging on the runtime promise");

process.stdout.write("PlaytestContract runner smoke passed: tap, puzzle, endless, scenario isolation, optional failure, hard watchdog, and handshake rejection\n");
