import type {
  AgentLoopAgentState,
  AgentLoopState,
  AgentId,
  Artifact,
  ArtifactLedgerEntry,
  ArtifactOperation,
  AuditEvent,
  ClaimRepair,
  ClaimVerification,
  MemoryRecord,
  Project,
  ProjectId,
  Room,
  RoomKind,
  StageId,
  StudioMessage,
  Task,
  TaskBoardSnapshot
} from "@game-pipeline/shared-schemas";
import { AgentRegistry } from "../agents/agentRegistry.js";
import { defaultAgentContracts } from "../agents/defaultAgents.js";
import { InMemoryAuditLog } from "../audit/auditLog.js";
import { createDefaultRooms } from "../chat/defaultRooms.js";
import { RoleAwareRouter, type RoutePlan } from "../chat/router.js";
import { InMemoryProductionMemory } from "../memory/memoryStore.js";
import { TaskBoardBuilder } from "../tasks/taskBoard.js";

export interface StudioKernelState {
  project: Project;
  agentLoop: AgentLoopState;
  rooms: Room[];
  messages: StudioMessage[];
  tasks: Task[];
  artifacts: Artifact[];
  artifactOperations: ArtifactOperation[];
  artifactLedger: ArtifactLedgerEntry[];
  claimVerifications: ClaimVerification[];
  claimRepairs: ClaimRepair[];
}

export interface StudioKernelSnapshot extends StudioKernelState {
  version: 1;
  savedAt: string;
  memoryRecords: MemoryRecord[];
  auditEvents: AuditEvent[];
}

type AgentLoopUpdateFields = {
  [Key in keyof Omit<AgentLoopState, "projectId" | "agents">]?: AgentLoopState[Key] | undefined;
} & { agents?: Record<AgentId, AgentLoopAgentState> | undefined };

type AgentLoopAgentUpdateFields = {
  [Key in keyof Omit<AgentLoopAgentState, "agentId">]?: AgentLoopAgentState[Key] | undefined;
};

export class StudioKernel {
  readonly agents: AgentRegistry;
  readonly router: RoleAwareRouter;
  readonly memory: InMemoryProductionMemory;
  readonly auditLog: InMemoryAuditLog;
  readonly taskBoard: TaskBoardBuilder;

  private readonly state: StudioKernelState;

  constructor(
    project: Project,
    restoredState: Partial<Omit<StudioKernelState, "project">> & {
      memoryRecords?: MemoryRecord[];
      auditEvents?: AuditEvent[];
    } = {}
  ) {
    this.agents = new AgentRegistry(defaultAgentContracts);
    this.router = new RoleAwareRouter(this.agents);
    this.memory = new InMemoryProductionMemory(restoredState.memoryRecords);
    this.auditLog = new InMemoryAuditLog(restoredState.auditEvents);
    this.taskBoard = new TaskBoardBuilder();
    this.state = {
      project,
      agentLoop: restoredState.agentLoop ?? createInitialAgentLoopState(project),
      rooms: restoredState.rooms ?? createDefaultRooms(project.projectId),
      messages: restoredState.messages ?? [],
      tasks: restoredState.tasks ?? [],
      artifacts: restoredState.artifacts ?? [],
      artifactOperations: restoredState.artifactOperations ?? [],
      artifactLedger: restoredState.artifactLedger ?? [],
      claimVerifications: restoredState.claimVerifications ?? [],
      claimRepairs: restoredState.claimRepairs ?? []
    };
  }

  get project(): Project {
    return this.state.project;
  }

  updateProject(fields: Partial<Pick<Project, "executionStatus" | "initialIdea" | "startedAt" | "updatedAt">>): void {
    this.state.project = {
      ...this.state.project,
      ...fields
    };
  }

