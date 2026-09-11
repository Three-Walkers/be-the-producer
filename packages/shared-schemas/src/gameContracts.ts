/**
 * Versioned, engine-neutral contracts shared by design, implementation, and QA.
 *
 * The validators in this module intentionally have no runtime dependencies. They
 * reject unknown properties so a misspelled or newer field cannot silently turn
 * into an unenforced production requirement.
 */

export const GAME_CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export const SCENE_BLUEPRINT_SCHEMA_VERSION = "1.0.0" as const;
export const PLAYTEST_CONTRACT_SCHEMA_VERSION = "1.0.0" as const;

export type GameContractSchemaVersion = typeof GAME_CONTRACT_SCHEMA_VERSION;
export type SceneBlueprintSchemaVersion = typeof SCENE_BLUEPRINT_SCHEMA_VERSION;
export type PlaytestContractSchemaVersion = typeof PLAYTEST_CONTRACT_SCHEMA_VERSION;

export type ContractJsonValue =
  | string
  | number
  | boolean
  | null
  | ContractJsonValue[]
  | { [key: string]: ContractJsonValue };

export interface GameIdentity {
  contractId: string;
  gameId: string;
  title: string;
  slug: string;
  summary: string;
  revision: number;
  releaseVersion: string;
}

export interface GameGenre {
  primary: string;
  tags: string[];
  perspective: "2d" | "2.5d" | "3d";
  playerMode: "single_player" | "local_multiplayer" | "online_multiplayer";
}

export type RuntimeConditionOperator =
  | "eq"
  | "not_eq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

export interface RuntimeCondition {
  signalId: string;
  operator: RuntimeConditionOperator;
  value?: string | number | boolean;
}

export interface CoreLoopStep {
  stepId: string;
  label: string;
  description: string;
  actionIds: string[];
  stateIds: string[];
  emits: string[];
}

export interface GameCoreLoop {
  summary: string;
  steps: CoreLoopStep[];
  successConditions: RuntimeCondition[];
  failureConditions: RuntimeCondition[];
}

export type GameStateKind = "boot" | "active" | "paused" | "success" | "failure";

export interface GameStateDefinition {
  stateId: string;
  label: string;
  kind: GameStateKind;
  terminal: boolean;
  description: string;
}

export type StateTransitionTrigger =
  | { type: "input"; ref: string }
  | { type: "signal"; ref: string }
  | { type: "timer"; afterMs: number }
  | { type: "system"; ref: "start" | "restart" | "pause" | "resume" };

export interface GameStateTransition {
  transitionId: string;
  from: string;
  to: string;
  trigger: StateTransitionTrigger;
  guards: RuntimeCondition[];
  emits: string[];
}

export interface GameStateModel {
  lifecycle: "finite" | "endless";
  initialState: string;
  states: GameStateDefinition[];
  transitions: GameStateTransition[];
}

export type InputDevice = "touch" | "mouse" | "keyboard" | "gamepad" | "virtual";

export interface InputBinding {
  device: InputDevice;
  control: string;
  gesture?: "tap" | "hold" | "swipe" | "drag" | "press" | "release" | "axis";
}

export interface InputActionDefinition {
  actionId: string;
  label: string;
  description: string;
  bindings: InputBinding[];
  enabledInStates: string[];
}

export interface GameInputModel {
  actions: InputActionDefinition[];
  simultaneousTouchPoints: number;
}

export type RuntimeSignalValueType = "event" | "boolean" | "integer" | "number" | "string";

export interface RuntimeSignalDefinition {
  signalId: string;
  label: string;
  description: string;
  valueType: RuntimeSignalValueType;
  visibility: "public" | "internal";
  initialValue?: string | number | boolean;
  unit?: string;
}

export interface GameRuntimeSignals {
  signals: RuntimeSignalDefinition[];
}

export interface GameContract {
  schemaVersion: GameContractSchemaVersion;
  kind: "game_contract";
  identity: GameIdentity;
  genre: GameGenre;
  coreLoop: GameCoreLoop;
  stateModel: GameStateModel;
  inputModel: GameInputModel;
  runtimeSignals: GameRuntimeSignals;
}

export interface GameContractReference {
  contractId: string;
  revision: number;
}

export interface SceneTransform {
  position: [number, number];
  rotation: number;
  scale: [number, number];
  size?: [number, number];
}

export type SceneBindingSource =
  | { type: "input_action"; ref: string }
  | { type: "runtime_signal"; ref: string }
  | { type: "game_state"; ref: string };

export interface ScenePropertyBinding {
  property: string;
  source: SceneBindingSource;
}

export type SceneEntityReference =
  | { property: string; kind: "node"; sceneId: string; nodeId: string }
  | { property: string; kind: "component"; sceneId: string; nodeId: string; componentId: string }
  | { property: string; kind: "prefab"; prefabId: string };

export interface SceneComponentBlueprint {
  componentId: string;
  type: string;
  properties: Record<string, ContractJsonValue>;
  bindings: ScenePropertyBinding[];
  references: SceneEntityReference[];
}

export interface SceneNodeBlueprint {
  nodeId: string;
  testId: string;
  name: string;
  kind: "container" | "sprite" | "label" | "button" | "camera" | "audio" | "custom";
  parentNodeId?: string;
  prefabId?: string;
  transform: SceneTransform;
  components: SceneComponentBlueprint[];
  tags: string[];
}

export interface ScenePrefabBlueprint {
  prefabId: string;
  source: string;
  rootNodeId: string;
  exposedComponentIds: string[];
}

export interface SceneDefinition {
  sceneId: string;
  name: string;
  role: "boot" | "gameplay" | "result" | "overlay";
  nodes: SceneNodeBlueprint[];
}

export interface SceneBlueprint {
  schemaVersion: SceneBlueprintSchemaVersion;
  kind: "scene_blueprint";
  blueprintId: string;
  revision: number;
  gameContract: GameContractReference;
  entrySceneId: string;
  prefabs: ScenePrefabBlueprint[];
  scenes: SceneDefinition[];
}

export interface PlaytestViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface PlaytestEnvironment {
  target: "web" | "wechat_devtools" | "wechat_device";
  orientation: "portrait" | "landscape" | "adaptive";
  viewport: PlaytestViewport;
  maxScenarioDurationMs: number;
}

export type PlaytestAction =
  | { type: "input"; actionId: string; phase: "start" | "perform" | "end"; value?: number | string }
  | { type: "wait"; durationMs: number }
  | { type: "system"; command: "start" | "restart" | "pause" | "resume" };

export type PlaytestAssertion =
  | { type: "state"; stateId: string }
  | {
      type: "signal";
      signalId: string;
      operator: RuntimeConditionOperator;
      expected?: string | number | boolean;
    }
  | { type: "node"; testId: string; expectation: "visible" | "hidden" | "enabled" | "disabled" };

export interface PlaytestStep {
  stepId: string;
  required: boolean;
  action?: PlaytestAction;
  assertions: PlaytestAssertion[];
  repeat?: {
    maxIterations: number;
    until: PlaytestAssertion[];
  };
  timeoutMs: number;
}

export type PlaytestArtifactKind = "screenshot" | "video" | "runtime_trace" | "console_log" | "metrics";

export interface PlaytestScenario {
  scenarioId: string;
  title: string;
  required: boolean;
  priority: "critical" | "high" | "normal";
  startState: string;
  steps: PlaytestStep[];
  expectedEndState: string;
  requiredArtifacts: PlaytestArtifactKind[];
}

export interface PlaytestQualityGate {
  gateId: string;
  signalId: string;
  aggregation: "last" | "min" | "max" | "average" | "sum";
  operator: Exclude<RuntimeConditionOperator, "exists" | "not_exists">;
  expected: string | number | boolean;
}

export interface PlaytestContract {
  schemaVersion: PlaytestContractSchemaVersion;
  kind: "playtest_contract";
  playtestId: string;
  revision: number;
  gameContract: GameContractReference;
  environment: PlaytestEnvironment;
  scenarios: PlaytestScenario[];
  qualityGates: PlaytestQualityGate[];
}

export const MAX_PLAYTEST_SCENARIO_DURATION_MS = 300_000;
export const MAX_PLAYTEST_STEP_TIMEOUT_MS = 60_000;
export const MAX_PLAYTEST_REPEAT_ITERATIONS = 100;

export type ContractValidationIssueCode =
  | "invalid_type"
  | "missing_property"
  | "unknown_property"
  | "invalid_literal"
  | "invalid_format"
  | "invalid_value"
  | "duplicate_id"
  | "duplicate_binding"
  | "unknown_reference"
  | "incompatible_reference"
  | "unreachable_state"
  | "cyclic_parent";

export interface ContractValidationIssue {
  path: string;
  code: ContractValidationIssueCode;
  message: string;
}

export type ContractValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ContractValidationIssue[] };

export type ContractCompatibilityResult = { ok: true } | { ok: false; issues: ContractValidationIssue[] };

export class ContractValidationError extends Error {
  readonly issues: ContractValidationIssue[];

