import assert from "node:assert/strict";
import {
  ContractValidationError,
  parseProductionContractBundle,
  validateGameContract,
  validatePlaytestContractCompatibility,
} from "../packages/shared-schemas/dist/index.js";

function fixture({ id, title, genre, actionId, signalId, signalType, target, operator }) {
  const gameContract = {
    schemaVersion: "1.0.0",
    kind: "game_contract",
    identity: {
      contractId: `${id}.contract`,
      gameId: id,
      title,
      slug: id.replaceAll("_", "-"),
      summary: `${title} fixture used to prove the production contracts are genre-neutral.`,
      revision: 1,
      releaseVersion: "0.1.0",
    },
    genre: { primary: genre, tags: [genre, "casual"], perspective: "2d", playerMode: "single_player" },
    coreLoop: {
      summary: `Start, perform ${actionId}, observe progress, and reach the goal.`,
      steps: [{
        stepId: "play_loop",
        label: "Play",
        description: "Perform the genre-specific action and observe public progress.",
        actionIds: [actionId],
        stateIds: ["playing"],
        emits: [signalId],
      }],
      successConditions: [{ signalId, operator, value: target }],
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
        { transitionId: "complete_goal", from: "playing", to: "won", trigger: { type: "signal", ref: signalId }, guards: [{ signalId, operator, value: target }], emits: [] },
        { transitionId: "deplete_health", from: "playing", to: "lost", trigger: { type: "signal", ref: "health" }, guards: [{ signalId: "health", operator: "eq", value: 0 }], emits: [] },
      ],
    },
    inputModel: {
      actions: [{
        actionId,
        label: actionId.replaceAll("_", " "),
        description: "Primary player action for this genre.",
        bindings: [{ device: "touch", control: "gameplay_area", gesture: "tap" }],
        enabledInStates: ["playing"],
      }],
      simultaneousTouchPoints: 1,
    },
    runtimeSignals: {
      signals: [
        { signalId, label: "Objective progress", description: "Public goal progress.", valueType: signalType, visibility: "public", initialValue: signalType === "boolean" ? false : 0 },
        { signalId: "health", label: "Health", description: "Remaining chances.", valueType: "integer", visibility: "public", initialValue: 3, unit: "points" },
        { signalId: "round_started", label: "Round started", description: "Emitted when play starts.", valueType: "event", visibility: "internal" },
      ],
    },
  };

  const sceneBlueprint = {
    schemaVersion: "1.0.0",
    kind: "scene_blueprint",
    blueprintId: `${id}.scenes`,
    revision: 1,
    gameContract: { contractId: `${id}.contract`, revision: 1 },
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
          properties: { fixtureGenre: genre, accessible: true },
          bindings: [
            { property: "primaryAction", source: { type: "input_action", ref: actionId } },
            { property: "progress", source: { type: "runtime_signal", ref: signalId } },
            { property: "state", source: { type: "game_state", ref: "playing" } },
          ],
          references: [
            { property: "gameplayRoot", kind: "node", sceneId: "main", nodeId: "gameplay_root" },
            { property: "presenter", kind: "component", sceneId: "main", nodeId: "gameplay_root", componentId: "gameplay_presenter" },
            { property: "shellPrefab", kind: "prefab", prefabId: "gameplay_shell" },
          ],
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
    gameContract: { contractId: `${id}.contract`, revision: 1 },
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
          action: { type: "input", actionId, phase: "perform" },
          assertions: [
            { type: "signal", signalId, operator, expected: target },
            { type: "node", testId: "gameplay_surface", expectation: "visible" },
          ],
          repeat: { maxIterations: 3, until: [{ type: "signal", signalId, operator, expected: target }] },
          timeoutMs: 5000,
        },
        { stepId: "finish", required: true, assertions: [{ type: "state", stateId: "won" }], timeoutMs: 1000 },
      ],
      expectedEndState: "won",
      requiredArtifacts: ["screenshot", "runtime_trace"],
    }],
    qualityGates: [{ gateId: "objective_reached", signalId, aggregation: "last", operator, expected: target }],
  };
  return { gameContract, sceneBlueprint, playtestContract };
}

const fixtures = [
  fixture({ id: "tap_defense", title: "Tap Defense", genre: "tap_defense", actionId: "intercept_target", signalId: "interception_count", signalType: "integer", target: 3, operator: "gte" }),
  fixture({ id: "tile_puzzle", title: "Tile Puzzle", genre: "puzzle", actionId: "select_tile", signalId: "puzzle_solved", signalType: "boolean", target: true, operator: "eq" }),
  fixture({ id: "sky_runner", title: "Sky Runner", genre: "runner", actionId: "jump", signalId: "distance", signalType: "number", target: 1000, operator: "gte" }),
];

