export type ProjectId = string;
export type RoomId = string;
export type MessageId = string;
export type AgentId = string;
export type TaskId = string;
export type ArtifactId = string;
export type DecisionId = string;
export type MemoryId = string;
export type AuditEventId = string;
export type OperationId = string;
export type ClaimId = string;
export type AgentHarnessId = "direct-api" | "claude-cli";

export type AgentSessionScope = "room" | "task_child";
export type AgentSessionStatus = "active" | "sealed" | "recovering" | "failed";
export type ContextHealthStatus = "healthy" | "degraded" | "stale" | "oversized";
export type ContextPacketLayerKind =
  | "identity"
  | "durable_memory"
  | "role_cross_room_memory"
  | "task_state"
  | "artifact_evidence"
  | "handoff_capsules"
  | "room_delta"
  | "room_digest";
export type HandoffCapsuleKind = "parent_to_child" | "child_to_parent" | "agent_handoff" | "resume_recovery";

export interface RoomContextCursor {
  roomId: RoomId;
  lastMessageId?: MessageId;
  lastMessageCreatedAt?: string;
  deliveredMessageCount: number;
  updatedAt: string;
}

export interface ContextHealth {
  status: ContextHealthStatus;
  score: number;
  estimatedTokens: number;
  budgetTokens: number;
  deltaMessageCount: number;
  omittedMessageCount: number;
  staleCursor: boolean;
  reasons: string[];
  checkedAt: string;
}

export interface ContextPacketLayer {
  kind: ContextPacketLayerKind;
  title: string;
  content: string;
  sourceRefs: string[];
  truncated: boolean;
}

export interface ContextPacket {
  packetId: string;
  projectId: ProjectId;
  sessionKey: string;
  agentId: AgentId;
  roomId: RoomId;
  taskId?: TaskId;
  cursorBefore: RoomContextCursor;
  cursorAfter: RoomContextCursor;
  layers: ContextPacketLayer[];
  health: ContextHealth;
  createdAt: string;
}