  constructor(contractName: string, issues: ContractValidationIssue[]) {
    super(`${contractName} validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n` +
      issues.slice(0, 40).map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`).join("\n") +
      (issues.length > 40 ? `\n… ${issues.length - 40} more issues; fix these first and retry.` : ""));
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

type JsonObject = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function issue(
  issues: ContractValidationIssue[],
  path: string,
  code: ContractValidationIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectAt(value: unknown, path: string, issues: ContractValidationIssue[]): JsonObject | undefined {
  if (!isObject(value)) {
    issue(issues, path, "invalid_type", "Expected an object.");
    return undefined;
  }
  return value;
}

function strictKeys(
  value: JsonObject,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: ContractValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issue(issues, `${path}.${key}`, "unknown_property", `Unknown property '${key}'.`);
    }
  }
  for (const key of required) {
    if (!own(value, key)) {
      issue(issues, `${path}.${key}`, "missing_property", `Required property '${key}' is missing.`);
    }
  }
}

function stringAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: ContractValidationIssue[],
  options: { optional?: boolean; identifier?: boolean; slug?: boolean; semver?: boolean } = {},
): string | undefined {
  if (!own(value, key)) return undefined;
  const candidate = value[key];
  const fieldPath = `${path}.${key}`;
  if (typeof candidate !== "string") {
    issue(issues, fieldPath, "invalid_type", "Expected a string.");
    return undefined;
  }
  if (candidate.trim().length === 0) {
    issue(issues, fieldPath, "invalid_value", "String must not be empty.");
  } else if (options.identifier && !IDENTIFIER_PATTERN.test(candidate)) {
    issue(issues, fieldPath, "invalid_format", "Expected a stable lowercase identifier.");
  } else if (options.slug && !SLUG_PATTERN.test(candidate)) {
    issue(issues, fieldPath, "invalid_format", "Expected a lowercase kebab-case slug.");
  } else if (options.semver && !SEMVER_PATTERN.test(candidate)) {
    issue(issues, fieldPath, "invalid_format", "Expected a semantic version.");
  }
  return candidate;
}

function numberAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: ContractValidationIssue[],
  options: { integer?: boolean; min?: number; positive?: boolean } = {},
): number | undefined {
  if (!own(value, key)) return undefined;
  const candidate = value[key];
  const fieldPath = `${path}.${key}`;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    issue(issues, fieldPath, "invalid_type", "Expected a finite number.");
    return undefined;
  }
  if (options.integer && !Number.isInteger(candidate)) {
    issue(issues, fieldPath, "invalid_value", "Expected an integer.");
  }
  if (options.positive && candidate <= 0) {
    issue(issues, fieldPath, "invalid_value", "Expected a positive number.");
  }
  if (options.min !== undefined && candidate < options.min) {
    issue(issues, fieldPath, "invalid_value", `Expected a number greater than or equal to ${options.min}.`);
  }
  return candidate;
}

function booleanAt(value: JsonObject, key: string, path: string, issues: ContractValidationIssue[]): boolean | undefined {
  if (!own(value, key)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    issue(issues, `${path}.${key}`, "invalid_type", "Expected a boolean.");
    return undefined;
  }
  return candidate;
}

function literalAt<T extends string>(
  value: JsonObject,
  key: string,
  path: string,
  allowed: readonly T[],
  issues: ContractValidationIssue[],
): T | undefined {
  const candidate = stringAt(value, key, path, issues);
  if (candidate !== undefined && !allowed.includes(candidate as T)) {
    issue(issues, `${path}.${key}`, "invalid_literal", `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }
  return candidate as T | undefined;
}

function arrayAt(value: JsonObject, key: string, path: string, issues: ContractValidationIssue[]): unknown[] | undefined {
  if (!own(value, key)) return undefined;
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    issue(issues, `${path}.${key}`, "invalid_type", "Expected an array.");
    return undefined;
  }
  return candidate;
}

function stringArrayAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: ContractValidationIssue[],
  options: { identifier?: boolean; nonEmpty?: boolean; unique?: boolean } = {},
): string[] | undefined {
  const values = arrayAt(value, key, path, issues);
  if (!values) return undefined;
  if (options.nonEmpty && values.length === 0) {
    issue(issues, `${path}.${key}`, "invalid_value", "Array must not be empty.");
  }
  const seen = new Set<string>();
  for (const [index, candidate] of values.entries()) {
    const itemPath = `${path}.${key}[${index}]`;
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      issue(issues, itemPath, "invalid_type", "Expected a non-empty string.");
      continue;
    }
    if (options.identifier && !IDENTIFIER_PATTERN.test(candidate)) {
      issue(issues, itemPath, "invalid_format", "Expected a stable lowercase identifier.");
    }
    if (options.unique && seen.has(candidate)) {
      issue(issues, itemPath, "duplicate_id", `Duplicate value '${candidate}'.`);
    }
    seen.add(candidate);
  }
  return values as string[];
}

function scalarAt(value: JsonObject, key: string, path: string, issues: ContractValidationIssue[]): unknown {
  if (!own(value, key)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") {
    issue(issues, `${path}.${key}`, "invalid_type", "Expected a string, number, or boolean.");
    return undefined;
  }
  if (typeof candidate === "number" && !Number.isFinite(candidate)) {
    issue(issues, `${path}.${key}`, "invalid_value", "Number must be finite.");
    return undefined;
  }
  return candidate;
}

function validateJsonValue(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "invalid_value", "JSON number must be finite.");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, issues));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) validateJsonValue(entry, `${path}.${key}`, issues);
    return;
  }
  issue(issues, path, "invalid_type", "Expected a JSON-compatible value.");
}

function requireNonEmpty(items: unknown[] | undefined, path: string, issues: ContractValidationIssue[]): void {
  if (items && items.length === 0) issue(issues, path, "invalid_value", "Array must not be empty.");
}

function validateConditionShape(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const record = objectAt(value, path, issues);
  if (!record) return;
  strictKeys(record, path, ["signalId", "operator", "value"], ["signalId", "operator"], issues);
  stringAt(record, "signalId", path, issues, { identifier: true });
  const operator = literalAt(
    record,
    "operator",
    path,
    ["eq", "not_eq", "gt", "gte", "lt", "lte", "exists", "not_exists"] as const,
    issues,
  );
  const hasValue = own(record, "value");
  if (hasValue) scalarAt(record, "value", path, issues);
  if (operator === "exists" || operator === "not_exists") {
    if (hasValue) issue(issues, `${path}.value`, "invalid_value", `Operator '${operator}' must not define a value.`);
  } else if (operator !== undefined && !hasValue) {
    issue(issues, `${path}.value`, "missing_property", `Operator '${operator}' requires a value.`);
  }
}

