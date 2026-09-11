import type {
  PlaytestAction,
  PlaytestAssertion,
  PlaytestContract,
  PlaytestQualityGate,
  PlaytestScenario,
  PlaytestStep,
  RuntimeConditionOperator
} from "@game-pipeline/shared-schemas";
import {
  verifyRuntimeHandshake,
  type ExpectedRuntimeContract,
  type RuntimeAdapter,
  type RuntimeAdapterHandshake,
  type RuntimeAdapterSnapshot,
  type RuntimeHandshakeVerification,
  type RuntimeSignalValue
} from "./runtimeAdapter.js";

export interface PlaytestAssertionResult {
  assertion: PlaytestAssertion;
  passed: boolean;
  actual?: RuntimeSignalValue | string;
  details: string;
}

export interface PlaytestContractStepResult {
  stepId: string;
  required: boolean;
  passed: boolean;
  iterations: number;
  assertions: PlaytestAssertionResult[];
  state: string;
  details: string;
}

export interface PlaytestContractScenarioResult {
  scenarioId: string;
  title: string;
  required: boolean;
  passed: boolean;
  initialState: string;
  finalState: string;
  steps: PlaytestContractStepResult[];
  evidencePaths: string[];
  details: string;
}

export interface PlaytestQualityGateResult {
  gateId: string;
  passed: boolean;
  actual?: RuntimeSignalValue;
  details: string;
}

export interface PlaytestContractRunResult {
  passed: boolean;
  handshake: RuntimeAdapterHandshake;
  hashVerified: boolean;
  scenarios: PlaytestContractScenarioResult[];
  qualityGates: PlaytestQualityGateResult[];
  snapshots: RuntimeAdapterSnapshot[];
}

export interface PlaytestContractRunnerObserver {
  onScenarioCompleted?(input: {
    scenario: PlaytestScenario;
    scenarioIndex: number;
    snapshot: RuntimeAdapterSnapshot;
  }): Promise<string[] | void>;
}

export interface PlaytestContractRunnerInput {
  contract: PlaytestContract;
  contractHash?: string;
  adapter: RuntimeAdapter;
  observer?: PlaytestContractRunnerObserver;
  pollIntervalMs?: number;
}