  getAgentLoopState(): AgentLoopState {
    return {
      ...this.state.agentLoop,
      activeAgentIds: [...this.state.agentLoop.activeAgentIds],
      pendingTaskIds: [...this.state.agentLoop.pendingTaskIds],
      agents: Object.fromEntries(
        Object.entries(this.state.agentLoop.agents).map(([agentId, state]) => [
          agentId,
          {
            ...state,
            ...(state.lastChangedPaths ? { lastChangedPaths: [...state.lastChangedPaths] } : {})
          }
        ])
      )
    };
  }

  updateAgentLoop(fields: AgentLoopUpdateFields): AgentLoopState {
    const next: AgentLoopState = {
      ...this.state.agentLoop,
      agents: fields.agents ?? this.state.agentLoop.agents,
      status: fields.status ?? this.state.agentLoop.status,
      iteration: fields.iteration ?? this.state.agentLoop.iteration,
      activeAgentIds: fields.activeAgentIds ? [...fields.activeAgentIds] : this.state.agentLoop.activeAgentIds,
      pendingTaskIds: fields.pendingTaskIds ? [...fields.pendingTaskIds] : this.state.agentLoop.pendingTaskIds,
      updatedAt: fields.updatedAt ?? new Date().toISOString()
    };
    if (fields.runId !== undefined) {
      next.runId = fields.runId;
    }
    if (fields.waitingReason !== undefined) {
      next.waitingReason = fields.waitingReason;
    }
    if (fields.lastError !== undefined) {
      next.lastError = fields.lastError;
    }
    if (fields.startedAt !== undefined) {
      next.startedAt = fields.startedAt;
    }
    if ("waitingReason" in fields && fields.waitingReason === undefined) {
      delete next.waitingReason;
    }
    if ("lastError" in fields && fields.lastError === undefined) {
      delete next.lastError;
    }
    if ("runId" in fields && fields.runId === undefined) {
      delete next.runId;
    }
    if ("startedAt" in fields && fields.startedAt === undefined) {
      delete next.startedAt;
    }
    this.state.agentLoop = next;
    return this.getAgentLoopState();
  }

  updateAgentLoopAgent(agentId: AgentId, fields: AgentLoopAgentUpdateFields): AgentLoopAgentState {
    const previous = this.state.agentLoop.agents[agentId];
    const next: AgentLoopAgentState = {
      agentId,
      status: fields.status ?? previous?.status ?? "idle",
      iteration: fields.iteration ?? previous?.iteration ?? this.state.agentLoop.iteration,
      ...(fields.taskId !== undefined ? { taskId: fields.taskId } : previous?.taskId ? { taskId: previous.taskId } : {}),
      ...(fields.harnessId !== undefined
        ? { harnessId: fields.harnessId }
        : previous?.harnessId
          ? { harnessId: previous.harnessId }
          : {}),
      ...(fields.sessionId !== undefined
        ? { sessionId: fields.sessionId }
        : previous?.sessionId
          ? { sessionId: previous.sessionId }
          : {}),
      ...(fields.lastInvocationId !== undefined
        ? { lastInvocationId: fields.lastInvocationId }
        : previous?.lastInvocationId
          ? { lastInvocationId: previous.lastInvocationId }
          : {}),
      ...(fields.lastChangedPaths !== undefined
        ? { lastChangedPaths: [...fields.lastChangedPaths] }
        : previous?.lastChangedPaths
          ? { lastChangedPaths: [...previous.lastChangedPaths] }
          : {}),
      ...(fields.lastMessageId !== undefined
        ? { lastMessageId: fields.lastMessageId }
        : previous?.lastMessageId
          ? { lastMessageId: previous.lastMessageId }
          : {}),
      ...(fields.lastError !== undefined ? { lastError: fields.lastError } : previous?.lastError ? { lastError: previous.lastError } : {}),
      updatedAt: fields.updatedAt ?? new Date().toISOString()
    };
    if ("taskId" in fields && fields.taskId === undefined) {
      delete next.taskId;
    }
    if ("harnessId" in fields && fields.harnessId === undefined) {
      delete next.harnessId;
    }
    if ("sessionId" in fields && fields.sessionId === undefined) {
      delete next.sessionId;
    }
    if ("lastInvocationId" in fields && fields.lastInvocationId === undefined) {
      delete next.lastInvocationId;
    }
    if ("lastChangedPaths" in fields && fields.lastChangedPaths === undefined) {
      delete next.lastChangedPaths;
    }
    if ("lastMessageId" in fields && fields.lastMessageId === undefined) {
      delete next.lastMessageId;
    }
    if ("lastError" in fields && fields.lastError === undefined) {
      delete next.lastError;
    }
    this.state.agentLoop.agents[agentId] = next;
    this.state.agentLoop.updatedAt = next.updatedAt;
    return { ...next };
  }

