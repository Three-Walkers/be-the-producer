import {
  createRestartedStudioKernel,
  createStudioKernel,
  defaultAgentContracts,
  LocalAgentRuntime,
  reconcileLocalRuntimeProjectState,
  workflowTaskStages,
  type GateEvidencePolicy,
  type StudioKernel
} from "@game-pipeline/agent-runtime";
import type { AgentId, AgentLoopState, MessageType, Room, RoomKind, StudioMessage } from "@game-pipeline/shared-schemas";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { verifyProjectClaims } from "./claimVerifier.js";
import { reconcileClaimRepairs } from "./claimRepair.js";
import { migrateLegacyClaimRepairStorm } from "./claimRepairMigration.js";
import { AgentLoopService } from "./agentLoop.js";
import { extractMentionedAgents } from "./agentMentions.js";
export { extractMentionedAgents } from "./agentMentions.js";
import { applyProducerChangeRequest, producerChangeTargets } from "./producerChangeRequest.js";
import { finalizeMessageActivity, recordServerToolActivity } from "./agentActivity.js";
import { ModelAgentRuntime } from "./modelAgentRuntime.js";
import { ProjectPersistenceStore, type ProjectStateRepository, type ProjectSummary } from "./projectPersistence.js";
import { reconcileQaPlaytestResults } from "./qaResultIngestion.js";
import { apiGateEvidencePolicy } from "./gateEvidencePolicy.js";
import { reconcileProductionAudit } from "./productionAudit.js";
import {
  captureCurrentStageReviewOutputEvidence,
  reconcileCurrentStageReviewOutputEvidence,
  reconcileInvalidQualityReviewEvidence
} from "./evidenceReconciliation.js";
import { executeAgentToolRequests } from "./toolExecutor.js";
import { assetProductionOutputsVerified } from "./taskOutputEvidence.js";
import {
  artifactClaimsMediaGeneration,
  hasCurrentGenerateRasterAssetReceipt,
  stripPrivilegedMaterializationMetadata
} from "./mediaArtifactEvidence.js";
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

export interface StudioProjectStoreDependencies {
  persistence?: ProjectStateRepository;
  localRuntime?: LocalAgentRuntime;
  modelRuntime?: ModelAgentRuntime;
}

export class StudioProjectStore {
  private readonly projects = new Map<string, StudioKernel>();
  private readonly runtime: LocalAgentRuntime;
  private readonly modelRuntime: ModelAgentRuntime;
  private readonly persistence: ProjectStateRepository;
  private readonly agentLoop: AgentLoopService;
  private readonly gateEvidencePolicy: GateEvidencePolicy;