function validateGameContractShape(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const root = objectAt(value, path, issues);
  if (!root) return;
  strictKeys(
    root,
    path,
    ["schemaVersion", "kind", "identity", "genre", "coreLoop", "stateModel", "inputModel", "runtimeSignals"],
    ["schemaVersion", "kind", "identity", "genre", "coreLoop", "stateModel", "inputModel", "runtimeSignals"],
    issues,
  );
  literalAt(root, "schemaVersion", path, [GAME_CONTRACT_SCHEMA_VERSION] as const, issues);
  literalAt(root, "kind", path, ["game_contract"] as const, issues);

  const identity = objectAt(root.identity, `${path}.identity`, issues);
  if (identity) {
    strictKeys(
      identity,
      `${path}.identity`,
      ["contractId", "gameId", "title", "slug", "summary", "revision", "releaseVersion"],
      ["contractId", "gameId", "title", "slug", "summary", "revision", "releaseVersion"],
      issues,
    );
    stringAt(identity, "contractId", `${path}.identity`, issues, { identifier: true });
    stringAt(identity, "gameId", `${path}.identity`, issues, { identifier: true });
    stringAt(identity, "title", `${path}.identity`, issues);
    stringAt(identity, "slug", `${path}.identity`, issues, { slug: true });
    stringAt(identity, "summary", `${path}.identity`, issues);
    numberAt(identity, "revision", `${path}.identity`, issues, { integer: true, positive: true });
    stringAt(identity, "releaseVersion", `${path}.identity`, issues, { semver: true });
  }

  const genre = objectAt(root.genre, `${path}.genre`, issues);
  if (genre) {
    strictKeys(
      genre,
      `${path}.genre`,
      ["primary", "tags", "perspective", "playerMode"],
      ["primary", "tags", "perspective", "playerMode"],
      issues,
    );
    stringAt(genre, "primary", `${path}.genre`, issues, { identifier: true });
    stringArrayAt(genre, "tags", `${path}.genre`, issues, { identifier: true, unique: true });
    literalAt(genre, "perspective", `${path}.genre`, ["2d", "2.5d", "3d"] as const, issues);
    literalAt(
      genre,
      "playerMode",
      `${path}.genre`,
      ["single_player", "local_multiplayer", "online_multiplayer"] as const,
      issues,
    );
  }

  const coreLoop = objectAt(root.coreLoop, `${path}.coreLoop`, issues);
  if (coreLoop) {
    strictKeys(
      coreLoop,
      `${path}.coreLoop`,
      ["summary", "steps", "successConditions", "failureConditions"],
      ["summary", "steps", "successConditions", "failureConditions"],
      issues,
    );
    stringAt(coreLoop, "summary", `${path}.coreLoop`, issues);
    const steps = arrayAt(coreLoop, "steps", `${path}.coreLoop`, issues);
    requireNonEmpty(steps, `${path}.coreLoop.steps`, issues);
    steps?.forEach((entry, index) => {
      const stepPath = `${path}.coreLoop.steps[${index}]`;
      const step = objectAt(entry, stepPath, issues);
      if (!step) return;
      strictKeys(
        step,
        stepPath,
        ["stepId", "label", "description", "actionIds", "stateIds", "emits"],
        ["stepId", "label", "description", "actionIds", "stateIds", "emits"],
        issues,
      );
      stringAt(step, "stepId", stepPath, issues, { identifier: true });
      stringAt(step, "label", stepPath, issues);
      stringAt(step, "description", stepPath, issues);
      stringArrayAt(step, "actionIds", stepPath, issues, { identifier: true, unique: true });
      stringArrayAt(step, "stateIds", stepPath, issues, { identifier: true, nonEmpty: true, unique: true });
      stringArrayAt(step, "emits", stepPath, issues, { identifier: true, unique: true });
    });
    const success = arrayAt(coreLoop, "successConditions", `${path}.coreLoop`, issues);
    success?.forEach((entry, index) => validateConditionShape(entry, `${path}.coreLoop.successConditions[${index}]`, issues));
    const failure = arrayAt(coreLoop, "failureConditions", `${path}.coreLoop`, issues);
    failure?.forEach((entry, index) => validateConditionShape(entry, `${path}.coreLoop.failureConditions[${index}]`, issues));
  }

  const stateModel = objectAt(root.stateModel, `${path}.stateModel`, issues);
  if (stateModel) {
    strictKeys(
      stateModel,
      `${path}.stateModel`,
      ["lifecycle", "initialState", "states", "transitions"],
      ["lifecycle", "initialState", "states", "transitions"],
      issues,
    );
    literalAt(stateModel, "lifecycle", `${path}.stateModel`, ["finite", "endless"] as const, issues);
    stringAt(stateModel, "initialState", `${path}.stateModel`, issues, { identifier: true });
    const states = arrayAt(stateModel, "states", `${path}.stateModel`, issues);
    requireNonEmpty(states, `${path}.stateModel.states`, issues);
    states?.forEach((entry, index) => {
      const statePath = `${path}.stateModel.states[${index}]`;
      const state = objectAt(entry, statePath, issues);
      if (!state) return;
      strictKeys(
        state,
        statePath,
        ["stateId", "label", "kind", "terminal", "description"],
        ["stateId", "label", "kind", "terminal", "description"],
        issues,
      );
      stringAt(state, "stateId", statePath, issues, { identifier: true });
      stringAt(state, "label", statePath, issues);
      literalAt(state, "kind", statePath, ["boot", "active", "paused", "success", "failure"] as const, issues);
      booleanAt(state, "terminal", statePath, issues);
      stringAt(state, "description", statePath, issues);
    });
    const transitions = arrayAt(stateModel, "transitions", `${path}.stateModel`, issues);
    transitions?.forEach((entry, index) => {
      const transitionPath = `${path}.stateModel.transitions[${index}]`;
      const transition = objectAt(entry, transitionPath, issues);
      if (!transition) return;
      strictKeys(
        transition,
        transitionPath,
        ["transitionId", "from", "to", "trigger", "guards", "emits"],
        ["transitionId", "from", "to", "trigger", "guards", "emits"],
        issues,
      );
      stringAt(transition, "transitionId", transitionPath, issues, { identifier: true });
      stringAt(transition, "from", transitionPath, issues, { identifier: true });
      stringAt(transition, "to", transitionPath, issues, { identifier: true });
      validateTriggerShape(transition.trigger, `${transitionPath}.trigger`, issues);
      const guards = arrayAt(transition, "guards", transitionPath, issues);
      guards?.forEach((guard, guardIndex) => validateConditionShape(guard, `${transitionPath}.guards[${guardIndex}]`, issues));
      stringArrayAt(transition, "emits", transitionPath, issues, { identifier: true, unique: true });
    });
  }

  const inputModel = objectAt(root.inputModel, `${path}.inputModel`, issues);
  if (inputModel) {
    strictKeys(
      inputModel,
      `${path}.inputModel`,
      ["actions", "simultaneousTouchPoints"],
      ["actions", "simultaneousTouchPoints"],
      issues,
    );
    const actions = arrayAt(inputModel, "actions", `${path}.inputModel`, issues);
    requireNonEmpty(actions, `${path}.inputModel.actions`, issues);
    actions?.forEach((entry, index) => {
      const actionPath = `${path}.inputModel.actions[${index}]`;
      const action = objectAt(entry, actionPath, issues);
      if (!action) return;
      strictKeys(
        action,
        actionPath,
        ["actionId", "label", "description", "bindings", "enabledInStates"],
        ["actionId", "label", "description", "bindings", "enabledInStates"],
        issues,
      );
      stringAt(action, "actionId", actionPath, issues, { identifier: true });
      stringAt(action, "label", actionPath, issues);
      stringAt(action, "description", actionPath, issues);
      const bindings = arrayAt(action, "bindings", actionPath, issues);
      requireNonEmpty(bindings, `${actionPath}.bindings`, issues);
      bindings?.forEach((bindingValue, bindingIndex) => {
        const bindingPath = `${actionPath}.bindings[${bindingIndex}]`;
        const binding = objectAt(bindingValue, bindingPath, issues);
        if (!binding) return;
        strictKeys(binding, bindingPath, ["device", "control", "gesture"], ["device", "control"], issues);
        literalAt(binding, "device", bindingPath, ["touch", "mouse", "keyboard", "gamepad", "virtual"] as const, issues);
        stringAt(binding, "control", bindingPath, issues);
        if (own(binding, "gesture")) {
          literalAt(
            binding,
            "gesture",
            bindingPath,
            ["tap", "hold", "swipe", "drag", "press", "release", "axis"] as const,
            issues,
          );
        }
      });
      stringArrayAt(action, "enabledInStates", actionPath, issues, { identifier: true, nonEmpty: true, unique: true });
    });
    numberAt(inputModel, "simultaneousTouchPoints", `${path}.inputModel`, issues, { integer: true, positive: true });
  }

  const runtimeSignals = objectAt(root.runtimeSignals, `${path}.runtimeSignals`, issues);
  if (runtimeSignals) {
    strictKeys(runtimeSignals, `${path}.runtimeSignals`, ["signals"], ["signals"], issues);
    const signals = arrayAt(runtimeSignals, "signals", `${path}.runtimeSignals`, issues);
    requireNonEmpty(signals, `${path}.runtimeSignals.signals`, issues);
    signals?.forEach((entry, index) => {
      const signalPath = `${path}.runtimeSignals.signals[${index}]`;
      const signal = objectAt(entry, signalPath, issues);
      if (!signal) return;
      strictKeys(
        signal,
        signalPath,
        ["signalId", "label", "description", "valueType", "visibility", "initialValue", "unit"],
        ["signalId", "label", "description", "valueType", "visibility"],
        issues,
      );
      stringAt(signal, "signalId", signalPath, issues, { identifier: true });
      stringAt(signal, "label", signalPath, issues);
      stringAt(signal, "description", signalPath, issues);
      literalAt(signal, "valueType", signalPath, ["event", "boolean", "integer", "number", "string"] as const, issues);
      literalAt(signal, "visibility", signalPath, ["public", "internal"] as const, issues);
      if (own(signal, "initialValue")) scalarAt(signal, "initialValue", signalPath, issues);
      if (own(signal, "unit")) stringAt(signal, "unit", signalPath, issues);
    });
  }
}

function validateTriggerShape(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const trigger = objectAt(value, path, issues);
  if (!trigger) return;
  const type = literalAt(trigger, "type", path, ["input", "signal", "timer", "system"] as const, issues);
  if (type === "input" || type === "signal") {
    strictKeys(trigger, path, ["type", "ref"], ["type", "ref"], issues);
    stringAt(trigger, "ref", path, issues, { identifier: true });
  } else if (type === "timer") {
    strictKeys(trigger, path, ["type", "afterMs"], ["type", "afterMs"], issues);
    numberAt(trigger, "afterMs", path, issues, { integer: true, positive: true });
  } else if (type === "system") {
    strictKeys(trigger, path, ["type", "ref"], ["type", "ref"], issues);
    literalAt(trigger, "ref", path, ["start", "restart", "pause", "resume"] as const, issues);
  } else {
    strictKeys(trigger, path, ["type", "ref", "afterMs"], ["type"], issues);
  }
}

function duplicateIndexes(values: string[]): Set<number> {
  const first = new Map<string, number>();
  const duplicates = new Set<number>();
  values.forEach((value, index) => {
    const previous = first.get(value);
    if (previous === undefined) first.set(value, index);
    else {
      duplicates.add(previous);
      duplicates.add(index);
    }
  });
  return duplicates;
}

function reportDuplicateIds(values: string[], path: string, issues: ContractValidationIssue[]): void {
  for (const index of duplicateIndexes(values)) {
    issue(issues, `${path}[${index}]`, "duplicate_id", `Duplicate identifier '${values[index]}'.`);
  }
}

function checkRef(ref: string, known: Set<string>, path: string, label: string, issues: ContractValidationIssue[]): void {
  if (!known.has(ref)) issue(issues, path, "unknown_reference", `Unknown ${label} '${ref}'.`);
}