export async function runPlaytestContract(input: PlaytestContractRunnerInput): Promise<PlaytestContractRunResult> {
  const expected: ExpectedRuntimeContract = {
    playtestId: input.contract.playtestId,
    revision: input.contract.revision,
    ...(input.contractHash ? { contractHash: input.contractHash } : {})
  };
  const handshakeDeadline = Date.now() + input.contract.environment.maxScenarioDurationMs;
  const verification: RuntimeHandshakeVerification = verifyRuntimeHandshake(
    await beforeDeadline(input.adapter.getHandshake(), handshakeDeadline, "初始运行时握手"),
    expected
  );
  const snapshots: RuntimeAdapterSnapshot[] = [];
  let lastSequence = -1;
  const capture = async (deadline: number): Promise<RuntimeAdapterSnapshot> => {
    const snapshot = await beforeDeadline(input.adapter.getSnapshot(), deadline, "读取运行时快照");
    if (snapshot.sequence < lastSequence) {
      throw new Error(`运行时 snapshot.sequence 倒退：${lastSequence} -> ${snapshot.sequence}`);
    }
    lastSequence = snapshot.sequence;
    snapshots.push(snapshot);
    return snapshot;
  };

  const scenarios: PlaytestContractScenarioResult[] = [];
  for (const [scenarioIndex, scenario] of input.contract.scenarios.entries()) {
    const scenarioDeadline = Date.now() + input.contract.environment.maxScenarioDurationMs;
    await beforeDeadline(input.adapter.reset(), scenarioDeadline, `重置场景 ${scenario.scenarioId}`);
    const scenarioHandshake = verifyRuntimeHandshake(
      await beforeDeadline(input.adapter.getHandshake(), scenarioDeadline, `场景 ${scenario.scenarioId} 运行时握手`),
      expected
    );
    if (scenarioHandshake.handshake.contractHash !== verification.handshake.contractHash) {
      throw new Error(`运行时 reset 后契约 hash 发生变化：${String(verification.handshake.contractHash)} -> ${String(scenarioHandshake.handshake.contractHash)}`);
    }
    // A reload creates a new runtime timeline; sequence monotonicity applies
    // inside one scenario, not across independent scenario executions.
    lastSequence = -1;
    const initial = await capture(scenarioDeadline);
    const stepResults: PlaytestContractStepResult[] = [];
    const startsCorrectly = initial.state === scenario.startState;
    let scenarioPassed = startsCorrectly;
    let scenarioDetails = startsCorrectly
      ? `初始状态符合契约：${scenario.startState}。`
      : `初始状态不符合契约：期望 ${scenario.startState}，实际 ${initial.state}。`;

    for (const step of scenario.steps) {
      if (Date.now() > scenarioDeadline) {
        scenarioPassed = false;
        scenarioDetails = `场景超过绝对预算 ${input.contract.environment.maxScenarioDurationMs}ms。`;
        break;
      }
      const result = await executeStep({
        step,
        adapter: input.adapter,
        capture,
        previousSnapshot: snapshots.at(-1) ?? initial,
        pollIntervalMs: input.pollIntervalMs ?? 100,
        scenarioDeadline
      });
      stepResults.push(result);
      if (step.required && !result.passed) {
        scenarioPassed = false;
        scenarioDetails = `必需步骤 ${step.stepId} 未通过：${result.details}`;
        break;
      }
    }

    const final = snapshots.at(-1) ?? initial;
    if (final.state !== scenario.expectedEndState) {
      scenarioPassed = false;
      scenarioDetails = `${scenarioDetails} 终态期望 ${scenario.expectedEndState}，实际 ${final.state}。`;
    }
    const evidencePaths = input.observer?.onScenarioCompleted
      ? await beforeDeadline(
          Promise.resolve(input.observer.onScenarioCompleted({ scenario, scenarioIndex, snapshot: final })),
          scenarioDeadline,
          `场景 ${scenario.scenarioId} 取证`
        ) ?? []
      : [];
    if (Date.now() > scenarioDeadline) {
      scenarioPassed = false;
      scenarioDetails = `场景超过绝对预算 ${input.contract.environment.maxScenarioDurationMs}ms（包括取证开销）。`;
    }
    scenarios.push({
      scenarioId: scenario.scenarioId,
      title: scenario.title,
      required: scenario.required,
      passed: scenarioPassed,
      initialState: initial.state,
      finalState: final.state,
      steps: stepResults,
      evidencePaths,
      details: scenarioPassed ? `${scenario.title} 符合 PlaytestContract。` : scenarioDetails
    });
  }

  const qualityGates = input.contract.qualityGates.map((gate) => evaluateQualityGate(gate, snapshots));
  return {
    passed: scenarios.every((scenario) => !scenario.required || scenario.passed) && qualityGates.every((gate) => gate.passed),
    handshake: verification.handshake,
    hashVerified: verification.hashVerified,
    scenarios,
    qualityGates,
    snapshots
  };
}