  setStage(stageId: StageId, updatedAt = new Date().toISOString()): void {
    this.state.project.currentStage = stageId;
    this.state.project.updatedAt = updatedAt;
  }

  listRooms(): Room[] {
    return this.state.rooms.map(cloneRoom);
  }

  getRoom(kind: RoomKind): Room {
    const room = this.state.rooms.find((candidate) => candidate.kind === kind);
    if (!room) {
      throw new Error(`Room not found: ${kind}`);
    }
    return cloneRoom(room);
  }

  updateRoomParticipant(
    kind: RoomKind,
    agentId: AgentId,
    action: "invite" | "remove",
    updatedAt = new Date().toISOString()
  ): { room: Room; changed: boolean } {
    if (!this.agents.has(agentId)) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const room = this.state.rooms.find((candidate) => candidate.kind === kind);
    if (!room) {
      throw new Error(`Room not found: ${kind}`);
    }

    const wasPresent = room.participants.includes(agentId);
    const shouldBePresent = action === "invite";
    const changed = wasPresent !== shouldBePresent;
    if (changed) {
      room.participants = shouldBePresent
        ? [...room.participants, agentId]
        : room.participants.filter((candidate) => candidate !== agentId);
      this.state.project.updatedAt = updatedAt;
      this.auditLog.append({
        eventId: `evt_room_member_${action}_${room.kind}_${agentId}_${Date.now()}`,
        projectId: this.state.project.projectId,
        stageId: this.state.project.currentStage,
        agentId: "producer",
        eventType: action === "invite" ? "ROOM_MEMBER_INVITED" : "ROOM_MEMBER_REMOVED",
        inputArtifacts: [],
        outputArtifacts: [],
        toolCalls: [],
        decisionRefs: [],
        status: "completed",
        metadata: {
          roomId: room.roomId,
          roomKind: room.kind,
          memberAgentId: agentId
        },
        createdAt: updatedAt
      });
    }

    return { room: cloneRoom(room), changed };
  }

  postMessage(message: StudioMessage): RoutePlan {
    this.recordMessage(message);

    const room = this.state.rooms.find((candidate) => candidate.roomId === message.roomId);
    if (!room) {
      throw new Error(`Room not found for message: ${message.roomId}`);
    }

    return this.router.route(message, {
      room,
      currentStage: this.state.project.currentStage,
      currentTasks: this.state.tasks,
      artifacts: this.state.artifacts,
      recentMessages: this.state.messages.slice(-10)
    });
  }

  recordMessage(message: StudioMessage): void {
    this.state.messages.push(message);
    this.auditLog.append({
      eventId: `evt_${message.messageId}`,
      projectId: message.projectId,
      stageId: this.state.project.currentStage,
      eventType: "MESSAGE_POSTED",
      inputArtifacts: [],
      outputArtifacts: [],
      toolCalls: [],
      decisionRefs: [],
      status: "completed",
      metadata: {
        roomId: message.roomId,
        messageType: message.messageType,
        senderType: message.senderType
      },
      createdAt: message.createdAt
    });
  }

  addTask(task: Task): void {
    this.state.tasks.push(task);
    this.appendTaskEvent(task, "TASK_CREATED");
  }