function validateConditionReferences(
  conditions: RuntimeCondition[],
  signals: Map<string, RuntimeSignalDefinition>,
  path: string,
  issues: ContractValidationIssue[],
): void {
  conditions.forEach((condition, index) => {
    const signal = signals.get(condition.signalId);
    if (!signal) {
      issue(issues, `${path}[${index}].signalId`, "unknown_reference", `Unknown runtime signal '${condition.signalId}'.`);
      return;
    }
    if (signal.valueType === "event" && condition.operator !== "exists" && condition.operator !== "not_exists") {
      issue(
        issues,
        `${path}[${index}].operator`,
        "incompatible_reference",
        `Event signal '${condition.signalId}' only supports exists/not_exists conditions.`,
      );
    }
    if (condition.operator === "gt" || condition.operator === "gte" || condition.operator === "lt" || condition.operator === "lte") {
      if (signal.valueType !== "integer" && signal.valueType !== "number") {
        issue(
          issues,
          `${path}[${index}].operator`,
          "incompatible_reference",
          `Ordered comparison requires a numeric signal, but '${condition.signalId}' is ${signal.valueType}.`,
        );
      }
    }
    if (condition.value !== undefined && !valueMatchesSignal(condition.value, signal.valueType)) {
      issue(
        issues,
        `${path}[${index}].value`,
        "incompatible_reference",
        `Condition value does not match signal type '${signal.valueType}'.`,
      );
    }
  });
}

function valueMatchesSignal(value: unknown, type: RuntimeSignalValueType): boolean {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return false;
}

function validateGameContractSemantics(contract: GameContract, path: string, issues: ContractValidationIssue[]): void {
  const states = new Map(contract.stateModel.states.map((state) => [state.stateId, state]));
  const actions = new Set(contract.inputModel.actions.map((action) => action.actionId));
  const signals = new Map(contract.runtimeSignals.signals.map((signal) => [signal.signalId, signal]));
  reportDuplicateIds(contract.stateModel.states.map((state) => state.stateId), `${path}.stateModel.states`, issues);
  reportDuplicateIds(contract.stateModel.transitions.map((transition) => transition.transitionId), `${path}.stateModel.transitions`, issues);
  reportDuplicateIds(contract.inputModel.actions.map((action) => action.actionId), `${path}.inputModel.actions`, issues);
  reportDuplicateIds(contract.runtimeSignals.signals.map((signal) => signal.signalId), `${path}.runtimeSignals.signals`, issues);
  reportDuplicateIds(contract.coreLoop.steps.map((step) => step.stepId), `${path}.coreLoop.steps`, issues);

  checkRef(contract.stateModel.initialState, new Set(states.keys()), `${path}.stateModel.initialState`, "state", issues);
  if (contract.stateModel.lifecycle === "finite" && !contract.stateModel.states.some((state) => state.kind === "success")) {
    issue(issues, `${path}.stateModel.states`, "invalid_value", "At least one success state is required.");
  }
  if (contract.stateModel.lifecycle === "finite" && contract.coreLoop.successConditions.length === 0) {
    issue(issues, `${path}.coreLoop.successConditions`, "invalid_value", "Finite games require a success condition.");
  }
  contract.stateModel.states.forEach((state, index) => {
    const shouldBeTerminal = state.kind === "success" || state.kind === "failure";
    if (state.terminal !== shouldBeTerminal) {
      issue(
        issues,
        `${path}.stateModel.states[${index}].terminal`,
        "invalid_value",
        `${state.kind} states must set terminal to ${shouldBeTerminal}.`,
      );
    }
  });

  const stateIds = new Set(states.keys());
  const signalIds = new Set(signals.keys());
  contract.stateModel.transitions.forEach((transition, index) => {
    const transitionPath = `${path}.stateModel.transitions[${index}]`;
    checkRef(transition.from, stateIds, `${transitionPath}.from`, "state", issues);
    checkRef(transition.to, stateIds, `${transitionPath}.to`, "state", issues);
    if (states.get(transition.from)?.terminal) {
      const inputRef = transition.trigger.type === "input" ? transition.trigger.ref : undefined;
      const explicitPlayerExit = transition.trigger.type === "input" && contract.inputModel.actions.some(
        (action) => action.actionId === inputRef && action.enabledInStates.includes(transition.from)
      );
      const systemRestart = transition.trigger.type === "system" && transition.trigger.ref === "restart";
      if ((!explicitPlayerExit && !systemRestart) || states.get(transition.to)?.terminal) {
        issue(issues, `${transitionPath}.from`, "invalid_value",
          "Terminal states may exit to a nonterminal state only through system/restart or an explicit input enabled in that terminal state.");
      }
    }
    if (transition.trigger.type === "input") checkRef(transition.trigger.ref, actions, `${transitionPath}.trigger.ref`, "input action", issues);
    if (transition.trigger.type === "signal") checkRef(transition.trigger.ref, signalIds, `${transitionPath}.trigger.ref`, "runtime signal", issues);
    transition.emits.forEach((ref, emitIndex) => checkRef(ref, signalIds, `${transitionPath}.emits[${emitIndex}]`, "runtime signal", issues));
    validateConditionReferences(transition.guards, signals, `${transitionPath}.guards`, issues);
  });

  contract.inputModel.actions.forEach((action, index) => {
    action.enabledInStates.forEach((ref, stateIndex) =>
      checkRef(ref, stateIds, `${path}.inputModel.actions[${index}].enabledInStates[${stateIndex}]`, "state", issues),
    );
  });
  contract.coreLoop.steps.forEach((step, index) => {
    step.actionIds.forEach((ref, refIndex) =>
      checkRef(ref, actions, `${path}.coreLoop.steps[${index}].actionIds[${refIndex}]`, "input action", issues),
    );
    step.stateIds.forEach((ref, refIndex) =>
      checkRef(ref, stateIds, `${path}.coreLoop.steps[${index}].stateIds[${refIndex}]`, "state", issues),
    );
    step.emits.forEach((ref, refIndex) =>
      checkRef(ref, signalIds, `${path}.coreLoop.steps[${index}].emits[${refIndex}]`, "runtime signal", issues),
    );
  });
  validateConditionReferences(contract.coreLoop.successConditions, signals, `${path}.coreLoop.successConditions`, issues);
  validateConditionReferences(contract.coreLoop.failureConditions, signals, `${path}.coreLoop.failureConditions`, issues);

  contract.runtimeSignals.signals.forEach((signal, index) => {
    if (signal.valueType === "event" && signal.initialValue !== undefined) {
      issue(issues, `${path}.runtimeSignals.signals[${index}].initialValue`, "invalid_value", "Event signals cannot have an initial value.");
    } else if (signal.initialValue !== undefined && !valueMatchesSignal(signal.initialValue, signal.valueType)) {
      issue(
        issues,
        `${path}.runtimeSignals.signals[${index}].initialValue`,
        "invalid_value",
        `Initial value does not match signal type '${signal.valueType}'.`,
      );
    }
  });

  if (states.has(contract.stateModel.initialState)) {
    const reachable = new Set<string>([contract.stateModel.initialState]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const transition of contract.stateModel.transitions) {
        if (reachable.has(transition.from) && !reachable.has(transition.to)) {
          reachable.add(transition.to);
          changed = true;
        }
      }
    }
    contract.stateModel.states.forEach((state, index) => {
      if (!reachable.has(state.stateId)) {
        issue(issues, `${path}.stateModel.states[${index}].stateId`, "unreachable_state", `State '${state.stateId}' is unreachable.`);
      }
    });
  }
}

export function validateGameContract(value: unknown): ContractValidationResult<GameContract> {
  const issues: ContractValidationIssue[] = [];
  validateGameContractShape(value, "$", issues);
  if (issues.length === 0) validateGameContractSemantics(value as GameContract, "$", issues);
  return issues.length === 0 ? { ok: true, value: value as GameContract } : { ok: false, issues };
}

export function parseGameContract(value: unknown): GameContract {
  const result = validateGameContract(value);
  if (!result.ok) throw new ContractValidationError("GameContract", result.issues);
  return result.value;
}

function validateGameContractReference(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const reference = objectAt(value, path, issues);
  if (!reference) return;
  strictKeys(reference, path, ["contractId", "revision"], ["contractId", "revision"], issues);
  stringAt(reference, "contractId", path, issues, { identifier: true });
  numberAt(reference, "revision", path, issues, { integer: true, positive: true });
}

function validateTransform(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const transform = objectAt(value, path, issues);
  if (!transform) return;
  strictKeys(transform, path, ["position", "rotation", "scale", "size"], ["position", "rotation", "scale"], issues);
  validateNumberTuple(transform.position, `${path}.position`, issues, false);
  if (own(transform, "rotation")) numberAt(transform, "rotation", path, issues);
  validateNumberTuple(transform.scale, `${path}.scale`, issues, false);
  if (own(transform, "size")) validateNumberTuple(transform.size, `${path}.size`, issues, true);
}

function validateNumberTuple(value: unknown, path: string, issues: ContractValidationIssue[], positive: boolean): void {
  if (!Array.isArray(value) || value.length !== 2) {
    issue(issues, path, "invalid_type", "Expected a two-number tuple.");
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      issue(issues, `${path}[${index}]`, "invalid_type", "Expected a finite number.");
    } else if (positive && entry <= 0) {
      issue(issues, `${path}[${index}]`, "invalid_value", "Expected a positive number.");
    }
  });
}