async function executeStep(input: {
  step: PlaytestStep;
  adapter: RuntimeAdapter;
  capture: (deadline: number) => Promise<RuntimeAdapterSnapshot>;
  previousSnapshot: RuntimeAdapterSnapshot;
  pollIntervalMs: number;
  scenarioDeadline: number;
}): Promise<PlaytestContractStepResult> {
  const { step, adapter } = input;
  const deadline = Math.min(Date.now() + step.timeoutMs, input.scenarioDeadline);
  const capture = () => input.capture(deadline);
  let iterations = 0;
  let snapshot = input.previousSnapshot;
  try {
    snapshot = await capture();
    if (step.repeat) {
      let reachedUntil = false;
      if (evaluateAssertions(step.repeat.until, snapshot).every((result) => result.passed)) {
        reachedUntil = true;
      }
      while (iterations < step.repeat.maxIterations && Date.now() <= deadline) {
        if (reachedUntil) break;
        iterations += 1;
        await performAction(adapter, step.action, deadline);
        snapshot = await capture();
        if (evaluateAssertions(step.repeat.until, snapshot).every((result) => result.passed)) {
          reachedUntil = true;
          break;
        }
        await beforeDeadline(
          adapter.wait(Math.min(input.pollIntervalMs, Math.max(0, deadline - Date.now()))),
          deadline,
          `步骤 ${step.stepId} 等待运行时更新`
        );
      }
      if (!reachedUntil) {
        const until = evaluateAssertions(step.repeat.until, snapshot);
        return stepFailure(
          step,
          iterations,
          snapshot,
          until,
          Date.now() > input.scenarioDeadline
            ? "场景绝对执行预算已耗尽。"
            : `重复动作未在 ${iterations} 次内达到 until 条件。`
        );
      }
    } else {
      iterations = step.action ? 1 : 0;
      await performAction(adapter, step.action, deadline);
      // Assertions and final-state/quality-gate evidence must describe the
      // outcome, even when they were already true before the action (or empty).
      if (step.action) snapshot = await capture();
    }

    let assertions = evaluateAssertions(step.assertions, snapshot);
    while (!assertions.every((result) => result.passed) && Date.now() <= deadline) {
      await beforeDeadline(
        adapter.wait(Math.min(input.pollIntervalMs, Math.max(0, deadline - Date.now()))),
        deadline,
        `步骤 ${step.stepId} 等待断言`
      );
      snapshot = await capture();
      assertions = evaluateAssertions(step.assertions, snapshot);
    }
    const passed = assertions.every((result) => result.passed);
    if (Date.now() > deadline) {
      return stepFailure(
        step,
        iterations,
        snapshot,
        assertions,
        "步骤绝对执行预算已耗尽。"
      );
    }
    return {
      stepId: step.stepId,
      required: step.required,
      passed,
      iterations,
      assertions,
      state: snapshot.state,
      details: passed
        ? `步骤 ${step.stepId} 的 ${assertions.length} 个断言均通过。`
        : `步骤 ${step.stepId} 断言失败：${assertions.filter((result) => !result.passed).map((result) => result.details).join("；")}`
    };
  } catch (error) {
    return stepFailure(
      step,
      iterations,
      snapshot,
      evaluateAssertions(step.assertions, snapshot),
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function performAction(adapter: RuntimeAdapter, action: PlaytestAction | undefined, deadline: number): Promise<void> {
  if (!action) return;
  const result = await beforeDeadline(adapter.perform(action), deadline, `执行动作 ${action.type}`);
  if (!result.ok) throw new Error(result.details ?? `运行时拒绝动作 ${action.type}。`);
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`场景绝对执行预算已耗尽：${label}。`);
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`场景绝对执行预算已耗尽：${label}。`)),
          remainingMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function stepFailure(
  step: PlaytestStep,
  iterations: number,
  snapshot: RuntimeAdapterSnapshot,
  assertions: PlaytestAssertionResult[],
  details: string
): PlaytestContractStepResult {
  return {
    stepId: step.stepId,
    required: step.required,
    passed: false,
    iterations,
    assertions,
    state: snapshot.state,
    details
  };
}

export function evaluateAssertions(
  assertions: PlaytestAssertion[],
  snapshot: RuntimeAdapterSnapshot
): PlaytestAssertionResult[] {
  return assertions.map((assertion) => {
    if (assertion.type === "state") {
      const passed = snapshot.state === assertion.stateId;
      return {
        assertion,
        passed,
        actual: snapshot.state,
        details: passed
          ? `状态为 ${assertion.stateId}。`
          : `状态期望 ${assertion.stateId}，实际 ${snapshot.state}。`
      };
    }
    if (assertion.type === "signal") {
      const exists = Object.prototype.hasOwnProperty.call(snapshot.signals, assertion.signalId);
      const actual = snapshot.signals[assertion.signalId];
      const passed = compareValue(actual, assertion.operator, assertion.expected, exists);
      return {
        assertion,
        passed,
        ...(actual !== undefined ? { actual } : {}),
        details: passed
          ? `信号 ${assertion.signalId} 满足 ${assertion.operator}。`
          : `信号 ${assertion.signalId}=${String(actual)} 不满足 ${assertion.operator} ${String(assertion.expected)}。`
      };
    }
    const node = snapshot.nodes[assertion.testId];
    const passed = Boolean(node) && (
      assertion.expectation === "visible" ? node?.visible === true :
        assertion.expectation === "hidden" ? node?.visible === false :
          assertion.expectation === "enabled" ? node?.enabled === true : node?.enabled === false
    );
    return {
      assertion,
      passed,
      actual: node ? `${node.visible ? "visible" : "hidden"}/${node.enabled === undefined ? "enabled:unknown" : node.enabled ? "enabled" : "disabled"}` : "missing",
      details: passed
        ? `节点 ${assertion.testId} 为 ${assertion.expectation}。`
        : `节点 ${assertion.testId} 期望 ${assertion.expectation}，实际 ${node ? JSON.stringify(node) : "missing"}。`
    };
  });
}

function evaluateQualityGate(gate: PlaytestQualityGate, snapshots: RuntimeAdapterSnapshot[]): PlaytestQualityGateResult {
  const values = snapshots
    .filter((snapshot) => Object.prototype.hasOwnProperty.call(snapshot.signals, gate.signalId))
    .map((snapshot) => snapshot.signals[gate.signalId])
    .filter((value): value is RuntimeSignalValue => value !== undefined);
  if (values.length === 0) {
    return { gateId: gate.gateId, passed: false, details: `质量门禁缺少信号 ${gate.signalId}。` };
  }
  let actual: RuntimeSignalValue;
  if (gate.aggregation === "last") {
    actual = values.at(-1) ?? null;
  } else {
    const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (numeric.length !== values.length) {
      return { gateId: gate.gateId, passed: false, details: `质量门禁 ${gate.gateId} 的 ${gate.aggregation} 聚合要求数值信号。` };
    }
    actual = gate.aggregation === "min" ? Math.min(...numeric) :
      gate.aggregation === "max" ? Math.max(...numeric) :
        gate.aggregation === "sum" ? numeric.reduce((sum, value) => sum + value, 0) :
          numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  }
  const passed = compareValue(actual, gate.operator, gate.expected, true);
  return {
    gateId: gate.gateId,
    passed,
    actual,
    details: passed
      ? `质量门禁 ${gate.gateId} 通过：${gate.signalId} ${gate.operator} ${String(gate.expected)}，实际 ${String(actual)}。`
      : `质量门禁 ${gate.gateId} 失败：${gate.signalId} ${gate.operator} ${String(gate.expected)}，实际 ${String(actual)}。`
  };
}

function compareValue(
  actual: RuntimeSignalValue | undefined,
  operator: RuntimeConditionOperator,
  expected: string | number | boolean | undefined,
  exists: boolean
): boolean {
  if (operator === "exists") return exists;
  if (operator === "not_exists") return !exists;
  if (!exists || actual === null || actual === undefined || expected === undefined) return false;
  if (operator === "eq") return actual === expected;
  if (operator === "not_eq") return actual !== expected;
  if ((typeof actual !== "number" && typeof actual !== "string") ||
      (typeof expected !== "number" && typeof expected !== "string")) return false;
  if (typeof actual !== typeof expected) return false;
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  return actual <= expected;
}
