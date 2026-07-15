import type {
  AgentId,
  Artifact,
  AuditEvent,
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
      artifacts: restoredState.artifacts ?? []
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
      memoryRecords: this.memory.list(this.state.project.projectId),
      auditEvents: this.auditLog.list(this.state.project.projectId)
    };
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
    memoryRecords: snapshot.memoryRecords,
    auditEvents: snapshot.auditEvents
  });
}