function validateSceneBindingSource(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const source = objectAt(value, path, issues);
  if (!source) return;
  strictKeys(source, path, ["type", "ref"], ["type", "ref"], issues);
  literalAt(source, "type", path, ["input_action", "runtime_signal", "game_state"] as const, issues);
  stringAt(source, "ref", path, issues, { identifier: true });
}

const COMPONENT_PROPERTY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FORBIDDEN_COMPONENT_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);

function componentPropertyAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: ContractValidationIssue[],
): string | undefined {
  const property = stringAt(value, key, path, issues);
  if (
    property !== undefined &&
    (!COMPONENT_PROPERTY_PATTERN.test(property) || FORBIDDEN_COMPONENT_PROPERTIES.has(property))
  ) {
    issue(
      issues,
      `${path}.${key}`,
      "invalid_format",
      "Expected a safe JavaScript component property name.",
    );
  }
  return property;
}

function validateComponentPropertyKey(property: string, path: string, issues: ContractValidationIssue[]): void {
  if (!COMPONENT_PROPERTY_PATTERN.test(property) || FORBIDDEN_COMPONENT_PROPERTIES.has(property)) {
    issue(issues, path, "invalid_format", "Expected a safe JavaScript component property name.");
  }
}

function validateSceneEntityReferenceShape(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const reference = objectAt(value, path, issues);
  if (!reference) return;
  const kind = literalAt(reference, "kind", path, ["node", "component", "prefab"] as const, issues);
  if (kind === "node") {
    strictKeys(reference, path, ["property", "kind", "sceneId", "nodeId"], ["property", "kind", "sceneId", "nodeId"], issues);
    componentPropertyAt(reference, "property", path, issues);
    stringAt(reference, "sceneId", path, issues, { identifier: true });
    stringAt(reference, "nodeId", path, issues, { identifier: true });
  } else if (kind === "component") {
    strictKeys(
      reference,
      path,
      ["property", "kind", "sceneId", "nodeId", "componentId"],
      ["property", "kind", "sceneId", "nodeId", "componentId"],
      issues,
    );
    componentPropertyAt(reference, "property", path, issues);
    stringAt(reference, "sceneId", path, issues, { identifier: true });
    stringAt(reference, "nodeId", path, issues, { identifier: true });
    stringAt(reference, "componentId", path, issues, { identifier: true });
  } else if (kind === "prefab") {
    strictKeys(reference, path, ["property", "kind", "prefabId"], ["property", "kind", "prefabId"], issues);
    componentPropertyAt(reference, "property", path, issues);
    stringAt(reference, "prefabId", path, issues, { identifier: true });
  } else {
    strictKeys(reference, path, ["property", "kind", "sceneId", "nodeId", "componentId", "prefabId"], ["property", "kind"], issues);
    componentPropertyAt(reference, "property", path, issues);
  }
}

function validateSceneBlueprintShape(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const root = objectAt(value, path, issues);
  if (!root) return;
  strictKeys(
    root,
    path,
    ["schemaVersion", "kind", "blueprintId", "revision", "gameContract", "entrySceneId", "prefabs", "scenes"],
    ["schemaVersion", "kind", "blueprintId", "revision", "gameContract", "entrySceneId", "prefabs", "scenes"],
    issues,
  );
  literalAt(root, "schemaVersion", path, [SCENE_BLUEPRINT_SCHEMA_VERSION] as const, issues);
  literalAt(root, "kind", path, ["scene_blueprint"] as const, issues);
  stringAt(root, "blueprintId", path, issues, { identifier: true });
  numberAt(root, "revision", path, issues, { integer: true, positive: true });
  validateGameContractReference(root.gameContract, `${path}.gameContract`, issues);
  stringAt(root, "entrySceneId", path, issues, { identifier: true });
  const prefabs = arrayAt(root, "prefabs", path, issues);
  prefabs?.forEach((prefabValue, prefabIndex) => {
    const prefabPath = `${path}.prefabs[${prefabIndex}]`;
    const prefab = objectAt(prefabValue, prefabPath, issues);
    if (!prefab) return;
    strictKeys(
      prefab,
      prefabPath,
      ["prefabId", "source", "rootNodeId", "exposedComponentIds"],
      ["prefabId", "source", "rootNodeId", "exposedComponentIds"],
      issues,
    );
    stringAt(prefab, "prefabId", prefabPath, issues, { identifier: true });
    stringAt(prefab, "source", prefabPath, issues);
    stringAt(prefab, "rootNodeId", prefabPath, issues, { identifier: true });
    stringArrayAt(prefab, "exposedComponentIds", prefabPath, issues, { identifier: true, unique: true });
  });
  const scenes = arrayAt(root, "scenes", path, issues);
  requireNonEmpty(scenes, `${path}.scenes`, issues);
  scenes?.forEach((sceneValue, sceneIndex) => {
    const scenePath = `${path}.scenes[${sceneIndex}]`;
    const scene = objectAt(sceneValue, scenePath, issues);
    if (!scene) return;
    strictKeys(scene, scenePath, ["sceneId", "name", "role", "nodes"], ["sceneId", "name", "role", "nodes"], issues);
    stringAt(scene, "sceneId", scenePath, issues, { identifier: true });
    stringAt(scene, "name", scenePath, issues);
    literalAt(scene, "role", scenePath, ["boot", "gameplay", "result", "overlay"] as const, issues);
    const nodes = arrayAt(scene, "nodes", scenePath, issues);
    requireNonEmpty(nodes, `${scenePath}.nodes`, issues);
    nodes?.forEach((nodeValue, nodeIndex) => {
      const nodePath = `${scenePath}.nodes[${nodeIndex}]`;
      const node = objectAt(nodeValue, nodePath, issues);
      if (!node) return;
      strictKeys(
        node,
        nodePath,
        ["nodeId", "testId", "name", "kind", "parentNodeId", "prefabId", "transform", "components", "tags"],
        ["nodeId", "testId", "name", "kind", "transform", "components", "tags"],
        issues,
      );
      stringAt(node, "nodeId", nodePath, issues, { identifier: true });
      stringAt(node, "testId", nodePath, issues, { identifier: true });
      stringAt(node, "name", nodePath, issues);
      literalAt(node, "kind", nodePath, ["container", "sprite", "label", "button", "camera", "audio", "custom"] as const, issues);
      if (own(node, "parentNodeId")) stringAt(node, "parentNodeId", nodePath, issues, { identifier: true });
      if (own(node, "prefabId")) stringAt(node, "prefabId", nodePath, issues, { identifier: true });
      validateTransform(node.transform, `${nodePath}.transform`, issues);
      const components = arrayAt(node, "components", nodePath, issues);
      components?.forEach((componentValue, componentIndex) => {
        const componentPath = `${nodePath}.components[${componentIndex}]`;
        const component = objectAt(componentValue, componentPath, issues);
        if (!component) return;
        strictKeys(
          component,
          componentPath,
          ["componentId", "type", "properties", "bindings", "references"],
          ["componentId", "type", "properties", "bindings", "references"],
          issues,
        );
        stringAt(component, "componentId", componentPath, issues, { identifier: true });
        stringAt(component, "type", componentPath, issues);
        const properties = objectAt(component.properties, `${componentPath}.properties`, issues);
        if (properties) {
          Object.entries(properties).forEach(([key, entry]) => {
            validateComponentPropertyKey(key, `${componentPath}.properties.${key}`, issues);
            validateJsonValue(entry, `${componentPath}.properties.${key}`, issues);
          });
        }
        const bindings = arrayAt(component, "bindings", componentPath, issues);
        bindings?.forEach((bindingValue, bindingIndex) => {
          const bindingPath = `${componentPath}.bindings[${bindingIndex}]`;
          const binding = objectAt(bindingValue, bindingPath, issues);
          if (!binding) return;
          strictKeys(binding, bindingPath, ["property", "source"], ["property", "source"], issues);
          componentPropertyAt(binding, "property", bindingPath, issues);
          validateSceneBindingSource(binding.source, `${bindingPath}.source`, issues);
        });
        const references = arrayAt(component, "references", componentPath, issues);
        references?.forEach((reference, referenceIndex) =>
          validateSceneEntityReferenceShape(reference, `${componentPath}.references[${referenceIndex}]`, issues),
        );
      });
      stringArrayAt(node, "tags", nodePath, issues, { identifier: true, unique: true });
    });
  });
}

