import { createRestartedStudioKernel, createStudioKernel, defaultAgentContracts, LocalAgentRuntime, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentId, AgentLoopState, MessageType, Room, RoomKind, StudioMessage } from "@game-pipeline/shared-schemas";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { verifyProjectClaims } from "./claimVerifier.js";
import { reconcileClaimRepairs } from "./claimRepair.js";
import { migrateLegacyClaimRepairStorm } from "./claimRepairMigration.js";
import { AgentLoopService } from "./agentLoop.js";
import { finalizeMessageActivity, recordServerToolActivity } from "./agentActivity.js";
import { ModelAgentRuntime } from "./modelAgentRuntime.js";
import { ProjectPersistenceStore, type ProjectSummary } from "./projectPersistence.js";
import { reconcileQaPlaytestResults } from "./qaResultIngestion.js";
import { executeAgentToolRequests } from "./toolExecutor.js";
import {
  deleteProjectWorkspace,
  readArtifactPreview,
  readWorkspaceTree,
  resolveArtifactWorkspaceTarget,
  resolveWorkspacePathOpenTarget,
  syncProjectWorkspace,
  type ArtifactPreviewResult,
  type WorkspacePathOpenTarget,
  type WorkspacePathTarget,
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
  private readonly agentLoop: AgentLoopService;

  constructor() {
    this.agentLoop = new AgentLoopService({
      getKernel: (projectId) => this.getKernel(projectId),
      checkpoint: (kernel) => {
        this.checkpointKernel(kernel);
      },
      modelRuntime: this.modelRuntime
    });
    const resumableProjectIds: string[] = [];
    for (const persistedKernel of this.persistence.loadAll()) {
      const migration = migrateLegacyClaimRepairStorm(persistedKernel);
      const kernel = migration.kernel;
      for (const activity of kernel.listAgentActivities()) {
        kernel.removeAgentActivity(activity.activityId);
      }
      const runtimeAssetTaskReopened = migrateRuntimeAssetPipeline(kernel);
      this.projects.set(kernel.project.projectId, kernel);
      this.checkpointKernel(kernel);
      if (
        kernel.project.executionStatus === "running" &&
        (["idle", "running", "blocked", "error"].includes(kernel.getAgentLoopState().status) || runtimeAssetTaskReopened)
      ) {
        resumableProjectIds.push(kernel.project.projectId);
      }
    }
    for (const projectId of resumableProjectIds) {
      this.agentLoop.start(projectId, {
        reason: "服务重启后恢复未完成的 Agent Loop。",
        unlockRetryableFailures: true
      });
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
        this.agentLoop.pause(kernel.project.projectId, `切换到项目 ${projectId}，当前项目已自动暂停。`);
      }
    }

    if (existing.project.executionStatus === "paused") {
      existing.updateProject({
        executionStatus: "running",
        updatedAt: now
      });
      this.agentLoop.start(projectId, {
        reason: "制作人继续项目，恢复未完成任务。",
        unlockRetryableFailures: true
      });
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
        scriptedReplies: false,
        modelReplies: false,
        bootstrapProjectState: true,
        protocolFlows: true
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
    this.agentLoop.pause(projectId);
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

  getAgentLoopState(projectId: string): AgentLoopState {
    return this.getKernel(projectId).getAgentLoopState();
  }

  updateRoomParticipant(
    projectId: string,
    roomKind: string,
    agentIdInput: string,
    action: "invite" | "remove"
  ): { room: Room; rooms: Room[]; changed: boolean } {
    const kernel = this.getKernel(projectId);
    const room = kernel.listRooms().find((candidate) => candidate.kind === roomKind);
    if (!room) {
      throw new HttpError(404, `Room not found: ${roomKind}`);
    }
    const agentId = agentIdInput as AgentId;
    if (!kernel.agents.has(agentId)) {
      throw new HttpError(400, `Unknown agent: ${agentIdInput}`);
    }

    const result = kernel.updateRoomParticipant(room.kind, agentId, action);
    if (result.changed) {
      const contract = kernel.agents.get(agentId);
      kernel.recordMessage({
        messageId: `msg_room_membership_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        projectId,
        roomId: result.room.roomId,
        senderType: "producer",
        senderId: kernel.project.producerId,
        messageType: "decision_record",
        content: action === "invite" ? `已邀请 ${contract.displayName} 加入当前房间。` : `已将 ${contract.displayName} 移出当前房间。`,
        mentions: [],
        relatedTaskIds: [],
        relatedArtifactIds: [],
        metadata: {
          roomMembershipChange: action,
          memberAgentId: agentId,
          roomKind: room.kind
        },
        createdAt: new Date().toISOString()
      });
      this.checkpointKernel(kernel);
    }

    return {
      room: result.room,
      rooms: kernel.listRooms(),
      changed: result.changed
    };
  }

  wakeAgentLoop(projectId: string): AgentLoopState {
    const kernel = this.getKernel(projectId);
    if (kernel.project.executionStatus !== "running") {
      throw new HttpError(409, "项目尚未启动或已暂停，不能继续 Agent Loop。");
    }
    return this.agentLoop.start(projectId, {
      reason: "制作人手动要求 Agents 继续未完成工作。",
      unlockProducerWaits: true,
      unlockRetryableFailures: true
    });
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
    options: { scriptedReplies: boolean; modelReplies: boolean; bootstrapProjectState?: boolean; protocolFlows?: boolean }
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

    const runtimeOptions = {
      scriptedReplies: options.scriptedReplies,
      ...(options.protocolFlows === undefined ? {} : { protocolFlows: options.protocolFlows }),
      ...(options.bootstrapProjectState === undefined ? {} : { bootstrapProjectState: options.bootstrapProjectState })
    };
    const result = this.runtime.handleProducerMessage(kernel, message, runtimeOptions);
    let modelMessagesHandled = false;
    if (options.modelReplies && result.agentMessages.length === 0) {
      const modelResult = await this.modelRuntime.respond(kernel, message, result.routePlan, {
        onAgentActivity: () => {
          this.checkpointKernel(kernel);
        },
        onAgentMessage: async (agentMessage) => {
          await executeAgentToolRequests(kernel, [agentMessage], {
            onActivity: (toolMessage, event) => {
              recordServerToolActivity(kernel, toolMessage, event);
              this.checkpointKernel(kernel);
            }
          });
          finalizeMessageActivity(kernel, agentMessage);
          this.checkpointKernel(kernel);
        }
      });
      result.agentMessages.push(...modelResult.agentMessages);
      modelMessagesHandled = true;
    }
    if (!modelMessagesHandled) {
      await executeAgentToolRequests(kernel, result.agentMessages);
      for (const agentMessage of result.agentMessages) {
        finalizeMessageActivity(kernel, agentMessage);
      }
    }
    const workspace = this.checkpointKernel(kernel);
    this.agentLoop.start(projectId, {
      reason: `制作人消息唤醒 Agent Loop：${message.messageId}`,
      triggerMessageId: message.messageId,
      preferredAgentIds: result.routePlan.targets.map((target) => target.agentId),
      unlockProducerWaits:
        !options.bootstrapProjectState && input.messageType !== "progress_update" && !isPresencePing(input.content),
      unlockRetryableFailures:
        !options.bootstrapProjectState && input.messageType !== "progress_update" && !isPresencePing(input.content)
    });
    return {
      ...result,
      workspace
    };
  }

  syncWorkspace(projectId: string): WorkspaceSyncResult {
    const kernel = this.getKernel(projectId);
    return this.checkpointKernel(kernel);
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

  openWorkspacePath(projectId: string, path: string, options: { allowFallback?: boolean } = {}): {
    opened: boolean;
    target: WorkspacePathTarget;
    requestedPath: WorkspacePathOpenTarget["requestedPath"];
    exact: WorkspacePathOpenTarget["exact"];
    nearestTarget?: WorkspacePathOpenTarget["nearestTarget"];
  } {
    const kernel = this.getKernel(projectId);
    syncProjectWorkspace(kernel);
    const resolved = resolveWorkspacePathOpenTarget(projectId, path);
    const target = resolved.target.exists ? resolved.target : options.allowFallback ? resolved.nearestTarget : resolved.target;
    if (!target || !target.exists) {
      throw new HttpError(404, `文件不存在，Agent 声明未验证：${resolved.requestedPath}`, {
        requestedPath: resolved.requestedPath,
        target: resolved.target,
        nearestTarget: resolved.nearestTarget
      });
    }

    openLocalPath(target.absolutePath, target.type ?? "file");
    return {
      opened: true,
      target,
      requestedPath: resolved.requestedPath,
      exact: resolved.exact && target === resolved.target,
      ...(resolved.nearestTarget ? { nearestTarget: resolved.nearestTarget } : {})
    };
  }

  deleteProject(projectId: string): { projectId: string } {
    this.getKernel(projectId);
    this.agentLoop.cancel(projectId);
    this.projects.delete(projectId);
    this.persistence.delete(projectId);
    deleteProjectWorkspace(projectId);
    return { projectId };
  }

  private loadProject(projectId: string): StudioKernel | undefined {
    const persistedKernel = this.persistence.load(projectId);
    if (persistedKernel) {
      const kernel = migrateLegacyClaimRepairStorm(persistedKernel).kernel;
      migrateRuntimeAssetPipeline(kernel);
      this.projects.set(projectId, kernel);
      syncProjectWorkspace(kernel);
      return kernel;
    }
    return undefined;
  }

  private checkpointKernel(kernel: StudioKernel): WorkspaceSyncResult {
    const qaIngestion = reconcileQaPlaytestResults(kernel);
    let workspace = syncProjectWorkspace(kernel);
    verifyProjectClaims(kernel);
    reconcileClaimRepairs(kernel);
    workspace = syncProjectWorkspace(kernel);
    this.persistence.save(kernel);
    if (qaIngestion.queuedAgentIds.length > 0 && kernel.project.executionStatus === "running") {
      queueMicrotask(() => {
        this.agentLoop.start(kernel.project.projectId, {
          reason: `QA 真实试玩失败已回流：${qaIngestion.failedOperationIds.join("、")}`,
          preferredAgentIds: qaIngestion.queuedAgentIds
        });
      });
    }
    return workspace;
  }
}

function migrateRuntimeAssetPipeline(kernel: StudioKernel): boolean {
  const task = kernel.findTask("task_stage_2_asset_pipeline");
  if (!task) {
    return false;
  }
  const criteria = [
    "asset manifest 存在且 runtimePath 指向 PNG",
    "每个 SVG 源资产都有经工具验证的同名 PNG",
    "关键资产符合 Art Bible"
  ];
  const artifacts = kernel.listArtifacts();
  const ledger = kernel.listArtifactLedger();
  const sourcePaths = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId)?.path)
    .filter((path): path is string => Boolean(path?.toLowerCase().endsWith(".svg")));
  const missingRuntimePng = sourcePaths.some((sourcePath) => {
    const runtimePath = sourcePath.replace(/\.svg$/i, ".png");
    const artifact = artifacts.find((candidate) => candidate.path === runtimePath);
    const evidence = artifact ? ledger.find((entry) => entry.artifactId === artifact.artifactId) : undefined;
    return !artifact?.metadata.toolExecutedAt || evidence?.status !== "verified";
  });
  const fields: Parameters<StudioKernel["updateTask"]>[1] = {
    description: "根据 Art Bible 生成 SVG 源资产，渲染 Cocos 可直接导入的透明 PNG，并维护 asset manifest。",
    acceptanceCriteria: criteria
  };
  const requiresRuntimePngWork = sourcePaths.length > 0 && missingRuntimePng;
  if (requiresRuntimePngWork && ["review", "done"].includes(task.status)) {
    fields.status = "doing";
    fields.progressPercent = Math.min(task.progressPercent ?? 80, 80);
    fields.blockers = task.blockers.filter((blocker) => !/Claude CLI.*(超时|没有产生工具写入)/i.test(blocker));
  }
  const criteriaChanged = task.acceptanceCriteria.join("\n") !== criteria.join("\n");
  if (criteriaChanged || fields.status) {
    fields.updatedAt = new Date().toISOString();
    kernel.updateTask(task.taskId, fields);
  }
  return requiresRuntimePngWork && (task.status === "doing" || fields.status === "doing");
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

function isPresencePing(content: string): boolean {
  return /^(有人吗|有人在吗|在吗|在不在|hello|hi|hey|ping|有人么)[？?!.。！\s]*$/i.test(content.trim());
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
  constructor(readonly statusCode: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const studioStore = new StudioProjectStore();