  updateTask(taskId: string, fields: Partial<Omit<Task, "taskId" | "projectId" | "createdAt">>): Task {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if ((fields.status === "review" || fields.status === "done") && !this.hasVerifiedTaskOutputs(task)) {
      const missing = this.missingVerifiedTaskOutputs(task);
      throw new Error(`任务「${task.title}」不能进入 ${fields.status}：输出产物缺少已验证证据 ${missing.join("、")}`);
    }

    Object.assign(task, fields);
    task.updatedAt = fields.updatedAt ?? new Date().toISOString();
    if (task.status === "done") {
      task.blockers = [];
      task.progressPercent = 100;
    }
    this.appendTaskEvent(task, "TASK_UPDATED");
    return task;
  }

  updateTaskStatus(taskId: string, status: Task["status"], updatedAt = new Date().toISOString()): Task {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if ((status === "review" || status === "done") && !this.hasVerifiedTaskOutputs(task)) {
      const missing = this.missingVerifiedTaskOutputs(task);
      throw new Error(`任务「${task.title}」不能进入 ${status}：输出产物缺少已验证证据 ${missing.join("、")}`);
    }

    task.status = status;
    if (status === "done") {
      task.blockers = [];
    }
    task.updatedAt = updatedAt;
    this.appendTaskEvent(task, "TASK_STATUS_CHANGED");
    return task;
  }