  constructor(dependencies: StudioProjectStoreDependencies = {}) {
    this.gateEvidencePolicy = apiGateEvidencePolicy;
    this.runtime = dependencies.localRuntime ?? new LocalAgentRuntime({ gateEvidencePolicy: this.gateEvidencePolicy });
    this.modelRuntime = dependencies.modelRuntime ?? new ModelAgentRuntime();
    this.persistence = dependencies.persistence ?? new ProjectPersistenceStore();
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
      migrateLegacyMediaGenerationReceipts(kernel);
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
    const projectId = `game_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
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
        modelReplies: true,
        bootstrapProjectState: true,
        protocolFlows: false
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
    reconcileLocalRuntimeProjectState(kernel);
    this.checkpointKernel(kernel);
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
      gateEvidencePolicy: this.gateEvidencePolicy,
      ...(options.protocolFlows === undefined ? {} : { protocolFlows: options.protocolFlows }),
      ...(options.bootstrapProjectState === undefined ? {} : { bootstrapProjectState: options.bootstrapProjectState })
    };
    const result = this.runtime.handleProducerMessage(kernel, message, runtimeOptions);
    if (producerChangeTargets(kernel, message).length > 0) {
      // Abort the old generation before changing its inputs. In-flight model
      // results must not overwrite the producer's new requirement after return.
      this.agentLoop.pause(projectId, "制作人变更请求：取消旧执行并重新排程。");
      const changedTaskIds = applyProducerChangeRequest(kernel, message);
      const acknowledgement: StudioMessage = {
        messageId: `msg_producer_change_${randomUUID()}`, projectId, roomId: room.roomId,
        senderType: "agent", senderId: "studio_orchestrator", messageType: "progress_update",
        content: `已接收制作人变更请求，将重新执行 ${changedTaskIds.length} 项相关任务；旧文件保留，相关产物需重新提交和评审，无关工作不变。`,
        mentions: [], relatedTaskIds: changedTaskIds, relatedArtifactIds: [],
        metadata: { generatedBy: "producer_change_request", sourceMessageId: message.messageId },
        createdAt: new Date().toISOString()
      };
      kernel.recordMessage(acknowledgement);
      result.agentMessages.push(acknowledgement);
      this.checkpointKernel(kernel);
    }
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
      migrateLegacyMediaGenerationReceipts(kernel);
      reconcileLocalRuntimeProjectState(kernel);
      migrateRuntimeAssetPipeline(kernel);
      this.projects.set(projectId, kernel);
      const evidenceBaseline = captureCurrentStageReviewOutputEvidence(kernel);
      syncProjectWorkspace(kernel);
      reconcileCurrentStageReviewOutputEvidence(kernel, evidenceBaseline);
      reconcileInvalidQualityReviewEvidence(kernel);
      reconcileProductionAudit(kernel);
      syncProjectWorkspace(kernel);
      // Workspace sync can invalidate placeholder/file evidence even when the
      // runtime topology itself needed no migration. Persist every lazy load so
      // those evidence and task transitions survive a crash or restart.
      this.persistence.save(kernel);
      return kernel;
    }
    return undefined;
  }

  private checkpointKernel(kernel: StudioKernel): WorkspaceSyncResult {
    if (kernel.project.executionStatus === "running") {
      reconcileLocalRuntimeProjectState(kernel);
    }
    const qaIngestion = reconcileQaPlaytestResults(kernel);
    const evidenceBaseline = captureCurrentStageReviewOutputEvidence(kernel);
    let workspace = syncProjectWorkspace(kernel);
    verifyProjectClaims(kernel);
    reconcileClaimRepairs(kernel);
    workspace = syncProjectWorkspace(kernel);
    reconcileCurrentStageReviewOutputEvidence(kernel, evidenceBaseline);
    reconcileInvalidQualityReviewEvidence(kernel);
    reconcileProductionAudit(kernel);
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
    "至少一个真实 PNG 资产由 generate_raster_asset 物化并登记",
    "asset manifest 使用 schemaVersion=2.0.0，且每个 runtimePath 指向逐一验证的 PNG 并显式声明 alphaPolicy",
    "资产联系表覆盖第一可玩关键资产",
    "生成 provider/model/request/prompt hash/seed/尺寸证据完整",
    "每个 runtime PNG 都通过与 alphaPolicy 一致的确定性透明通道硬校验"
  ];
  const fields: Parameters<StudioKernel["updateTask"]>[1] = {
    description:
      "根据 Art Bible 通过真实图片生成模型生产第一可玩 PNG，保留模型与提示词证据，生成资产联系表并维护 asset manifest v2；逐项声明 alphaPolicy 并通过像素级透明通道硬校验。",
    acceptanceCriteria: criteria
  };
  const requiresRuntimePngWork = !assetProductionOutputsVerified(kernel, task);
  const taskIsExecutableNow = workflowTaskStages(kernel.project.currentStage).includes(task.stageId);
  if (requiresRuntimePngWork && taskIsExecutableNow && ["review", "done"].includes(task.status)) {
    fields.status = "doing";
    fields.progressPercent = Math.min(task.progressPercent ?? 80, 80);
    fields.blockers = task.blockers.filter((blocker) => !/Claude CLI.*(超时|没有产生工具写入)/i.test(blocker));
  }
  const criteriaChanged = task.acceptanceCriteria.join("\n") !== criteria.join("\n");
  if (criteriaChanged || fields.status) {
    fields.updatedAt = new Date().toISOString();
    kernel.updateTask(task.taskId, fields);
  }
  return taskIsExecutableNow && requiresRuntimePngWork && (task.status === "doing" || fields.status === "doing");
}

/**
 * Older snapshots allowed Agent-supplied Artifact.metadata to resemble a media
 * provider receipt.  Only receipts also stamped into the current immutable
 * artifact operation survive this one-way migration.
 */
export function migrateLegacyMediaGenerationReceipts(kernel: StudioKernel): boolean {
  const now = new Date().toISOString();
  let changed = false;
  for (const artifact of kernel.listArtifacts()) {
    if (!artifactClaimsMediaGeneration(artifact) || hasCurrentGenerateRasterAssetReceipt(kernel, artifact)) {
      continue;
    }
    const sanitizedMetadata = {
      ...stripPrivilegedMaterializationMetadata(artifact.metadata),
      toolExecutedAt: undefined,
      legacyMediaReceiptInvalidatedAt: now,
      legacyMediaReceiptInvalidationReason: "missing_current_server_materialization_operation"
    };
    const migrated = kernel.upsertArtifact({
      ...artifact,
      status: "change_requested",
      version: artifact.version + 1,
      metadata: sanitizedMetadata,
      updatedAt: now
    });
    migrated.metadata = sanitizedMetadata;
    changed = true;
  }
  return changed;
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
