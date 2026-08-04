import type { AgentContract, AgentHarnessId, AgentLoopControl, AgentSessionScope } from "@game-pipeline/shared-schemas";
import type { ModelProviderConfig } from "./modelSettings.js";

export interface AgentHarnessRunInput {
  projectId: string;
  projectRoot: string;
  agent: AgentContract;
  provider: ModelProviderConfig;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  allowedRoots?: string[];
  expectedPaths?: string[];
  requireToolProgress?: boolean;
  toolMode?: "conversation" | "task";
  sessionKey?: string;
  sessionScope?: AgentSessionScope;
  sessionId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface AgentHarnessRunResult {
  harnessId: AgentHarnessId;
  invocationId: string;
  content: string;
  sessionId?: string;
  resumeAttempted?: boolean;
  resumed?: boolean;
  model: string;
  providerId: string;
  latencyMs: number;
  rawEventCount: number;
  changedPaths?: string[];
  toolOperations?: AgentHarnessToolOperation[];
  loopControl?: AgentLoopControl;
  terminationReason?: "expected_outputs_materialized" | "idle_after_progress" | "timeout_with_progress" | "process_exit_with_progress";
}

export interface AgentHarnessToolOperation {
  toolName: string;
  path: string;
  hash?: string;
  sizeBytes?: number;
  recordedAt?: string;
}

export interface AgentHarnessStatus {
  harnessId: AgentHarnessId;
  label: string;
  available: boolean;
  version?: string;
  executable?: string;
  message: string;
  testedAt: string;
}

export interface AgentHarness {
  readonly harnessId: AgentHarnessId;
  run(input: AgentHarnessRunInput): Promise<AgentHarnessRunResult>;
  status(): Promise<AgentHarnessStatus>;
}
