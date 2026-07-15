import { createRestartedStudioKernel, createStudioKernel, LocalAgentRuntime, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { MessageType, RoomKind, StudioMessage } from "@game-pipeline/shared-schemas";
import { ProjectPersistenceStore, type ProjectSummary } from "./projectPersistence.js";
import { deleteProjectWorkspace, readWorkspaceTree, syncProjectWorkspace, type WorkspaceSyncResult, type WorkspaceTreeEntry } from "./workspaceWriter.js";

export interface CreateProjectInput {
  name: string;
  producerId?: string;
  idea?: string;
}

export interface PostMessageInput {
  roomKind?: RoomKind;
  roomId?: string;
  content: string;
  messageType?: MessageType;
  mentions?: string[];
}

export class StudioProjectStore {
  private readonly projects = new Map<string, StudioKernel>();
  private readonly runtime = new LocalAgentRuntime();
  private readonly persistence = new ProjectPersistenceStore();

  constructor() {
    for (const kernel of this.persistence.loadAll()) {
      this.projects.set(kernel.project.projectId, kernel);
      syncProjectWorkspace(kernel);
    }
  }

  listProjects(): ProjectSummary[] {
    return this.persistence.listSummaries();
  }

  createProject(input: CreateProjectInput): {
    project: StudioKernel["project"];
    rooms: ReturnType<StudioKernel["listRooms"]>;
    workspace: WorkspaceSyncResult;
    bootstrap?: ReturnType<LocalAgentRuntime["handleProducerMessage"]>;
  } {
    const projectId = `game_${Date.now().toString(36)}`;
    const kernel = createStudioKernel(projectId, input.name, input.producerId ?? "producer_local", input.idea);
    this.projects.set(projectId, kernel);
    this.persistence.save(kernel);

    const result: {
      project: StudioKernel["project"];
      rooms: ReturnType<StudioKernel["listRooms"]>;
      workspace: WorkspaceSyncResult;
      bootstrap?: ReturnType<LocalAgentRuntime["handleProducerMessage"]>;
    } = {
      project: kernel.project,
      rooms: kernel.listRooms(),
      workspace: syncProjectWorkspace(kernel)
    };

    this.persistence.save(kernel);
    return result;
  }

  startProject(projectId: string): ReturnType<LocalAgentRuntime["handleProducerMessage"]> & {
    project: StudioKernel["project"];
    rooms: ReturnType<StudioKernel["listRooms"]>;
    workspace: WorkspaceSyncResult;
  } {
    const existing = this.getKernel(projectId);
    const initialIdea =
      existing.project.initialIdea ??
      existing.listMessages().find((message) => message.senderType === "producer" && message.messageType === "plan_submission")?.content;
    if (!initialIdea) {
      throw new HttpError(400, "Project has no initial idea to start from");
    }

    const now = new Date().toISOString();
    for (const kernel of this.projects.values()) {
      if (kernel.project.projectId !== projectId && kernel.project.executionStatus === "running") {
        kernel.updateProject({
          executionStatus: "paused",
          updatedAt: now
        });
        this.persistence.save(kernel);
      }
    }

    existing.updateProject({ initialIdea });
    const restarted = createRestartedStudioKernel(existing.project);
    this.projects.set(projectId, restarted);
    const result = this.postProducerMessage(projectId, {
      roomKind: "studio-main",
      content: initialIdea,
      messageType: "plan_submission"
    });
    const kernel = this.getKernel(projectId);
    return {
      ...result,
      project: kernel.project,
      rooms: kernel.listRooms(),
      workspace: syncProjectWorkspace(kernel)
    };
  }

  getKernel(projectId: string): StudioKernel {
    const kernel = this.projects.get(projectId) ?? this.loadProject(projectId);
    if (!kernel) {
      throw new HttpError(404, `Project not found: ${projectId}`);
    }
    return kernel;
  }

  postProducerMessage(projectId: string, input: PostMessageInput): ReturnType<LocalAgentRuntime["handleProducerMessage"]> & {
    workspace: WorkspaceSyncResult;
  } {
    const kernel = this.getKernel(projectId);
    const room = input.roomId
      ? kernel.listRooms().find((candidate) => candidate.roomId === input.roomId)
      : kernel.getRoom(input.roomKind ?? "studio-main");

    if (!room) {
      throw new HttpError(404, "Room not found");
    }

    const message: StudioMessage = {
      messageId: `msg_producer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      roomId: room.roomId,
      senderType: "producer",
      senderId: kernel.project.producerId,
      messageType: input.messageType ?? "plan_submission",
      content: input.content,
      mentions: input.mentions ?? [],
      relatedTaskIds: [],
      relatedArtifactIds: [],
      metadata: {},
      createdAt: new Date().toISOString()
    };

    const result = this.runtime.handleProducerMessage(kernel, message);
    this.persistence.save(kernel);
    return {
      ...result,
      workspace: syncProjectWorkspace(kernel)
    };
  }

  syncWorkspace(projectId: string): WorkspaceSyncResult {
    const kernel = this.getKernel(projectId);
    this.persistence.save(kernel);
    return syncProjectWorkspace(kernel);
  }

  readWorkspaceTree(projectId: string): {
    projectRoot: string;
    entries: WorkspaceTreeEntry[];
  } {
    this.getKernel(projectId);
    return readWorkspaceTree(projectId);
  }

  deleteProject(projectId: string): { projectId: string } {
    this.getKernel(projectId);
    this.projects.delete(projectId);
    this.persistence.delete(projectId);
    deleteProjectWorkspace(projectId);
    return { projectId };
  }

  private loadProject(projectId: string): StudioKernel | undefined {
    const kernel = this.persistence.load(projectId);
    if (kernel) {
      this.projects.set(projectId, kernel);
      syncProjectWorkspace(kernel);
    }
    return kernel;
  }
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export const studioStore = new StudioProjectStore();
