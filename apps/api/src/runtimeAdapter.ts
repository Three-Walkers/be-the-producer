import type { PlaytestAction } from "@game-pipeline/shared-schemas";

/**
 * Public protocol exposed by a game build at `globalThis.__BTP_PLAYTEST__`.
 *
 * The runtime reports facts only. It never reports a QA verdict; verdicts are
 * calculated by the server-side PlaytestContract runner.
 */
export const BTP_PLAYTEST_PROTOCOL_VERSION = "1.0.0" as const;

export type RuntimeSignalValue = string | number | boolean | null;

export interface RuntimeAdapterHandshake {
  protocolVersion: typeof BTP_PLAYTEST_PROTOCOL_VERSION;
  playtestId: string;
  revision: number;
  contractHash?: string;
}

export interface RuntimeAdapterNodeSnapshot {
  visible: boolean;
  enabled?: boolean;
  text?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface RuntimeAdapterEvent {
  sequence: number;
  type: string;
  payload?: unknown;
}

export interface RuntimeAdapterSnapshot {
  sequence: number;
  timestampMs: number;
  state: string;
  signals: Record<string, RuntimeSignalValue>;
  nodes: Record<string, RuntimeAdapterNodeSnapshot>;
  recentEvents: RuntimeAdapterEvent[];
}

export interface RuntimeAdapterActionResult {
  ok: boolean;
  details?: string;
}

/** Narrow interface used by the contract runner and by deterministic fakes. */
export interface RuntimeAdapter {
  getHandshake(): Promise<RuntimeAdapterHandshake>;
  getSnapshot(): Promise<RuntimeAdapterSnapshot>;
  perform(action: PlaytestAction): Promise<RuntimeAdapterActionResult>;
  wait(durationMs: number): Promise<void>;
  /** Restores the build to a clean scenario start and waits for the API. */
  reset(): Promise<void>;
}

export interface ExpectedRuntimeContract {
  playtestId: string;
  revision: number;
  contractHash?: string;
}

export interface RuntimeHandshakeVerification {
  handshake: RuntimeAdapterHandshake;
  hashVerified: boolean;
}

export function verifyRuntimeHandshake(
  handshake: RuntimeAdapterHandshake,
  expected: ExpectedRuntimeContract
): RuntimeHandshakeVerification {
  if (handshake.protocolVersion !== BTP_PLAYTEST_PROTOCOL_VERSION) {
    throw new Error(
      `运行时协议版本不匹配：期望 ${BTP_PLAYTEST_PROTOCOL_VERSION}，实际 ${String(handshake.protocolVersion)}`
    );
  }
  if (handshake.playtestId !== expected.playtestId) {
    throw new Error(`运行时 PlaytestContract id 不匹配：期望 ${expected.playtestId}，实际 ${handshake.playtestId}`);
  }
  if (handshake.revision !== expected.revision) {
    throw new Error(`运行时 PlaytestContract revision 不匹配：期望 ${expected.revision}，实际 ${handshake.revision}`);
  }
  if (expected.contractHash && !handshake.contractHash) {
    throw new Error("运行时 PlaytestContract 握手缺少 contractHash，无法证明构建消费了当前契约。");
  }
  if (handshake.contractHash && expected.contractHash && handshake.contractHash !== expected.contractHash) {
    throw new Error(`运行时 PlaytestContract hash 不匹配：期望 ${expected.contractHash}，实际 ${handshake.contractHash}`);
  }
  return {
    handshake,
    hashVerified: Boolean(handshake.contractHash && expected.contractHash && handshake.contractHash === expected.contractHash)
  };
}

export function assertRuntimeSnapshot(value: unknown): RuntimeAdapterSnapshot {
  if (!isRecord(value)) throw new Error("运行时 getSnapshot() 必须返回对象。");
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 0) {
    throw new Error("运行时 snapshot.sequence 必须是非负整数。");
  }
  if (typeof value.timestampMs !== "number" || !Number.isFinite(value.timestampMs)) {
    throw new Error("运行时 snapshot.timestampMs 必须是有限数值。");
  }
  if (typeof value.state !== "string" || !value.state.trim()) {
    throw new Error("运行时 snapshot.state 必须是非空字符串。");
  }
  if (!isRecord(value.signals)) throw new Error("运行时 snapshot.signals 必须是对象。");
  if (!isRecord(value.nodes)) throw new Error("运行时 snapshot.nodes 必须是对象。");
  if (!Array.isArray(value.recentEvents)) throw new Error("运行时 snapshot.recentEvents 必须是数组。");

  const signals: Record<string, RuntimeSignalValue> = {};
  for (const [signalId, signalValue] of Object.entries(value.signals)) {
    if (signalValue !== null && !["string", "number", "boolean"].includes(typeof signalValue)) {
      throw new Error(`运行时信号 ${signalId} 不是标量。`);
    }
    if (typeof signalValue === "number" && !Number.isFinite(signalValue)) {
      throw new Error(`运行时信号 ${signalId} 不是有限数值。`);
    }
    signals[signalId] = signalValue as RuntimeSignalValue;
  }

  const nodes: Record<string, RuntimeAdapterNodeSnapshot> = {};
  for (const [testId, candidate] of Object.entries(value.nodes)) {
    if (!isRecord(candidate) || typeof candidate.visible !== "boolean") {
      throw new Error(`运行时节点 ${testId} 缺少 boolean visible。`);
    }
    const node: RuntimeAdapterNodeSnapshot = { visible: candidate.visible };
    if (candidate.enabled !== undefined) {
      if (typeof candidate.enabled !== "boolean") throw new Error(`运行时节点 ${testId}.enabled 必须是 boolean。`);
      node.enabled = candidate.enabled;
    }
    if (candidate.text !== undefined) {
      if (typeof candidate.text !== "string") throw new Error(`运行时节点 ${testId}.text 必须是 string。`);
      node.text = candidate.text;
    }
    if (candidate.bounds !== undefined) {
      if (!isBounds(candidate.bounds)) throw new Error(`运行时节点 ${testId}.bounds 无效。`);
      node.bounds = candidate.bounds;
    }
    nodes[testId] = node;
  }

  const recentEvents = value.recentEvents.map((candidate, index) => {
    if (!isRecord(candidate) || !Number.isInteger(candidate.sequence) || typeof candidate.type !== "string") {
      throw new Error(`运行时 recentEvents[${index}] 无效。`);
    }
    return {
      sequence: Number(candidate.sequence),
      type: candidate.type,
      ...(candidate.payload !== undefined ? { payload: candidate.payload } : {})
    };
  });

  return {
    sequence: Number(value.sequence),
    timestampMs: value.timestampMs,
    state: value.state,
    signals,
    nodes,
    recentEvents
  };
}

function isBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) return false;
  return [value.x, value.y, value.width, value.height].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    Number(value.width) >= 0 && Number(value.height) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
