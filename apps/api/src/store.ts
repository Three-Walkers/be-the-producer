import { createRestartedStudioKernel, createStudioKernel, defaultAgentContracts, LocalAgentRuntime, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { MessageType, RoomKind, StudioMessage } from "@game-pipeline/shared-schemas";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { ModelAgentRuntime } from "./modelAgentRuntime.js";
import { ProjectPersistenceStore, type ProjectSummary } from "./projectPersistence.js";
import {
  deleteProjectWorkspace,
  readArtifactPreview,
  readWorkspaceTree,
  resolveArtifactWorkspaceTarget,
  syncProjectWorkspace,
  type ArtifactPreviewResult,
  type WorkspaceSyncResult,
  type WorkspaceTreeEntry
} from "./workspaceWriter.js";

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
  private readonly modelRuntime = new ModelAgentRuntime();
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

  async startProject(projectId: string): Promise<ReturnType<LocalAgentRuntime["handleProducerMessage"]> & {
    project: StudioKernel["project"];
    rooms: ReturnType<StudioKernel["listRooms"]>;
    workspace: WorkspaceSyncResult;
  }> {
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

    if (existing.project.executionStatus === "paused") {
      existing.updateProject({
        executionStatus: "running",
        updatedAt: now
      });
      this.persistence.save(existing);
      return {
        routePlan: {
          targets: [],
          orchestratorSummaryRequired: false
        },
        agentMessages: [],
        project: existing.project,
        rooms: existing.listRooms(),
        workspace: syncProjectWorkspace(existing)
      };
    }

    existing.updateProject({ initialIdea });
    const restarted = createRestartedStudioKernel(existing.project);
    this.projects.set(projectId, restarted);
    const result = await this.handleProducerInput(
      projectId,
      {
        roomKind: "studio-main",
        content: initialIdea,
        messageType: "plan_submission"
      },
      {
        scriptedReplies: true,
        modelReplies: false
      }
    );
    const kernel = this.getKernel(projectId);
    return {
      ...result,
      project: kernel.project,
      rooms: kernel.listRooms(),
      workspace: syncProjectWorkspace(kernel)
    };
  }

  pauseProject(projectId: string): {
    project: StudioKernel["project"];
    rooms: ReturnType<StudioKernel["listRooms"]>;
    workspace: WorkspaceSyncResult;
  } {
    const kernel = this.getKernel(projectId);
    if (kernel.project.executionStatus !== "running") {
      throw new HttpError(409, "只有执行中的项目可以暂停。");
    }

    kernel.updateProject({
      executionStatus: "paused",
      updatedAt: new Date().toISOString()
    });
    this.persistence.save(kernel);
    return {
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

  postProducerMessage(projectId: string, input: PostMessageInput): Promise<ReturnType<LocalAgentRuntime["handleProducerMessage"]> & {
    workspace: WorkspaceSyncResult;
  }> {
    return this.handleProducerInput(projectId, input, {
      scriptedReplies: false,
      modelReplies: true
    });
  }

  private async handleProducerInput(
    projectId: string,
    input: PostMessageInput,
    options: { scriptedReplies: boolean; modelReplies: boolean }
  ): Promise<ReturnType<LocalAgentRuntime["handleProducerMessage"]> & {
    workspace: WorkspaceSyncResult;
  }> {
    const kernel = this.getKernel(projectId);
    if (kernel.project.executionStatus !== "running") {
      throw new HttpError(409, "项目尚未启动或已暂停，请先启动项目后再让 Agents 评审或执行。");
    }

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
      mentions: uniqueStrings([...(input.mentions ?? []), ...extractMentionedAgents(input.content)]),
      relatedTaskIds: [],
      relatedArtifactIds: [],
      metadata: {},
      createdAt: new Date().toISOString()
    };

    const result = this.runtime.handleProducerMessage(kernel, message, {
      scriptedReplies: options.scriptedReplies
    });
    if (options.modelReplies && result.agentMessages.length === 0) {
      const modelResult = await this.modelRuntime.respond(kernel, message, result.routePlan);
      result.agentMessages.push(...modelResult.agentMessages);
    }
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

  readArtifactPreview(projectId: string, artifactId: string): ArtifactPreviewResult {
    const kernel = this.getKernel(projectId);
    syncProjectWorkspace(kernel);
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) {
      throw new HttpError(404, `Artifact not found: ${artifactId}`);
    }

    return readArtifactPreview(projectId, artifact);
  }

  openArtifactInFinder(projectId: string, artifactId: string): {
    opened: boolean;
    target: ReturnType<typeof resolveArtifactWorkspaceTarget>;
  } {
    const kernel = this.getKernel(projectId);
    syncProjectWorkspace(kernel);
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) {
      throw new HttpError(404, `Artifact not found: ${artifactId}`);
    }

    const target = resolveArtifactWorkspaceTarget(projectId, artifact);
    if (!target.exists) {
      throw new HttpError(404, "交付物文件尚未写入本地工作空间。");
    }

    openLocalPath(target.absolutePath, target.type ?? "file");
    return {
      opened: true,
      target
    };
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

const mentionAliases: Record<string, string[]> = {
  studio_orchestrator: ["studio_orchestrator", "studio orchestrator", "orchestrator", "总控", "调度", "主持人"],
  producer: ["producer", "producer agent", "制作人协调", "制作"],
  game_designer: ["game_designer", "game designer", "策划", "游戏策划"],
  art_director: ["art_director", "art director", "美术", "美术导演"],
  asset_production: ["asset_production", "asset production", "资产", "资产生产"],
  cocos_tech_lead: ["cocos_tech_lead", "cocos tech lead", "cocos", "技术负责人", "架构"],
  gameplay_programmer: ["gameplay_programmer", "gameplay programmer", "程序", "玩法程序", "开发"],
  cocos_automation: ["cocos_automation", "cocos automation", "自动化", "编辑器"],
  qa_evaluator: ["qa_evaluator", "game evaluator", "qa", "测试", "评估"],
  wechat_platform: ["wechat_platform", "wechat platform", "微信", "平台"],
  devops: ["devops", "运维", "部署"],
  liveops_analytics: ["liveops_analytics", "liveops", "analytics", "运营", "数据"]
};

function extractMentionedAgents(content: string): string[] {
  const normalized = content.toLowerCase();
  const mentioned = defaultAgentContracts
    .filter((agent) => {
      const aliases = [agent.agentId, agent.displayName, ...(mentionAliases[agent.agentId] ?? [])];
      return aliases.some((alias) => normalized.includes(`@${alias.toLowerCase()}`));
    })
    .map((agent) => agent.agentId);
  return uniqueStrings(mentioned);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function openLocalPath(absolutePath: string, type: "file" | "directory"): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const args =
    process.platform === "darwin"
      ? type === "file"
        ? ["-R", absolutePath]
        : [absolutePath]
      : process.platform === "win32"
        ? type === "file"
          ? [`/select,${absolutePath}`]
          : [absolutePath]
        : [type === "file" ? dirname(absolutePath) : absolutePath];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export const studioStore = new StudioProjectStore();