for (const bundle of fixtures) {
  assert.deepEqual(parseProductionContractBundle(bundle), bundle);
}

const endlessContract = structuredClone(fixtures[2].gameContract);
endlessContract.stateModel.lifecycle = "endless";
endlessContract.stateModel.states = endlessContract.stateModel.states.filter((state) => state.stateId === "ready" || state.stateId === "playing");
endlessContract.stateModel.transitions = endlessContract.stateModel.transitions.filter((transition) => transition.transitionId === "start_game");
endlessContract.coreLoop.successConditions = [];
endlessContract.coreLoop.failureConditions = [];
assert.equal(validateGameContract(endlessContract).ok, true, "endless games do not require terminal states");

const restartingContract = structuredClone(fixtures[0].gameContract);
restartingContract.stateModel.transitions.push({
  transitionId: "restart_after_win",
  from: "won",
  to: "ready",
  trigger: { type: "system", ref: "restart" },
  guards: [],
  emits: [],
});
assert.equal(validateGameContract(restartingContract).ok, true, "terminal states may explicitly restart");
const resultActionsContract = structuredClone(restartingContract);
resultActionsContract.inputModel.actions.push({ actionId: "retry_level", label: "Retry", description: "Reset and retry this level.",
  bindings: [{ device: "touch", control: "retry_button", gesture: "tap" }], enabledInStates: ["won", "lost"] });
resultActionsContract.stateModel.transitions.push({ transitionId: "retry_after_loss", from: "lost", to: "playing",
  trigger: { type: "input", ref: "retry_level" }, guards: [], emits: ["round_started"] });
assert.equal(validateGameContract(resultActionsContract).ok, true, "result panels can retry a level without visiting the global main menu");
const autoTerminalExit = structuredClone(resultActionsContract);
autoTerminalExit.stateModel.transitions.at(-1).trigger = { type: "signal", ref: "round_started" };
assert.equal(validateGameContract(autoTerminalExit).ok, false, "background signals must not silently leave result panels");
const disabledTerminalExit = structuredClone(resultActionsContract);
disabledTerminalExit.inputModel.actions.at(-1).enabledInStates = ["playing"];
assert.equal(validateGameContract(disabledTerminalExit).ok, false, "a result-panel exit must be enabled there");
const terminalToTerminal = structuredClone(resultActionsContract);
terminalToTerminal.stateModel.transitions.at(-1).to = "won";
assert.equal(validateGameContract(terminalToTerminal).ok, false, "retry cannot change defeat into victory");

const withTypo = structuredClone(fixtures[0].gameContract);
withTypo.identity.revison = 2;
const typoResult = validateGameContract(withTypo);
assert.equal(typoResult.ok, false);
assert.ok(!typoResult.ok && typoResult.issues.some((entry) => entry.code === "unknown_property"));
assert.throws(() => parseProductionContractBundle({ ...fixtures[0], gameContract: withTypo }), ContractValidationError);

const privateSignalPlaytest = structuredClone(fixtures[0].playtestContract);
privateSignalPlaytest.scenarios[0].steps[1].assertions[0].signalId = "round_started";
privateSignalPlaytest.scenarios[0].steps[1].assertions[0].operator = "exists";
delete privateSignalPlaytest.scenarios[0].steps[1].assertions[0].expected;
const privateResult = validatePlaytestContractCompatibility(privateSignalPlaytest, fixtures[0].gameContract, fixtures[0].sceneBlueprint);
assert.equal(privateResult.ok, false);
assert.ok(!privateResult.ok && privateResult.issues.some((entry) => entry.message.includes("public signals")));

const privateSignalScene = structuredClone(fixtures[0]);
privateSignalScene.sceneBlueprint.scenes[0].nodes[0].components[0].bindings[1].source.ref = "round_started";
assert.throws(() => parseProductionContractBundle(privateSignalScene), ContractValidationError);

const unboundedRepeat = structuredClone(fixtures[0]);
unboundedRepeat.playtestContract.scenarios[0].steps[1].repeat.maxIterations = 101;
assert.throws(() => parseProductionContractBundle(unboundedRepeat), ContractValidationError);

const conflictingComponentProperty = structuredClone(fixtures[0]);
conflictingComponentProperty.sceneBlueprint.scenes[0].nodes[0].components[0].bindings[0].property = "fixtureGenre";
assert.throws(() => parseProductionContractBundle(conflictingComponentProperty), ContractValidationError);

const unsafeComponentProperty = structuredClone(fixtures[0]);
unsafeComponentProperty.sceneBlueprint.scenes[0].nodes[0].components[0].references[0].property = "__proto__";
assert.throws(() => parseProductionContractBundle(unsafeComponentProperty), ContractValidationError);

console.log("Game contract fixtures passed: tap-defense, puzzle, runner");
