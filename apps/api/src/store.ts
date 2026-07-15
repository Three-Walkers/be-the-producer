import { createStudioKernel, LocalAgentRuntime, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { MessageType, RoomKind, StudioMessage } from "@game-pipeline/shared-schemas";
import { readWorkspaceTree, syncProjectWorkspace, type WorkspaceSyncResult, type WorkspaceTreeEntry } from "./workspaceWriter.js";

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

  createProject(input: CreateProjectInput): {
    project: StudioKernel["project"];
    rooms: ReturnType<StudioKernel["listRooms"]>;
    workspace: WorkspaceSyncResult;
    bootstrap?: ReturnType<LocalAgentRuntime["handleProducerMessage"]>;
  } {
    const projectId = `game_${Date.now().toString(36)}`;
    const kernel = createStudioKernel(projectId, input.name, input.producerId ?? "producer_local");
    this.projects.set(projectId, kernel);

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

    if (input.idea) {
      result.bootstrap = this.postProducerMessage(projectId, {
        roomKind: "studio-main",
        content: input.idea,
        messageType: "plan_submission"
      });
      result.workspace = syncProjectWorkspace(kernel);
    }

    return result;
  }

  getKernel(projectId: string): StudioKernel {
    const kernel = this.projects.get(projectId);
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
    return {
      ...result,
      workspace: syncProjectWorkspace(kernel)
    };
  }

  syncWorkspace(projectId: string): WorkspaceSyncResult {
    return syncProjectWorkspace(this.getKernel(projectId));
  }

  readWorkspaceTree(projectId: string): {
    projectRoot: string;
    entries: WorkspaceTreeEntry[];
  } {
    this.getKernel(projectId);
    return readWorkspaceTree(projectId);
  }
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export const studioStore = new StudioProjectStore();
