export type ProjectId = string;
export type RoomId = string;
export type MessageId = string;
export type AgentId = string;
export type TaskId = string;
export type ArtifactId = string;
export type DecisionId = string;
export type MemoryId = string;
export type AuditEventId = string;

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
    | "art_bible"
    | "asset_spec"
    | "asset"
    | "asset_manifest"
    | "scene_blueprint"
    | "source_code"
    | "build"
    | "qa_report"
    | "bug_report"
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