function validateSceneBlueprintSemantics(blueprint: SceneBlueprint, path: string, issues: ContractValidationIssue[]): void {
  reportDuplicateIds(blueprint.scenes.map((scene) => scene.sceneId), `${path}.scenes`, issues);
  reportDuplicateIds(blueprint.prefabs.map((prefab) => prefab.prefabId), `${path}.prefabs`, issues);
  reportDuplicateIds(
    blueprint.scenes.flatMap((scene) => scene.nodes.map((node) => node.testId)),
    `${path}.scenes.*.nodes.*.testId`,
    issues,
  );
  const scenes = new Set(blueprint.scenes.map((scene) => scene.sceneId));
  const prefabs = new Set(blueprint.prefabs.map((prefab) => prefab.prefabId));
  const nodes = new Set(
    blueprint.scenes.flatMap((scene) => scene.nodes.map((node) => `${scene.sceneId}/${node.nodeId}`)),
  );
  const components = new Set(
    blueprint.scenes.flatMap((scene) =>
      scene.nodes.flatMap((node) => node.components.map((component) => `${scene.sceneId}/${node.nodeId}/${component.componentId}`)),
    ),
  );
  checkRef(blueprint.entrySceneId, scenes, `${path}.entrySceneId`, "scene", issues);
  blueprint.scenes.forEach((scene, sceneIndex) => {
    const nodeIds = scene.nodes.map((node) => node.nodeId);
    const knownNodes = new Set(nodeIds);
    reportDuplicateIds(nodeIds, `${path}.scenes[${sceneIndex}].nodes`, issues);
    scene.nodes.forEach((node, nodeIndex) => {
      const nodePath = `${path}.scenes[${sceneIndex}].nodes[${nodeIndex}]`;
      if (node.parentNodeId !== undefined) {
        checkRef(node.parentNodeId, knownNodes, `${nodePath}.parentNodeId`, "parent node", issues);
        const visited = new Set<string>([node.nodeId]);
        let parentId: string | undefined = node.parentNodeId;
        while (parentId !== undefined && knownNodes.has(parentId)) {
          if (visited.has(parentId)) {
            issue(issues, `${nodePath}.parentNodeId`, "cyclic_parent", `Node '${node.nodeId}' belongs to a cyclic parent chain.`);
            break;
          }
          visited.add(parentId);
          parentId = scene.nodes.find((candidate) => candidate.nodeId === parentId)?.parentNodeId;
        }
      }
      if (node.prefabId !== undefined) {
        checkRef(node.prefabId, prefabs, `${nodePath}.prefabId`, "prefab", issues);
      }
      reportDuplicateIds(node.components.map((component) => component.componentId), `${nodePath}.components`, issues);
      node.components.forEach((component, componentIndex) => {
        const componentPath = `${nodePath}.components[${componentIndex}]`;
        const propertyOwners = new Map<string, string>();
        const registerProperty = (property: string, ownerPath: string): void => {
          const previous = propertyOwners.get(property);
          if (previous) {
            issue(
              issues,
              ownerPath,
              "duplicate_binding",
              `Component property '${property}' is already assigned by ${previous}.`,
            );
          } else {
            propertyOwners.set(property, ownerPath);
          }
        };
        Object.keys(component.properties).forEach((property) =>
          registerProperty(property, `${componentPath}.properties.${property}`),
        );
        component.bindings.forEach((binding, bindingIndex) =>
          registerProperty(binding.property, `${componentPath}.bindings[${bindingIndex}].property`),
        );
        component.references.forEach((reference, referenceIndex) => {
          const referencePath = `${componentPath}.references[${referenceIndex}]`;
          registerProperty(reference.property, `${referencePath}.property`);
          if (reference.kind === "node") {
            checkRef(`${reference.sceneId}/${reference.nodeId}`, nodes, referencePath, "scene node reference", issues);
          } else if (reference.kind === "component") {
            checkRef(
              `${reference.sceneId}/${reference.nodeId}/${reference.componentId}`,
              components,
              referencePath,
              "scene component reference",
              issues,
            );
          } else {
            checkRef(reference.prefabId, prefabs, `${referencePath}.prefabId`, "prefab", issues);
          }
        });
      });
    });
  });
}

export function validateSceneBlueprint(value: unknown): ContractValidationResult<SceneBlueprint> {
  const issues: ContractValidationIssue[] = [];
  validateSceneBlueprintShape(value, "$", issues);
  if (issues.length === 0) validateSceneBlueprintSemantics(value as SceneBlueprint, "$", issues);
  return issues.length === 0 ? { ok: true, value: value as SceneBlueprint } : { ok: false, issues };
}

export function parseSceneBlueprint(value: unknown): SceneBlueprint {
  const result = validateSceneBlueprint(value);
  if (!result.ok) throw new ContractValidationError("SceneBlueprint", result.issues);
  return result.value;
}

function validatePlaytestAction(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const action = objectAt(value, path, issues);
  if (!action) return;
  const type = literalAt(action, "type", path, ["input", "wait", "system"] as const, issues);
  if (type === "input") {
    strictKeys(action, path, ["type", "actionId", "phase", "value"], ["type", "actionId", "phase"], issues);
    stringAt(action, "actionId", path, issues, { identifier: true });
    literalAt(action, "phase", path, ["start", "perform", "end"] as const, issues);
    if (own(action, "value")) {
      const inputValue = action.value;
      if ((typeof inputValue !== "number" || !Number.isFinite(inputValue)) && typeof inputValue !== "string") {
        issue(issues, `${path}.value`, "invalid_type", "Expected a finite number or string input value.");
      }
    }
  } else if (type === "wait") {
    strictKeys(action, path, ["type", "durationMs"], ["type", "durationMs"], issues);
    numberAt(action, "durationMs", path, issues, { integer: true, positive: true });
  } else if (type === "system") {
    strictKeys(action, path, ["type", "command"], ["type", "command"], issues);
    literalAt(action, "command", path, ["start", "restart", "pause", "resume"] as const, issues);
  } else {
    strictKeys(action, path, ["type", "actionId", "phase", "value", "durationMs", "command"], ["type"], issues);
  }
}

function validatePlaytestAssertion(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const assertion = objectAt(value, path, issues);
  if (!assertion) return;
  const type = literalAt(assertion, "type", path, ["state", "signal", "node"] as const, issues);
  if (type === "state") {
    strictKeys(assertion, path, ["type", "stateId"], ["type", "stateId"], issues);
    stringAt(assertion, "stateId", path, issues, { identifier: true });
  } else if (type === "signal") {
    strictKeys(assertion, path, ["type", "signalId", "operator", "expected"], ["type", "signalId", "operator"], issues);
    stringAt(assertion, "signalId", path, issues, { identifier: true });
    const operator = literalAt(
      assertion,
      "operator",
      path,
      ["eq", "not_eq", "gt", "gte", "lt", "lte", "exists", "not_exists"] as const,
      issues,
    );
    const hasExpected = own(assertion, "expected");
    if (hasExpected) scalarAt(assertion, "expected", path, issues);
    if (operator === "exists" || operator === "not_exists") {
      if (hasExpected) issue(issues, `${path}.expected`, "invalid_value", `Operator '${operator}' must not define expected.`);
    } else if (operator !== undefined && !hasExpected) {
      issue(issues, `${path}.expected`, "missing_property", `Operator '${operator}' requires expected.`);
    }
  } else if (type === "node") {
    strictKeys(assertion, path, ["type", "testId", "expectation"], ["type", "testId", "expectation"], issues);
    stringAt(assertion, "testId", path, issues, { identifier: true });
    literalAt(assertion, "expectation", path, ["visible", "hidden", "enabled", "disabled"] as const, issues);
  } else {
    strictKeys(assertion, path, ["type", "stateId", "signalId", "operator", "expected", "testId", "expectation"], ["type"], issues);
  }
}

