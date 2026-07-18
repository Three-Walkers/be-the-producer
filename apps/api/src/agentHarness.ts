import type { AgentContract, AgentHarnessId, AgentLoopControl } from "@game-pipeline/shared-schemas";
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
  sessionId?: string;
  abortSignal?: AbortSignal;
}

export interface AgentHarnessRunResult {
  harnessId: AgentHarnessId;
  invocationId: string;
  content: string;
  sessionId?: string;
  model: string;
  providerId: string;
  latencyMs: number;
  rawEventCount: number;
  changedPaths?: string[];
  loopControl?: AgentLoopControl;
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
