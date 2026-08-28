import type { AgentContract, AgentHarnessId, AgentLoopControl, AgentSessionScope, Artifact, ArtifactDirectoryManifest, ArtifactInputProvenance } from "@game-pipeline/shared-schemas";
import type { ModelProviderConfig } from "./modelSettings.js";
import type { ArtVisionAuthoritativeContextEvidence, ArtVisionSemanticResult } from "./multimodalArtProvider.js";
import type { VisionSemanticInspectionReceipt } from "./qualityReviewArtifacts.js";

export type AgentHarnessProgressType = "started" | "model_output" | "tool_started" | "tool_completed" | "completed" | "failed";

export interface AgentHarnessProgressEvent {
  type: AgentHarnessProgressType;
  invocationId: string;
  createdAt: string;
  resumed?: boolean;
  toolName?: string;
  path?: string;
  progressPercent?: number;
  detail?: string;
}

export interface AgentHarnessRunInput {
  projectId: string;
  projectRoot: string;
  agent: AgentContract;
  provider: ModelProviderConfig;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  authorization: AgentHarnessAuthorization;
  expectedPaths?: string[];
  taskInputEvidence?: ArtifactInputProvenance[];
  requireToolProgress?: boolean;
  toolMode?: "conversation" | "task";
  sessionKey?: string;
  sessionScope?: AgentSessionScope;
  sessionId?: string;
  timeoutMs?: number;
  initialProgressTimeoutMs?: number;
  idleTimeoutMs?: number;
  effort?: "low" | "medium" | "high" | "max";
  includePartialMessages?: boolean;
  abortSignal?: AbortSignal;
  onProgress?: (event: AgentHarnessProgressEvent) => void;
}

export interface AgentHarnessAuthorizationArtifact {
  artifactId: Artifact["artifactId"];
  type: Artifact["type"];
  path: string;
  ownerAgentId: Artifact["ownerAgentId"];
  sourceTaskId?: Artifact["sourceTaskId"];
}

export interface AgentHarnessAuthorization {
  mode: "conversation" | "task";
  taskId?: string;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  artifacts: AgentHarnessAuthorizationArtifact[];
  readRoots: string[];
  serviceReadPaths: string[];
  serviceWritePaths: string[];
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
  firstOutputMs?: number;
  rawEventCount: number;
  changedPaths?: string[];
  toolOperations?: AgentHarnessToolOperation[];
  loopControl?: AgentLoopControl;
  terminationReason?: "expected_outputs_materialized" | "idle_after_progress" | "timeout_with_progress" | "process_exit_with_progress";
}

export interface AgentHarnessToolOperation {
  toolName: string;
  path: string;
  access?: "read" | "write";
  status?: "completed" | "failed";
  bridgeOk?: boolean;
  operationId?: string;
  operationType?: string;
  directoryManifest?: ArtifactDirectoryManifest;
  error?: string;
  hash?: string;
  sizeBytes?: number;
  providerId?: string;
  model?: string;
  requestId?: string;
  promptHash?: string;
  negativePromptHash?: string;
  seed?: number;
  width?: number;
  height?: number;
  mime?: string;
  endpointFingerprint?: string;
  latencyMs?: number;
  inspectedPaths?: string[];
  inspectedEvidence?: Array<{ path: string; hash: string; sizeBytes: number }>;
  visionResponseHash?: string;
  visionSemanticHash?: string;
  visionSemanticResult?: ArtVisionSemanticResult;
  authoritativeContextEvidence?: ArtVisionAuthoritativeContextEvidence[];
  authoritativeContextHash?: string;
  requestSemanticHash?: string;
  visionSemanticReceipts?: VisionSemanticInspectionReceipt[];
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