function validatePlaytestContractShape(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  const root = objectAt(value, path, issues);
  if (!root) return;
  strictKeys(
    root,
    path,
    ["schemaVersion", "kind", "playtestId", "revision", "gameContract", "environment", "scenarios", "qualityGates"],
    ["schemaVersion", "kind", "playtestId", "revision", "gameContract", "environment", "scenarios", "qualityGates"],
    issues,
  );
  literalAt(root, "schemaVersion", path, [PLAYTEST_CONTRACT_SCHEMA_VERSION] as const, issues);
  literalAt(root, "kind", path, ["playtest_contract"] as const, issues);
  stringAt(root, "playtestId", path, issues, { identifier: true });
  numberAt(root, "revision", path, issues, { integer: true, positive: true });
  validateGameContractReference(root.gameContract, `${path}.gameContract`, issues);

  const environment = objectAt(root.environment, `${path}.environment`, issues);
  if (environment) {
    strictKeys(
      environment,
      `${path}.environment`,
      ["target", "orientation", "viewport", "maxScenarioDurationMs"],
      ["target", "orientation", "viewport", "maxScenarioDurationMs"],
      issues,
    );
    literalAt(environment, "target", `${path}.environment`, ["web", "wechat_devtools", "wechat_device"] as const, issues);
    literalAt(environment, "orientation", `${path}.environment`, ["portrait", "landscape", "adaptive"] as const, issues);
    const viewport = objectAt(environment.viewport, `${path}.environment.viewport`, issues);
    if (viewport) {
      strictKeys(viewport, `${path}.environment.viewport`, ["width", "height", "deviceScaleFactor"], ["width", "height", "deviceScaleFactor"], issues);
      numberAt(viewport, "width", `${path}.environment.viewport`, issues, { integer: true, positive: true });
      numberAt(viewport, "height", `${path}.environment.viewport`, issues, { integer: true, positive: true });
      numberAt(viewport, "deviceScaleFactor", `${path}.environment.viewport`, issues, { positive: true });
    }
    numberAt(environment, "maxScenarioDurationMs", `${path}.environment`, issues, { integer: true, positive: true });
  }

  const scenarios = arrayAt(root, "scenarios", path, issues);
  requireNonEmpty(scenarios, `${path}.scenarios`, issues);
  scenarios?.forEach((scenarioValue, scenarioIndex) => {
    const scenarioPath = `${path}.scenarios[${scenarioIndex}]`;
    const scenario = objectAt(scenarioValue, scenarioPath, issues);
    if (!scenario) return;
    strictKeys(
      scenario,
      scenarioPath,
      ["scenarioId", "title", "required", "priority", "startState", "steps", "expectedEndState", "requiredArtifacts"],
      ["scenarioId", "title", "required", "priority", "startState", "steps", "expectedEndState", "requiredArtifacts"],
      issues,
    );
    stringAt(scenario, "scenarioId", scenarioPath, issues, { identifier: true });
    stringAt(scenario, "title", scenarioPath, issues);
    booleanAt(scenario, "required", scenarioPath, issues);
    literalAt(scenario, "priority", scenarioPath, ["critical", "high", "normal"] as const, issues);
    stringAt(scenario, "startState", scenarioPath, issues, { identifier: true });
    const steps = arrayAt(scenario, "steps", scenarioPath, issues);
    requireNonEmpty(steps, `${scenarioPath}.steps`, issues);
    steps?.forEach((stepValue, stepIndex) => {
      const stepPath = `${scenarioPath}.steps[${stepIndex}]`;
      const step = objectAt(stepValue, stepPath, issues);
      if (!step) return;
      strictKeys(
        step,
        stepPath,
        ["stepId", "required", "action", "assertions", "repeat", "timeoutMs"],
        ["stepId", "required", "assertions", "timeoutMs"],
        issues,
      );
      stringAt(step, "stepId", stepPath, issues, { identifier: true });
      booleanAt(step, "required", stepPath, issues);
      if (own(step, "action")) validatePlaytestAction(step.action, `${stepPath}.action`, issues);
      const assertions = arrayAt(step, "assertions", stepPath, issues);
      assertions?.forEach((assertion, assertionIndex) => validatePlaytestAssertion(assertion, `${stepPath}.assertions[${assertionIndex}]`, issues));
      if (own(step, "repeat")) {
        const repeat = objectAt(step.repeat, `${stepPath}.repeat`, issues);
        if (repeat) {
          strictKeys(repeat, `${stepPath}.repeat`, ["maxIterations", "until"], ["maxIterations", "until"], issues);
          numberAt(repeat, "maxIterations", `${stepPath}.repeat`, issues, { integer: true, positive: true });
          const until = arrayAt(repeat, "until", `${stepPath}.repeat`, issues);
          requireNonEmpty(until, `${stepPath}.repeat.until`, issues);
          until?.forEach((assertion, assertionIndex) =>
            validatePlaytestAssertion(assertion, `${stepPath}.repeat.until[${assertionIndex}]`, issues),
          );
        }
      }
      if (!own(step, "action") && assertions?.length === 0) {
        issue(issues, stepPath, "invalid_value", "A playtest step must perform an action or make an assertion.");
      }
      numberAt(step, "timeoutMs", stepPath, issues, { integer: true, positive: true });
    });
    stringAt(scenario, "expectedEndState", scenarioPath, issues, { identifier: true });
    const artifacts = stringArrayAt(scenario, "requiredArtifacts", scenarioPath, issues, { nonEmpty: true, unique: true });
    artifacts?.forEach((artifact, artifactIndex) => {
      if (!["screenshot", "video", "runtime_trace", "console_log", "metrics"].includes(artifact)) {
        issue(issues, `${scenarioPath}.requiredArtifacts[${artifactIndex}]`, "invalid_literal", `Unknown artifact kind '${artifact}'.`);
      }
    });
  });

  const gates = arrayAt(root, "qualityGates", path, issues);
  gates?.forEach((gateValue, gateIndex) => {
    const gatePath = `${path}.qualityGates[${gateIndex}]`;
    const gate = objectAt(gateValue, gatePath, issues);
    if (!gate) return;
    strictKeys(
      gate,
      gatePath,
      ["gateId", "signalId", "aggregation", "operator", "expected"],
      ["gateId", "signalId", "aggregation", "operator", "expected"],
      issues,
    );
    stringAt(gate, "gateId", gatePath, issues, { identifier: true });
    stringAt(gate, "signalId", gatePath, issues, { identifier: true });
    literalAt(gate, "aggregation", gatePath, ["last", "min", "max", "average", "sum"] as const, issues);
    literalAt(gate, "operator", gatePath, ["eq", "not_eq", "gt", "gte", "lt", "lte"] as const, issues);
    scalarAt(gate, "expected", gatePath, issues);
  });
}

function validatePlaytestContractSemantics(contract: PlaytestContract, path: string, issues: ContractValidationIssue[]): void {
  reportDuplicateIds(contract.scenarios.map((scenario) => scenario.scenarioId), `${path}.scenarios`, issues);
  reportDuplicateIds(contract.qualityGates.map((gate) => gate.gateId), `${path}.qualityGates`, issues);
  // v1 reset() reloads the same entry point before EVERY scenario. startState
  // is an assertion, not a fixture setter or an implicit navigation request.
  const resetState = contract.scenarios[0]?.startState;
  contract.scenarios.forEach((scenario, index) => {
    if (scenario.startState !== resetState) issue(issues, `${path}.scenarios[${index}].startState`, "invalid_value",
      `Every scenario reloads the game independently and must assert the same reset state '${resetState}'. '${scenario.startState}' is not established automatically. Add real navigation/setup actions to this scenario's steps; do not change game behavior to satisfy test setup.`);
  });
  // Aggregates cover the whole run, not the scenario suggested by a gate's
  // name. Reject provably contradictory constraints; do not weaken either one.
  contract.qualityGates.forEach((gate, index) => {
    const equality = contract.qualityGates.find((other) => other !== gate && other.operator === "eq" &&
      other.signalId === gate.signalId && other.aggregation === gate.aggregation && !qualityGateAcceptsValue(gate, other.expected));
    if (equality) issue(issues, `${path}.qualityGates[${index}]`, "invalid_value",
      `Global quality gates '${equality.gateId}' and '${gate.gateId}' contradict each other for ${gate.aggregation}(${gate.signalId}). Aggregates include all scenarios. Express scenario-specific expectations as step assertions, retaining success and failure coverage.`);
  });
  if (contract.environment.maxScenarioDurationMs > MAX_PLAYTEST_SCENARIO_DURATION_MS) {
    issue(
      issues,
      `${path}.environment.maxScenarioDurationMs`,
      "invalid_value",
      `Scenario timeout cannot exceed ${MAX_PLAYTEST_SCENARIO_DURATION_MS}ms.`,
    );
  }
  if (!contract.scenarios.some((scenario) => scenario.required)) {
    issue(issues, `${path}.scenarios`, "invalid_value", "At least one required scenario is needed for a release gate.");
  }
  contract.scenarios.forEach((scenario, scenarioIndex) => {
    reportDuplicateIds(scenario.steps.map((step) => step.stepId), `${path}.scenarios[${scenarioIndex}].steps`, issues);
    if (scenario.required && !scenario.steps.some((step) => step.required)) {
      issue(
        issues,
        `${path}.scenarios[${scenarioIndex}].steps`,
        "invalid_value",
        "A required scenario must contain at least one required step.",
      );
    }
    const worstCaseDurationMs = scenario.steps.reduce(
      (sum, step) => sum + step.timeoutMs * (step.repeat?.maxIterations ?? 1),
      0,
    );
    if (worstCaseDurationMs > contract.environment.maxScenarioDurationMs) {
      issue(
        issues,
        `${path}.scenarios[${scenarioIndex}].steps`,
        "invalid_value",
        `Worst-case step duration ${worstCaseDurationMs}ms exceeds the scenario timeout.`,
      );
    }
    scenario.steps.forEach((step, stepIndex) => {
      if (step.timeoutMs > contract.environment.maxScenarioDurationMs) {
        issue(
          issues,
          `${path}.scenarios[${scenarioIndex}].steps[${stepIndex}].timeoutMs`,
          "invalid_value",
          "Step timeout cannot exceed the environment scenario timeout.",
        );
      }
      if (step.timeoutMs > MAX_PLAYTEST_STEP_TIMEOUT_MS) {
        issue(
          issues,
          `${path}.scenarios[${scenarioIndex}].steps[${stepIndex}].timeoutMs`,
          "invalid_value",
          `Step timeout cannot exceed ${MAX_PLAYTEST_STEP_TIMEOUT_MS}ms.`,
        );
      }
      if (step.repeat && step.repeat.maxIterations > MAX_PLAYTEST_REPEAT_ITERATIONS) {
        issue(
          issues,
          `${path}.scenarios[${scenarioIndex}].steps[${stepIndex}].repeat.maxIterations`,
          "invalid_value",
          `Repeat count cannot exceed ${MAX_PLAYTEST_REPEAT_ITERATIONS}.`,
        );
      }
    });
  });
}

function qualityGateAcceptsValue(gate: PlaytestQualityGate, value: PlaytestQualityGate["expected"]): boolean {
  if (gate.operator === "eq") return value === gate.expected;
  if (gate.operator === "not_eq") return value !== gate.expected;
  // Type incompatibilities are validated separately; no coercion or guessing.
  if (typeof value !== "number" || typeof gate.expected !== "number") return true;
  switch (gate.operator) {
    case "gt": return value > gate.expected;
    case "gte": return value >= gate.expected;
    case "lt": return value < gate.expected;
    case "lte": return value <= gate.expected;
  }
}