  addArtifact(artifact: Artifact): void {
    this.state.artifacts.push(artifact);
    const operationId = this.createArtifactOperation(artifact);
    this.state.artifactLedger.push({
      artifactId: artifact.artifactId,
      projectId: artifact.projectId,
      ownerAgentId: artifact.ownerAgentId,
      ...(artifact.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
      path: artifact.path,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      sourceOperationId: operationId,
      status: "pending",
      reason: "等待工作区写入并计算文件证据。"
    });
    this.auditLog.append({
      eventId: `evt_${artifact.artifactId}`,
      projectId: artifact.projectId,
      stageId: artifact.stageId,
      agentId: artifact.ownerAgentId,
      ...(artifact.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
      eventType: "ARTIFACT_CREATED",
      inputArtifacts: [],
      outputArtifacts: [artifact.artifactId],
      toolCalls: [],
      decisionRefs: artifact.sourceDecisionIds,
      status: "completed",
      metadata: {
        path: artifact.path,
        artifactType: artifact.type
      },
      createdAt: artifact.createdAt
    });
  }

  upsertArtifact(artifact: Artifact): Artifact {
    const existing = this.state.artifacts.find(
      (candidate) => candidate.artifactId === artifact.artifactId || (candidate.ownerAgentId === artifact.ownerAgentId && candidate.path === artifact.path)
    );
    if (!existing) {
      this.addArtifact(artifact);
      this.attachArtifactToSourceTask(artifact);
      return artifact;
    }

    const updatedAt = artifact.updatedAt ?? new Date().toISOString();
    existing.type = artifact.type;
    existing.path = artifact.path;
    existing.status = artifact.status;
    existing.version = Math.max(existing.version, artifact.version);
    if (artifact.sourceTaskId !== undefined) {
      existing.sourceTaskId = artifact.sourceTaskId;
    }
    existing.sourceDecisionIds = [...new Set([...existing.sourceDecisionIds, ...artifact.sourceDecisionIds])];
    existing.metadata = {
      ...existing.metadata,
      ...artifact.metadata
    };
    existing.updatedAt = updatedAt;
    this.attachArtifactToSourceTask(existing);

    let ledger = this.state.artifactLedger.find((candidate) => candidate.artifactId === existing.artifactId);
    if (!ledger) {
      const operationId = this.createArtifactOperation(existing);
      ledger = {
        artifactId: existing.artifactId,
        projectId: existing.projectId,
        ownerAgentId: existing.ownerAgentId,
        ...(existing.sourceTaskId ? { taskId: existing.sourceTaskId } : {}),
        path: existing.path,
        createdAt: existing.createdAt,
        updatedAt,
        sourceOperationId: operationId,
        status: "pending",
        reason: "等待工作区写入并计算文件证据。"
      };
      this.state.artifactLedger.push(ledger);
    }

    return existing;
  }

  recordArtifactMaterialization(
    artifactId: string,
    input: {
      path: string;
      hash: string;
      sizeBytes: number;
      materializedAt: string;
    }
  ): ArtifactLedgerEntry {
    const artifact = this.state.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    let ledger = this.state.artifactLedger.find((candidate) => candidate.artifactId === artifactId);
    if (!ledger) {
      const operationId = this.createArtifactOperation(artifact);
      ledger = {
        artifactId: artifact.artifactId,
        projectId: artifact.projectId,
        ownerAgentId: artifact.ownerAgentId,
        ...(artifact.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
        path: artifact.path,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        sourceOperationId: operationId,
        status: "pending"
      };
      this.state.artifactLedger.push(ledger);
    }

    const unchanged =
      ledger.status === "verified" &&
      ledger.hash === input.hash &&
      ledger.sizeBytes === input.sizeBytes &&
      ledger.path === input.path;

    ledger.path = input.path;
    ledger.hash = input.hash;
    ledger.sizeBytes = input.sizeBytes;
    ledger.materializedAt = input.materializedAt;
    ledger.updatedAt = input.materializedAt;
    ledger.status = "verified";
    ledger.reason = "文件已由服务端 artifact 写入工具物化并完成 hash/size 校验。";
    artifact.checksum = input.hash;
    artifact.updatedAt = input.materializedAt;

    const operation = this.state.artifactOperations.find((candidate) => candidate.operationId === ledger.sourceOperationId);
    if (operation) {
      operation.path = input.path;
      operation.status = "completed";
      operation.updatedAt = input.materializedAt;
      operation.completedAt = input.materializedAt;
    }

    if (!unchanged) {
      this.auditLog.append({
        eventId: `evt_artifact_materialized_${artifactId}_${Date.now()}`,
        projectId: artifact.projectId,
        stageId: artifact.stageId,
        agentId: artifact.ownerAgentId,
        ...(artifact.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
        eventType: "ARTIFACT_MATERIALIZED",
        inputArtifacts: [],
        outputArtifacts: [artifact.artifactId],
        toolCalls: [
          {
            toolCallId: ledger.sourceOperationId,
            toolName: "write_artifact",
            status: "completed",
            metadata: {
              path: input.path,
              hash: input.hash,
              sizeBytes: input.sizeBytes
            }
          }
        ],
        decisionRefs: artifact.sourceDecisionIds,
        status: "completed",
        metadata: {
          path: input.path,
          hash: input.hash,
          sizeBytes: input.sizeBytes
        },
        createdAt: input.materializedAt
      });
    }

    return ledger;
  }

  updateArtifactStatus(
    artifactId: string,
    status: Artifact["status"],
    updatedAt = new Date().toISOString()
  ): Artifact {
    const artifact = this.state.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    artifact.status = status;
    artifact.updatedAt = updatedAt;
    return artifact;
  }

  writeMemory(record: MemoryRecord): MemoryRecord {
    const written = this.memory.write(record);
    this.auditLog.append({
      eventId: `evt_${record.memoryId}`,
      projectId: record.projectId,
      ...(record.stageId ? { stageId: record.stageId } : {}),
      ...(record.ownerAgent ? { agentId: record.ownerAgent } : {}),
      eventType: "MEMORY_WRITTEN",
      inputArtifacts: record.sourceArtifactId ? [record.sourceArtifactId] : [],
      outputArtifacts: [],
      toolCalls: [],
      decisionRefs: [],
      status: "completed",
      metadata: {
        scope: record.scope,
        memoryStatus: record.status,
        type: record.type
      },
      createdAt: record.createdAt
    });
    return written;
  }

  buildTaskBoard(input: {
    scope?: "project" | "stage" | "room" | "agent";
    stageId?: StageId;
    roomId?: string;
    agentId?: AgentId;
  } = {}): TaskBoardSnapshot {
    return this.taskBoard.build(this.state.tasks, {
      projectId: this.state.project.projectId,
      ...input
    });
  }

  listTasks(): Task[] {
    return [...this.state.tasks];
  }

  findTask(taskId: string): Task | undefined {
    return this.state.tasks.find((task) => task.taskId === taskId);
  }

  listArtifacts(): Artifact[] {
    return [...this.state.artifacts];
  }

  listArtifactOperations(): ArtifactOperation[] {
    return [...this.state.artifactOperations];
  }

  listArtifactLedger(): ArtifactLedgerEntry[] {
    return [...this.state.artifactLedger];
  }

  listClaimVerifications(): ClaimVerification[] {
    return [...this.state.claimVerifications];
  }

  listClaimRepairs(): ClaimRepair[] {
    return [...this.state.claimRepairs];
  }

  recordClaimVerification(claim: ClaimVerification): ClaimVerification {
    const existingIndex = this.state.claimVerifications.findIndex((candidate) => candidate.claimId === claim.claimId);
    const existing = existingIndex === -1 ? undefined : this.state.claimVerifications[existingIndex];
    const changed =
      !existing ||
      existing.verdict !== claim.verdict ||
      existing.reason !== claim.reason ||
      existing.claimedPath !== claim.claimedPath ||
      existing.evidenceRefs.join("|") !== claim.evidenceRefs.join("|");
    if (existingIndex === -1) {
      this.state.claimVerifications.push(claim);
    } else {
      this.state.claimVerifications[existingIndex] = claim;
    }

    if (!changed) {
      return claim;
    }

    const eventType =
      claim.verdict === "verified" ? "CLAIM_VERIFIED" : claim.verdict === "mismatch" ? "CLAIM_MISMATCH" : "CLAIM_INSUFFICIENT";
    this.auditLog.append({
      eventId: `evt_${eventType.toLowerCase()}_${claim.claimId}_${Date.now()}`,
      projectId: claim.projectId,
      agentId: claim.agentId,
      eventType,
      inputArtifacts: claim.relatedArtifactIds,
      outputArtifacts: [],
      toolCalls: [],
      decisionRefs: [],
      status: claim.verdict === "verified" ? "completed" : "failed",
      ...(claim.verdict === "verified" ? {} : { failureReason: claim.reason }),
      metadata: {
        messageId: claim.messageId,
        claimType: claim.claimType,
        claimedPath: claim.claimedPath,
        evidenceRefs: claim.evidenceRefs
      },
      createdAt: claim.checkedAt
    });
    return claim;
  }

  upsertClaimRepair(repair: ClaimRepair): { repair: ClaimRepair; created: boolean; changed: boolean } {
    const existingIndex = this.state.claimRepairs.findIndex((candidate) => candidate.repairId === repair.repairId);
    const existing = existingIndex === -1 ? undefined : this.state.claimRepairs[existingIndex];
    const created = existingIndex === -1;
    const changed =
      !existing ||
      existing.status !== repair.status ||
      existing.reason !== repair.reason ||
      existing.action !== repair.action ||
      existing.nearestArtifactPath !== repair.nearestArtifactPath ||
      existing.resolution !== repair.resolution ||
      existing.resolutionClaimId !== repair.resolutionClaimId;

    let current: ClaimRepair;
    if (created) {
      this.state.claimRepairs.push(repair);
      current = repair;
    } else {
      if (!existing) {
        throw new Error(`Claim repair not found: ${repair.repairId}`);
      }
      current = {
        ...existing,
        ...repair,
        createdAt: existing.createdAt
      };
      this.state.claimRepairs[existingIndex] = current;
    }

    if (changed) {
      this.auditLog.append({
        eventId: `evt_claim_repair_${current.status}_${current.repairId}_${Date.now()}`,
        projectId: current.projectId,
        agentId: current.agentId,
        taskId: current.taskId,
        eventType: current.status === "resolved" ? "CLAIM_REPAIR_RESOLVED" : "CLAIM_REPAIR_OPENED",
        inputArtifacts: [],
        outputArtifacts: [],
        toolCalls: [],
        decisionRefs: [],
        status: current.status === "resolved" ? "completed" : "started",
        metadata: {
          claimId: current.claimId,
          messageId: current.messageId,
          action: current.action,
          claimedPath: current.claimedPath,
          nearestArtifactPath: current.nearestArtifactPath,
          resolution: current.resolution,
          resolutionClaimId: current.resolutionClaimId
        },
        createdAt: current.updatedAt
      });
    }

    return {
      repair: current,
      created,
      changed
    };
  }

  setMessageClaimVerifications(messageId: string, claims: ClaimVerification[]): void {
    const message = this.state.messages.find((candidate) => candidate.messageId === messageId);
    if (!message) {
      return;
    }

    message.metadata = {
      ...message.metadata,
      claimVerificationIds: claims.map((claim) => claim.claimId),
      claimVerifications: claims,
      claimVerdict: summarizeClaimVerdict(claims)
    };
  }

  listMessages(): StudioMessage[] {
    return [...this.state.messages];
  }

  listAuditEvents(): AuditEvent[] {
    return this.auditLog.list(this.state.project.projectId);
  }

  toSnapshot(savedAt = new Date().toISOString()): StudioKernelSnapshot {
    return {
      version: 1,
      savedAt,
      project: this.state.project,
      agentLoop: this.state.agentLoop,
      rooms: this.state.rooms,
      messages: this.state.messages,
      tasks: this.state.tasks,
      artifacts: this.state.artifacts,
      artifactOperations: this.state.artifactOperations,
      artifactLedger: this.state.artifactLedger,
      claimVerifications: this.state.claimVerifications,
      claimRepairs: this.state.claimRepairs,
      memoryRecords: this.memory.list(this.state.project.projectId),
      auditEvents: this.auditLog.list(this.state.project.projectId)
    };
  }

  private createArtifactOperation(artifact: Artifact): string {
    const existingLedger = this.state.artifactLedger.find((candidate) => candidate.artifactId === artifact.artifactId);
    if (existingLedger) {
      return existingLedger.sourceOperationId;
    }

    const now = new Date().toISOString();
    const operationId = `op_write_artifact_${artifact.artifactId}_${Date.now()}`;
    const operation: ArtifactOperation = {
      operationId,
      projectId: artifact.projectId,
      agentId: artifact.ownerAgentId,
      ...(artifact.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
      artifactId: artifact.artifactId,
      operationType: "write_artifact",
      toolName: "write_artifact",
      path: artifact.path,
      status: "started",
      idempotencyKey: `artifact:${artifact.projectId}:${artifact.artifactId}:${artifact.version}`,
      metadata: {
        artifactType: artifact.type,
        artifactStatus: artifact.status
      },
      createdAt: now,
      updatedAt: now
    };
    this.state.artifactOperations.push(operation);
    this.auditLog.append({
      eventId: `evt_artifact_write_started_${artifact.artifactId}_${Date.now()}`,
      projectId: artifact.projectId,
      stageId: artifact.stageId,
      agentId: artifact.ownerAgentId,
      ...(artifact.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
      eventType: "ARTIFACT_WRITE_STARTED",
      inputArtifacts: [],
      outputArtifacts: [artifact.artifactId],
      toolCalls: [
        {
          toolCallId: operationId,
          toolName: "write_artifact",
          status: "started",
          metadata: {
            path: artifact.path,
            artifactType: artifact.type
          }
        }
      ],
      decisionRefs: artifact.sourceDecisionIds,
      status: "started",
      metadata: {
        path: artifact.path,
        artifactType: artifact.type
      },
      createdAt: now
    });
    return operationId;
  }

  private attachArtifactToSourceTask(artifact: Artifact): void {
    if (!artifact.sourceTaskId) {
      return;
    }

    const task = this.state.tasks.find((candidate) => candidate.taskId === artifact.sourceTaskId);
    if (!task || task.outputArtifacts.includes(artifact.artifactId)) {
      return;
    }

    task.outputArtifacts.push(artifact.artifactId);
    task.updatedAt = artifact.updatedAt;
  }

  private hasVerifiedTaskOutputs(task: Task): boolean {
    return this.missingVerifiedTaskOutputs(task).length === 0;
  }

  private missingVerifiedTaskOutputs(task: Task): string[] {
    if (task.outputArtifacts.length === 0) {
      return [];
    }

    return task.outputArtifacts.filter((artifactId) => {
      const ledger = this.state.artifactLedger.find((candidate) => candidate.artifactId === artifactId);
      return !ledger || ledger.status !== "verified" || !ledger.hash || !ledger.sizeBytes;
    });
  }

  private appendTaskEvent(task: Task, eventType: "TASK_CREATED" | "TASK_UPDATED" | "TASK_STATUS_CHANGED"): void {
    this.auditLog.append({
      eventId: `evt_${eventType.toLowerCase()}_${task.taskId}_${Date.now()}`,
      projectId: task.projectId,
      stageId: task.stageId,
      agentId: task.ownerAgentId,
      taskId: task.taskId,
      eventType,
      inputArtifacts: task.inputArtifacts,
      outputArtifacts: task.outputArtifacts,
      toolCalls: [],
      decisionRefs: [],
      status: "completed",
      metadata: {
        taskLevel: task.taskLevel,
        taskStatus: task.status
      },
      createdAt: task.updatedAt
    });
  }
}

export function createStudioKernel(projectId: ProjectId, name: string, producerId: string, initialIdea?: string): StudioKernel {
  const now = new Date().toISOString();
  return new StudioKernel({
    projectId,
    name,
    status: "active",
    executionStatus: "draft",
    currentStage: "concept_discussion",
    producerId,
    ...(initialIdea ? { initialIdea } : {}),
    createdAt: now,
    updatedAt: now
  });
}

export function createRestartedStudioKernel(project: Project): StudioKernel {
  const now = new Date().toISOString();
  return new StudioKernel({
    ...project,
    executionStatus: "running",
    currentStage: "concept_discussion",
    startedAt: now,
    updatedAt: now
  });
}

export function createStudioKernelFromSnapshot(snapshot: StudioKernelSnapshot): StudioKernel {
  return new StudioKernel(snapshot.project, {
    agentLoop: snapshot.agentLoop,
    rooms: snapshot.rooms,
    messages: snapshot.messages,
    tasks: snapshot.tasks,
    artifacts: snapshot.artifacts,
    artifactOperations: snapshot.artifactOperations,
    artifactLedger: snapshot.artifactLedger,
    claimVerifications: snapshot.claimVerifications,
    claimRepairs: snapshot.claimRepairs,
    memoryRecords: snapshot.memoryRecords,
    auditEvents: snapshot.auditEvents
  });
}

function createInitialAgentLoopState(project: Project): AgentLoopState {
  const status: AgentLoopState["status"] = project.executionStatus === "paused" ? "paused" : "idle";
  return {
    projectId: project.projectId,
    status,
    iteration: 0,
    activeAgentIds: [],
    pendingTaskIds: [],
    agents: {},
    updatedAt: project.updatedAt
  };
}

function summarizeClaimVerdict(claims: ClaimVerification[]): ClaimVerification["verdict"] | undefined {
  if (claims.length === 0) {
    return undefined;
  }
  if (claims.some((claim) => claim.verdict === "mismatch")) {
    return "mismatch";
  }
  if (claims.some((claim) => claim.verdict === "insufficient")) {
    return "insufficient";
  }
  return "verified";
}

function cloneRoom(room: Room): Room {
  return {
    ...room,
    participants: [...room.participants],
    routingPolicy: { ...room.routingPolicy }
  };
}
