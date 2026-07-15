import type {
  AgentId,
  Artifact,
  ArtifactLedgerEntry,
  ArtifactOperation,
  AuditEvent,
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
  rooms: Room[];
  messages: StudioMessage[];
  tasks: Task[];
  artifacts: Artifact[];
  artifactOperations: ArtifactOperation[];
  artifactLedger: ArtifactLedgerEntry[];
  claimVerifications: ClaimVerification[];
}

export interface StudioKernelSnapshot extends StudioKernelState {
  version: 1;
  savedAt: string;
  memoryRecords: MemoryRecord[];
  auditEvents: AuditEvent[];
}

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
      rooms: restoredState.rooms ?? createDefaultRooms(project.projectId),
      messages: restoredState.messages ?? [],
      tasks: restoredState.tasks ?? [],
      artifacts: restoredState.artifacts ?? [],
      artifactOperations: restoredState.artifactOperations ?? [],
      artifactLedger: restoredState.artifactLedger ?? [],
      claimVerifications: restoredState.claimVerifications ?? []
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

  setStage(stageId: StageId, updatedAt = new Date().toISOString()): void {
    this.state.project.currentStage = stageId;
    this.state.project.updatedAt = updatedAt;
  }

  listRooms(): Room[] {
    return [...this.state.rooms];
  }

  getRoom(kind: RoomKind): Room {
    const room = this.state.rooms.find((candidate) => candidate.kind === kind);
    if (!room) {
      throw new Error(`Room not found: ${kind}`);
    }
    return room;
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
      rooms: this.state.rooms,
      messages: this.state.messages,
      tasks: this.state.tasks,
      artifacts: this.state.artifacts,
      artifactOperations: this.state.artifactOperations,
      artifactLedger: this.state.artifactLedger,
      claimVerifications: this.state.claimVerifications,
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

  private appendTaskEvent(task: Task, eventType: "TASK_CREATED" | "TASK_STATUS_CHANGED"): void {
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
    rooms: snapshot.rooms,
    messages: snapshot.messages,
    tasks: snapshot.tasks,
    artifacts: snapshot.artifacts,
    artifactOperations: snapshot.artifactOperations,
    artifactLedger: snapshot.artifactLedger,
    claimVerifications: snapshot.claimVerifications,
    memoryRecords: snapshot.memoryRecords,
    auditEvents: snapshot.auditEvents
  });
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