export interface AgentSessionRecord {
  sessionKey: string;
  logicalSessionKey: string;
  projectId: ProjectId;
  agentId: AgentId;
  roomId: RoomId;
  taskId?: TaskId;
  scope: AgentSessionScope;
  parentSessionKey?: string;
  predecessorSessionKey?: string;
  harnessId: AgentHarnessId;
  providerId: string;
  model: string;
  sessionId?: string;
  epoch: number;
  status: AgentSessionStatus;
  cursor: RoomContextCursor;
  contextHealth?: ContextHealth;
  contextTokensEstimate: number;
  resumeFailureCount: number;
  lastContextPacketId?: string;
  lastInvocationId?: string;
  incomingCapsuleIds: string[];
  outgoingCapsuleIds: string[];
  sealReason?: string;
  sealedAt?: string;
  lastSuccessfulAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionHandoffCapsule {
  capsuleId: string;
  projectId: ProjectId;
  kind: HandoffCapsuleKind;
  sourceSessionKey: string;
  targetSessionKeys: string[];
  sourceAgentId: AgentId;
  targetAgentIds: AgentId[];
  roomId: RoomId;
  taskId?: TaskId;
  summary: string;
  messageIds: MessageId[];
  artifactIds: ArtifactId[];
  changedPaths: string[];
  contextHealth?: ContextHealth;
  consumedBySessionKeys: string[];
  createdAt: string;
}

export type AgentLoopStatus = "idle" | "running" | "waiting_for_producer" | "paused" | "blocked" | "error";
export type AgentLoopAgentStatus = "idle" | "queued" | "working" | "waiting" | "blocked" | "error";
export type AgentLoopControlStatus = "continue" | "waiting_for_producer" | "handoff" | "ready_for_review" | "blocked";

export interface AgentLoopAgentState {
  agentId: AgentId;
  status: AgentLoopAgentStatus;
  taskId?: TaskId;
  iteration: number;
  harnessId?: AgentHarnessId;
  sessionId?: string;
  lastInvocationId?: string;
  lastChangedPaths?: string[];
  lastMessageId?: MessageId;
  lastError?: string;
  updatedAt: string;
}

export interface AgentLoopState {
  projectId: ProjectId;
  status: AgentLoopStatus;
  runId?: string;
  iteration: number;
  activeAgentIds: AgentId[];
  pendingTaskIds: TaskId[];
  agents: Record<AgentId, AgentLoopAgentState>;
  waitingReason?: string;
  lastError?: string;
  startedAt?: string;
  updatedAt: string;
}

export interface AgentLoopControl {
  status: AgentLoopControlStatus;
  reason: string;
  handoffAgentIds: AgentId[];
}

export type AgentActivityKind = "room_response" | "task_execution";
export type AgentActivityStatus = "thinking" | "working" | "tool_call" | "finalizing" | "failed";
export type AgentActivityStepStatus = "active" | "completed" | "failed";

export interface AgentActivityStep {
  stepId: string;
  phase: string;
  label: string;
  detail?: string;
  status: AgentActivityStepStatus;
  progressPercent: number;
  createdAt: string;
}

export interface AgentActivity {
  activityId: string;
  projectId: ProjectId;
  roomId: RoomId;
  agentId: AgentId;
  kind: AgentActivityKind;
  status: AgentActivityStatus;
  label: string;
  detail?: string;
  progressPercent: number;
  taskId?: TaskId;
  triggerMessageId?: MessageId;
  steps: AgentActivityStep[];
  startedAt: string;
  updatedAt: string;
}

export type StageId =
  | "concept_discussion"
  | "concept_review"
  | "production"
  | "first_playable_review"
  | "release_preparation"
  | "release_gate"
  | "production_deploy"
  | "liveops";

export type RoomKind =
  | "studio-main"
  | "design-room"
  | "art-room"
  | "engineering-room"
  | "qa-room"
  | "release-room";

export type SenderType = "producer" | "agent" | "system";

export type MessageType =
  | "plan_submission"
  | "decision_request"
  | "decision_record"
  | "progress_update"
  | "deliverable"
  | "review"
  | "change_request"
  | "asset_review"
  | "bug_report"
  | "qa_failure"
  | "playtest_summary"
  | "build_failure"
  | "release_gate"
  | "deployment_record"
  | "blocker"
  | "handoff";

export type TaskStatus =
  | "todo"
  | "doing"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

export type TaskLevel = "task_group" | "task" | "subtask";

export type TaskBucket = "doing" | "blocked" | "todo" | "done";

export type ArtifactStatus =
  | "draft"
  | "submitted"
  | "review"
  | "approved"
  | "change_requested"
  | "rejected"
  | "superseded";

export type MemoryStatus =
  | "draft"
  | "active"
  | "superseded"
  | "rejected"
  | "archived";

export type MemoryScope =
  | "project"
  | "role"
  | "decision"
  | "artifact"
  | "qa"
  | "release"
  | "producer_preference"
  | "knowledge";

export type ModelCapability =
  | "reasoning"
  | "coding"
  | "vision"
  | "image_generation"
  | "video_generation"
  | "embedding"
  | "evaluation";

export interface Project {
  projectId: ProjectId;
  name: string;
  status: "active" | "archived";
  executionStatus?: "draft" | "running" | "paused" | "completed";
  currentStage: StageId;
  producerId: string;
  initialIdea?: string;
  startedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Room {
  roomId: RoomId;
  projectId: ProjectId;
  kind: RoomKind;
  name: string;
  stageScope?: StageId;
  participants: AgentId[];
  routingPolicy: RoutingPolicy;
  createdAt: string;
}

export interface RoutingPolicy {
  explicitMentionScore: number;
  primaryRoomScore: number;
  currentTaskScore: number;
  artifactScore: number;
  messageTypeScore: number;
  stageLeadScore: number;
  recentParticipantScore: number;
  progressQueryScore: number;
  mustRespondThreshold: number;
  orchestratorReviewThreshold: number;
}

export interface StudioMessage {
  messageId: MessageId;
  projectId: ProjectId;
  roomId: RoomId;
  senderType: SenderType;
  senderId: string;
  messageType: MessageType;
  content: string;
  mentions: AgentId[];
  relatedTaskIds: TaskId[];
  relatedArtifactIds: ArtifactId[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentModelProfile {
  capability: ModelCapability;
  costTier: "low" | "standard" | "premium";
  contextPolicy: "project_pack" | "role_pack" | "minimal";
}

export interface AgentMemoryScopes {
  read: MemoryScope[];
  write: MemoryScope[];
}

export interface AgentContract {
  agentId: AgentId;
  displayName: string;
  roleScope: string;
  roomMemberships: RoomKind[];
  stageLeads: StageId[];
  modelProfile: AgentModelProfile;
  workspace: string;
  memoryScopes: AgentMemoryScopes;
  tools: string[];
  forbiddenActions: string[];
  handoffTargets: AgentId[];
  messageTypes: MessageType[];
  progressKeywords: string[];
}

export interface TaskChildrenSummary {
  doing: number;
  blocked: number;
  todo: number;
  done: number;
  cancelled: number;
}

export interface Task {
  taskId: TaskId;
  projectId: ProjectId;
  stageId: StageId;
  roomId?: RoomId;
  parentTaskId?: TaskId;
  taskLevel: TaskLevel;
  ownerAgentId: AgentId;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  sortOrder: number;
  progressPercent?: number;
  childrenSummary: TaskChildrenSummary;
  inputArtifacts: ArtifactId[];
  outputArtifacts: ArtifactId[];
  acceptanceCriteria: string[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardSnapshot {
  projectId: ProjectId;
  scope: "project" | "stage" | "room" | "agent";
  roomId?: RoomId;
  stageId?: StageId;
  agentId?: AgentId;
  total: number;
  buckets: Record<TaskBucket, number>;
  taskGroups: TaskBoardGroup[];
  createdAt: string;
}

export interface TaskBoardGroup {
  taskId: TaskId;
  title: string;
  status: TaskStatus;
  progressPercent?: number;
  childrenSummary: TaskChildrenSummary;
  tasks: TaskBoardItem[];
}

export interface TaskBoardItem {
  taskId: TaskId;
  parentTaskId?: TaskId;
  title: string;
  status: TaskStatus;
  ownerAgentId: AgentId;
  progressPercent?: number;
  blockers: string[];
  childrenSummary: TaskChildrenSummary;
  subtasks: TaskBoardItem[];
}

export interface Decision {
  decisionId: DecisionId;
  projectId: ProjectId;
  stageId: StageId;
  producerId: string;
  decisionType: string;
  verdict: "approved" | "rejected" | "change_requested" | "waived";
  content: string;
  affectedTasks: TaskId[];
  affectedArtifacts: ArtifactId[];
  supersedes?: DecisionId;
  createdAt: string;
}

export interface Artifact {
  artifactId: ArtifactId;
  projectId: ProjectId;
  type:
    | "gdd"
    | "game_contract"
    | "art_bible"
    | "asset_spec"
    | "asset"
    | "asset_manifest"
    | "scene_blueprint"
    | "playtest_contract"
    | "source_code"
    | "build"
    | "qa_report"
    | "bug_report"
    | "deployment_plan"
    | "deployment_report"
    | "rollback_plan"
    | "release_notes";
  path: string;
  ownerAgentId: AgentId;
  stageId: StageId;
  status: ArtifactStatus;
  version: number;
  sourceTaskId?: TaskId;
  sourceDecisionIds: DecisionId[];
  checksum?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ArtifactOperationStatus = "started" | "completed" | "failed";
export type ArtifactOperationType = "write_artifact" | "append_document";
export type ArtifactEvidenceStatus = "pending" | "verified" | "mismatch" | "insufficient";

/**
 * Immutable evidence for one declared task input at the moment an output was
 * materialized.  `path` is the registered artifact path while `evidencePath`
 * is the concrete file represented by the ledger entry (a build artifact, for
 * example, is registered as a directory but evidenced by its build report).
 */
export interface ArtifactInputProvenance {
  artifactId: ArtifactId;
  version: number;
  path: string;
  evidencePath: string;
  hash: string;
  sizeBytes: number;
  directoryManifestDigest?: string;
}

export interface ArtifactDirectoryManifestEntry {
  path: string;
  hash: string;
  sizeBytes: number;
}

/** Canonical, complete file inventory for a directory-backed artifact. */
export interface ArtifactDirectoryManifest {
  schemaVersion: 1;
  rootPath: string;
  files: ArtifactDirectoryManifestEntry[];
  digest: string;
}

export interface ArtifactOperation {
  operationId: OperationId;
  projectId: ProjectId;
  agentId: AgentId;
  taskId?: TaskId;
  artifactId?: ArtifactId;
  operationType: ArtifactOperationType;
  toolName: "write_artifact" | "append_document";
  path: string;
  status: ArtifactOperationStatus;
  idempotencyKey: string;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ArtifactLedgerEntry {
  artifactId: ArtifactId;
  projectId: ProjectId;
  ownerAgentId: AgentId;
  taskId?: TaskId;
  path: string;
  hash?: string;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
  materializedAt?: string;
  sourceOperationId: OperationId;
  status: ArtifactEvidenceStatus;
  /** Frozen declared inputs for this exact materialization. */
  inputArtifacts?: ArtifactInputProvenance[];
  /** Present for directory-backed artifacts such as Cocos builds. */
  directoryManifest?: ArtifactDirectoryManifest;
  reason?: string;
}

export type ClaimVerdict = "verified" | "mismatch" | "insufficient";
export type ClaimType = "artifact_written" | "completion" | "path_reference";
export type ClaimRepairStatus = "open" | "resolved";
export type ClaimRepairAction = "supply_evidence" | "correct_claim";
export type ClaimRepairResolution = "evidence_verified" | "claim_corrected";

export interface ClaimVerification {
  claimId: ClaimId;
  projectId: ProjectId;
  messageId: MessageId;
  agentId: AgentId;
  claimType: ClaimType;
  claimedPath?: string;
  relatedArtifactIds: ArtifactId[];
  verdict: ClaimVerdict;
  reason: string;
  evidenceRefs: string[];
  resolver: "artifact_ledger" | "filesystem" | "message_metadata";
  checkedAt: string;
  metadata: Record<string, unknown>;
}

export interface ClaimRepair {
  repairId: string;
  projectId: ProjectId;
  claimId: ClaimId;
  messageId: MessageId;
  agentId: AgentId;
  taskId: TaskId;
  status: ClaimRepairStatus;
  action: ClaimRepairAction;
  claimedPath?: string;
  nearestArtifactPath?: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolution?: ClaimRepairResolution;
  resolutionClaimId?: ClaimId;
}

export interface MemoryRecord {
  memoryId: MemoryId;
  projectId: ProjectId;
  stageId?: StageId;
  scope: MemoryScope;
  ownerAgent?: AgentId;
  type: string;
  status: MemoryStatus;
  content: string;
  sourceMessageId?: MessageId;
  sourceEventId?: AuditEventId;
  sourceArtifactId?: ArtifactId;
  supersedes?: MemoryId;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPack {
  projectBrief: string;
  stageSnapshot: string;
  activeDecisions: MemoryRecord[];
  producerPreferences: MemoryRecord[];
  roleWorkspaceSummary?: string;
  openTasks: Task[];
  blockers: Task[];
  relevantArtifacts: Artifact[];
  recentAuditEvents: AuditEvent[];
}

export interface ToolCallTrace {
  toolCallId: string;
  toolName: string;
  status: "started" | "completed" | "failed";
  durationMs?: number;
  metadata: Record<string, unknown>;
}

export interface AuditEvent {
  eventId: AuditEventId;
  projectId: ProjectId;
  stageId?: StageId;
  agentId?: AgentId;
  taskId?: TaskId;
  eventType:
    | "PROJECT_CREATED"
    | "ROOM_CREATED"
    | "ROOM_MEMBER_INVITED"
    | "ROOM_MEMBER_REMOVED"
    | "MESSAGE_POSTED"
    | "AGENT_INVOKED"
    | "AGENT_RESPONDED"
    | "TASK_CREATED"
    | "TASK_UPDATED"
    | "SUBTASK_CREATED"
    | "TASK_STATUS_CHANGED"
    | "TASK_STATUS_SNAPSHOT_CREATED"
    | "DECISION_MADE"
    | "ARTIFACT_CREATED"
    | "ARTIFACT_WRITE_STARTED"
    | "ARTIFACT_WRITE_COMPLETED"
    | "ARTIFACT_MATERIALIZED"
    | "CLAIM_VERIFIED"
    | "CLAIM_MISMATCH"
    | "CLAIM_INSUFFICIENT"
    | "CLAIM_REPAIR_OPENED"
    | "CLAIM_REPAIR_RESOLVED"
    | "MEMORY_WRITTEN"
    | "MODEL_INVOKED"
    | "TOOL_STARTED"
    | "TOOL_COMPLETED"
    | "COCOS_BUILD_STARTED"
    | "COCOS_BUILD_COMPLETED"
    | "QA_REPORT_CREATED"
    | "RELEASE_GATE_COMPLETED"
    | "SECRET_WRITTEN"
    | "DEPLOYMENT_STARTED"
    | "DEPLOYMENT_COMPLETED";
  inputArtifacts: ArtifactId[];
  outputArtifacts: ArtifactId[];
  toolCalls: ToolCallTrace[];
  decisionRefs: DecisionId[];
  status: "completed" | "failed" | "started";
  failureReason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ModelInvocationRequest {
  requestId: string;
  projectId: ProjectId;
  agentId: AgentId;
  capability: ModelCapability;
  purpose: string;
  inputContextRefs: string[];
  outputFormat: "text" | "json_schema" | "markdown";
  budgetHint?: {
    maxTokens?: number;
    maxCostUsd?: number;
  };
}