export function validatePlaytestContract(value: unknown): ContractValidationResult<PlaytestContract> {
  const issues: ContractValidationIssue[] = [];
  validatePlaytestContractShape(value, "$", issues);
  if (issues.length === 0) validatePlaytestContractSemantics(value as PlaytestContract, "$", issues);
  return issues.length === 0 ? { ok: true, value: value as PlaytestContract } : { ok: false, issues };
}

export function parsePlaytestContract(value: unknown): PlaytestContract {
  const result = validatePlaytestContract(value);
  if (!result.ok) throw new ContractValidationError("PlaytestContract", result.issues);
  return result.value;
}

function validateContractReferenceCompatibility(
  reference: GameContractReference,
  contract: GameContract,
  path: string,
  issues: ContractValidationIssue[],
): void {
  if (reference.contractId !== contract.identity.contractId) {
    issue(
      issues,
      `${path}.contractId`,
      "incompatible_reference",
      `Expected contractId '${contract.identity.contractId}', received '${reference.contractId}'.`,
    );
  }
  if (reference.revision !== contract.identity.revision) {
    issue(
      issues,
      `${path}.revision`,
      "incompatible_reference",
      `Expected revision ${contract.identity.revision}, received ${reference.revision}.`,
    );
  }
}

export function validateSceneBlueprintCompatibility(
  blueprint: SceneBlueprint,
  contract: GameContract,
): ContractCompatibilityResult {
  const issues: ContractValidationIssue[] = [];
  validateContractReferenceCompatibility(blueprint.gameContract, contract, "$.gameContract", issues);
  const states = new Set(contract.stateModel.states.map((state) => state.stateId));
  const actions = new Set(contract.inputModel.actions.map((action) => action.actionId));
  const signals = new Map(contract.runtimeSignals.signals.map((signal) => [signal.signalId, signal]));
  blueprint.scenes.forEach((scene, sceneIndex) => {
    scene.nodes.forEach((node, nodeIndex) => {
      node.components.forEach((component, componentIndex) => {
        component.bindings.forEach((binding, bindingIndex) => {
          const bindingPath = `$.scenes[${sceneIndex}].nodes[${nodeIndex}].components[${componentIndex}].bindings[${bindingIndex}].source.ref`;
          if (binding.source.type === "game_state") checkRef(binding.source.ref, states, bindingPath, "game state", issues);
          if (binding.source.type === "input_action") checkRef(binding.source.ref, actions, bindingPath, "input action", issues);
          if (binding.source.type === "runtime_signal") {
            checkRef(binding.source.ref, new Set(signals.keys()), bindingPath, "runtime signal", issues);
            const signal = signals.get(binding.source.ref);
            if (signal?.visibility !== "public") {
              issue(
                issues,
                bindingPath,
                "incompatible_reference",
                "Scene bindings may only consume public runtime signals.",
              );
            }
          }
        });
      });
    });
  });
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function validatePlaytestContractCompatibility(
  playtest: PlaytestContract,
  contract: GameContract,
  blueprint?: SceneBlueprint,
): ContractCompatibilityResult {
  const issues: ContractValidationIssue[] = [];
  validateContractReferenceCompatibility(playtest.gameContract, contract, "$.gameContract", issues);
  const states = new Set(contract.stateModel.states.map((state) => state.stateId));
  const actions = new Set(contract.inputModel.actions.map((action) => action.actionId));
  const signals = new Map(contract.runtimeSignals.signals.map((signal) => [signal.signalId, signal]));
  const testIds = new Set(blueprint?.scenes.flatMap((scene) => scene.nodes.map((node) => node.testId)) ?? []);
  playtest.scenarios.forEach((scenario, scenarioIndex) => {
    const scenarioPath = `$.scenarios[${scenarioIndex}]`;
    checkRef(scenario.startState, states, `${scenarioPath}.startState`, "game state", issues);
    checkRef(scenario.expectedEndState, states, `${scenarioPath}.expectedEndState`, "game state", issues);
    scenario.steps.forEach((step, stepIndex) => {
      const stepPath = `${scenarioPath}.steps[${stepIndex}]`;
      if (step.action?.type === "input") checkRef(step.action.actionId, actions, `${stepPath}.action.actionId`, "input action", issues);
      const validateAssertions = (assertions: PlaytestAssertion[], assertionsPath: string): void => {
        assertions.forEach((assertion, assertionIndex) => {
        const assertionPath = `${assertionsPath}[${assertionIndex}]`;
        if (assertion.type === "state") checkRef(assertion.stateId, states, `${assertionPath}.stateId`, "game state", issues);
        if (assertion.type === "node") {
          if (!blueprint) {
            issue(issues, `${assertionPath}.testId`, "incompatible_reference", "Node assertions require a SceneBlueprint.");
          } else {
            checkRef(assertion.testId, testIds, `${assertionPath}.testId`, "scene test id", issues);
          }
        }
        if (assertion.type === "signal") {
          const signal = signals.get(assertion.signalId);
          if (!signal) {
            issue(issues, `${assertionPath}.signalId`, "unknown_reference", `Unknown runtime signal '${assertion.signalId}'.`);
          } else {
            if (signal.visibility !== "public") {
              issue(
                issues,
                `${assertionPath}.signalId`,
                "incompatible_reference",
                `Playtests may only assert public signals; '${assertion.signalId}' is internal.`,
              );
            }
            const condition: RuntimeCondition = assertion.expected === undefined
              ? { signalId: assertion.signalId, operator: assertion.operator }
              : { signalId: assertion.signalId, operator: assertion.operator, value: assertion.expected };
            validateConditionReferences([condition], signals, assertionPath, issues);
          }
        }
      });
      };
      validateAssertions(step.assertions, `${stepPath}.assertions`);
      if (step.repeat) validateAssertions(step.repeat.until, `${stepPath}.repeat.until`);
    });
  });
  playtest.qualityGates.forEach((gate, gateIndex) => {
    const signal = signals.get(gate.signalId);
    const gatePath = `$.qualityGates[${gateIndex}]`;
    if (!signal) {
      issue(issues, `${gatePath}.signalId`, "unknown_reference", `Unknown runtime signal '${gate.signalId}'.`);
    } else {
      if (signal.visibility !== "public") {
        issue(issues, `${gatePath}.signalId`, "incompatible_reference", `Quality gates may only use public signals; '${gate.signalId}' is internal.`);
      }
      if (!valueMatchesSignal(gate.expected, signal.valueType)) {
        issue(issues, `${gatePath}.expected`, "incompatible_reference", `Gate value does not match signal type '${signal.valueType}'.`);
      }
      if ((gate.aggregation === "min" || gate.aggregation === "max" || gate.aggregation === "average" || gate.aggregation === "sum")
        && signal.valueType !== "integer" && signal.valueType !== "number") {
        issue(issues, `${gatePath}.aggregation`, "incompatible_reference", `Aggregation '${gate.aggregation}' requires a numeric signal.`);
      }
    }
  });
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export interface ProductionContractBundle {
  gameContract: GameContract;
  sceneBlueprint: SceneBlueprint;
  playtestContract: PlaytestContract;
}

export function validateProductionContractBundle(value: unknown): ContractValidationResult<ProductionContractBundle> {
  const issues: ContractValidationIssue[] = [];
  const root = objectAt(value, "$", issues);
  if (!root) return { ok: false, issues };
  strictKeys(root, "$", ["gameContract", "sceneBlueprint", "playtestContract"], ["gameContract", "sceneBlueprint", "playtestContract"], issues);
  const gameResult = validateGameContract(root.gameContract);
  const sceneResult = validateSceneBlueprint(root.sceneBlueprint);
  const playtestResult = validatePlaytestContract(root.playtestContract);
  if (!gameResult.ok) issues.push(...prefixIssues(gameResult.issues, "$.gameContract"));
  if (!sceneResult.ok) issues.push(...prefixIssues(sceneResult.issues, "$.sceneBlueprint"));
  if (!playtestResult.ok) issues.push(...prefixIssues(playtestResult.issues, "$.playtestContract"));
  if (!gameResult.ok || !sceneResult.ok || !playtestResult.ok || issues.length > 0) return { ok: false, issues };
  const sceneCompatibility = validateSceneBlueprintCompatibility(sceneResult.value, gameResult.value);
  const playtestCompatibility = validatePlaytestContractCompatibility(playtestResult.value, gameResult.value, sceneResult.value);
  if (!sceneCompatibility.ok) issues.push(...prefixIssues(sceneCompatibility.issues, "$.sceneBlueprint"));
  if (!playtestCompatibility.ok) issues.push(...prefixIssues(playtestCompatibility.issues, "$.playtestContract"));
  return issues.length === 0
    ? {
        ok: true,
        value: {
          gameContract: gameResult.value,
          sceneBlueprint: sceneResult.value,
          playtestContract: playtestResult.value,
        },
      }
    : { ok: false, issues };
}

export function parseProductionContractBundle(value: unknown): ProductionContractBundle {
  const result = validateProductionContractBundle(value);
  if (!result.ok) throw new ContractValidationError("ProductionContractBundle", result.issues);
  return result.value;
}

function prefixIssues(issues: ContractValidationIssue[], prefix: string): ContractValidationIssue[] {
  return issues.map((entry) => ({
    ...entry,
    path: entry.path === "$" ? prefix : `${prefix}${entry.path.slice(1)}`,
  }));
}
