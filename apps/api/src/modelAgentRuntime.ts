import { defaultAgentContracts, type RoutePlan, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentContract, AgentId, AgentLoopControl, AgentSessionRecord, MessageType, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import { generateModelChat } from "./modelClient.js";
import { modelSettingsStore } from "./modelSettings.js";
import { executableToolsForAgent, type ToolExecutionResult } from "./toolExecutor.js";
import { ClaudeSessionResumeError, claudeCliHarness } from "./claudeCliHarness.js";
import { allowedRootsForAgent, attachHarnessEvidenceToMessage, captureWorkspaceSnapshot, recordHarnessWorkspaceChanges } from "./harnessWorkspaceEvidence.js";
import { readArtifactContentForModel, resolveProjectWorkspaceRoot, syncProjectWorkspace } from "./workspaceWriter.js";
import { expectedHarnessOutputPaths, requiredRuntimePngPaths, taskOutputsVerified } from "./taskOutputEvidence.js";
import { sessionCoordinator } from "./sessionCoordinator.js";

export interface ModelAgentRunResult {
  agentMessages: StudioMessage[];
}

export interface AgentTaskRunInput {
  iteration: number;
  triggerMessageId?: string;
  previousToolResults?: ToolExecutionResult[];
  abortSignal?: AbortSignal;
}

export class ModelAgentRuntime {
  async respond(kernel: StudioKernel, producerMessage: StudioMessage, routePlan: RoutePlan): Promise<ModelAgentRunResult> {
    const targets = selectTargets(producerMessage, routePlan);
    const agents = targets
      .map((agentId) => defaultAgentContracts.find((candidate) => candidate.agentId === agentId))
      .filter((agent): agent is AgentContract => Boolean(agent));
    const agentMessages = await Promise.all(
      agents.map((agent) => this.respondAsAgent(kernel, producerMessage, agent, routePlan))
    );
    for (const message of agentMessages) {
      kernel.recordMessage(message);
    }

    return { agentMessages };
  }

  async respondToTask(kernel: StudioKernel, task: Task, input: AgentTaskRunInput): Promise<StudioMessage> {
    const agent = defaultAgentContracts.find((candidate) => candidate.agentId === task.ownerAgentId);
    if (!agent) {
      throw new Error(`Task owner Agent not found: ${task.ownerAgentId}`);
    }
    const assignment = modelSettingsStore.getAgentAssignment(agent.agentId);
    const provider = modelSettingsStore.getProviderConfig(assignment.providerId);
    const model = assignment.model || provider.defaultModel;
    const room = kernel.listRooms().find((candidate) => candidate.roomId === task.roomId) ?? kernel.getRoom(agent.roomMemberships[0] ?? "studio-main");
    const session = sessionCoordinator.getOrCreateTaskChildSession(kernel, task, agent, room.roomId, {
      providerId: provider.providerId,
      model,
      harnessId: assignment.harnessId
    });
    if (assignment.harnessId === "claude-cli") {
      return this.respondToTaskWithClaudeHarness(kernel, task, agent, room.roomId, provider, model, input, session);
    }
    return sessionCoordinator.runExclusive(kernel, session, async (currentSession) => {
      const prepared = sessionCoordinator.prepareContext(kernel, currentSession, agent, room.roomId, task, input.triggerMessageId);
      try {
        const result = await generateModelChat(provider, {
          model,
          systemPrompt: buildSystemPrompt(agent),
          userPrompt: buildTaskLoopPrompt(kernel, task, agent, input, prepared.context.prompt),
          maxTokens: 3000,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        });
        sessionCoordinator.commitSuccess(kernel, prepared.session, prepared.context.packet, { outputText: result.content });
        const guarded = enforceProducerGateBoundary(kernel, result.content);
        const message: StudioMessage = {
          messageId: `msg_${agent.agentId}_loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          projectId: kernel.project.projectId,
          roomId: room.roomId,
          senderType: "agent",
          senderId: agent.agentId,
          messageType: guarded.messageType ?? "progress_update",
          content: guarded.content,
          mentions: [],
          relatedTaskIds: [task.taskId],
          relatedArtifactIds: [],
          metadata: {
            generatedBy: "agent_loop",
            providerId: result.providerId,
            model: result.model,
            latencyMs: result.latencyMs,
            loopIteration: input.iteration,
            loopTaskId: task.taskId,
            sessionKey: prepared.session.sessionKey,
            sessionScope: prepared.session.scope,
            contextPacketId: prepared.context.packet.packetId,
            contextHealth: prepared.context.packet.health,
            ...guarded.metadata
          },
          createdAt: new Date().toISOString()
        };
        return message;
      } catch (error) {
        return createTaskFailureMessage(kernel, task, agent, room.roomId, provider.providerId, model, input, prepared.session, error);
      }
    });
  }

  private async respondToTaskWithClaudeHarness(
    kernel: StudioKernel,
    task: Task,
    agent: AgentContract,
    roomId: string,
    provider: ReturnType<typeof modelSettingsStore.getProviderConfig>,
    model: string,
    input: AgentTaskRunInput,
    initialSession: AgentSessionRecord
  ): Promise<StudioMessage> {
    const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
    syncProjectWorkspace(kernel);
    return sessionCoordinator.runExclusive(kernel, initialSession, async (lockedSession) => {
      let prepared = sessionCoordinator.prepareContext(kernel, lockedSession, agent, roomId, task, input.triggerMessageId);
      const before = captureWorkspaceSnapshot(projectRoot);
      try {
        let result;
        try {
          result = await runClaudeTaskSession(kernel, task, agent, provider, model, input, projectRoot, prepared.session, prepared.context.prompt);
        } catch (error) {
          if (!(error instanceof ClaudeSessionResumeError)) throw error;
          const recovered = sessionCoordinator.recoverResumeFailure(kernel, prepared.session, error.message);
          prepared = sessionCoordinator.prepareContext(kernel, recovered, agent, roomId, task, input.triggerMessageId);
          result = await runClaudeTaskSession(kernel, task, agent, provider, model, input, projectRoot, prepared.session, prepared.context.prompt);
        }
        const after = captureWorkspaceSnapshot(projectRoot);
        const evidence = recordHarnessWorkspaceChanges(kernel, task, agent, before, after, result.invocationId, result.changedPaths, result.toolOperations);
        const outputsVerified = taskOutputsVerified(kernel, task);
        const reportedControl = result.loopControl;
        const loopControl = evidence.violations.length > 0
          ? {
              status: "blocked" as const,
              reason: `Harness 检测到越权或删除操作：${evidence.violations.join("；")}`,
              handoffAgentIds: []
            }
          : outputsVerified
            ? {
                status: "ready_for_review" as const,
                reason: "任务登记输出已由本轮 Claude CLI 文件证据验证，等待制作人评审。",
                handoffAgentIds: []
              }
            : reportedControl?.status === "ready_for_review"
              ? {
                  status: "continue" as const,
                  reason: "Agent 请求评审，但登记输出尚未全部通过证据验证，继续补齐真实产物。",
                  handoffAgentIds: []
                }
              : reportedControl ?? {
                  status: "continue" as const,
                  reason: evidence.changedPaths.length > 0 ? "本轮已有文件进展，继续完成尚未验证的任务输出。" : "本轮未形成新的文件证据，继续执行任务。",
                  handoffAgentIds: []
                };
        const committed = sessionCoordinator.commitSuccess(kernel, prepared.session, prepared.context.packet, {
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          invocationId: result.invocationId,
          outputText: result.content
        });
        const guarded = enforceProducerGateBoundary(kernel, result.content);
        const message: StudioMessage = {
          messageId: `msg_${agent.agentId}_harness_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          projectId: kernel.project.projectId,
          roomId,
          senderType: "agent",
          senderId: agent.agentId,
          messageType: guarded.messageType ?? "progress_update",
          content: renderHarnessResult(guarded.content, evidence.changedPaths, evidence.violations),
          mentions: loopControl.handoffAgentIds,
          relatedTaskIds: [task.taskId],
          relatedArtifactIds: [...task.outputArtifacts],
          metadata: {
            generatedBy: "claude_cli_harness",
            harnessId: result.harnessId,
            sessionStrategy: "persistent_task_child",
            sessionKey: committed.sessionKey,
            sessionScope: committed.scope,
            parentSessionKey: committed.parentSessionKey,
            sessionEpoch: committed.epoch,
            harnessInvocationId: result.invocationId,
            harnessSessionId: result.sessionId,
            resumeAttempted: result.resumeAttempted,
            resumed: result.resumed,
            contextPacketId: prepared.context.packet.packetId,
            contextHealth: prepared.context.packet.health,
            providerId: result.providerId,
            model: result.model,
            latencyMs: result.latencyMs,
            rawEventCount: result.rawEventCount,
            ...(result.terminationReason ? { harnessTerminationReason: result.terminationReason } : {}),
            loopIteration: input.iteration,
            loopTaskId: task.taskId,
            loopControl,
            ...guarded.metadata
          },
          createdAt: new Date().toISOString()
        };
        attachHarnessEvidenceToMessage(message, evidence);
        kernel.updateAgentLoopAgent(agent.agentId, {
          harnessId: "claude-cli",
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          lastInvocationId: result.invocationId,
          lastChangedPaths: evidence.changedPaths,
          updatedAt: new Date().toISOString()
        });
        return message;
      } catch (error) {
        sessionCoordinator.markFailed(kernel, prepared.session, error instanceof Error ? error.message : String(error));
        return createTaskFailureMessage(kernel, task, agent, roomId, provider.providerId, model, input, prepared.session, error, "claude_cli_harness");
      }
    });
  }

  private async respondAsAgent(
    kernel: StudioKernel,
    producerMessage: StudioMessage,
    agent: AgentContract,
    routePlan: RoutePlan
  ): Promise<StudioMessage> {
    const assignment = modelSettingsStore.getAgentAssignment(agent.agentId);
    const provider = modelSettingsStore.getProviderConfig(assignment.providerId);
    const model = assignment.model || provider.defaultModel;
    const route = routePlan.targets.find((target) => target.agentId === agent.agentId);
    const session = sessionCoordinator.getOrCreateRoomSession(kernel, agent, producerMessage.roomId, {
      providerId: provider.providerId,
      model,
      harnessId: assignment.harnessId
    });
    return sessionCoordinator.runExclusive(kernel, session, async (lockedSession) => {
      let prepared = sessionCoordinator.prepareContext(kernel, lockedSession, agent, producerMessage.roomId, undefined, producerMessage.messageId);
      try {
        if (assignment.harnessId === "claude-cli") {
          let result;
          try {
            result = await runClaudeRoomSession(kernel, producerMessage, agent, provider, model, route?.reasons ?? [], prepared.session, prepared.context.prompt);
          } catch (error) {
            if (!(error instanceof ClaudeSessionResumeError)) throw error;
            const recovered = sessionCoordinator.recoverResumeFailure(kernel, prepared.session, error.message);
            prepared = sessionCoordinator.prepareContext(kernel, recovered, agent, producerMessage.roomId, undefined, producerMessage.messageId);
            result = await runClaudeRoomSession(kernel, producerMessage, agent, provider, model, route?.reasons ?? [], prepared.session, prepared.context.prompt);
          }
          const committed = sessionCoordinator.commitSuccess(kernel, prepared.session, prepared.context.packet, {
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            invocationId: result.invocationId,
            outputText: result.content
          });
          const guarded = enforceProducerGateBoundary(kernel, result.content);
          return createAgentMessage(kernel, producerMessage, agent.agentId, guarded.messageType ?? inferMessageType(producerMessage), guarded.content, {
            generatedBy: "claude_cli_room_session",
            providerId: result.providerId,
            model: result.model,
            latencyMs: result.latencyMs,
            executionPath: "claude_cli_room_session",
            configuredHarnessId: assignment.harnessId,
            sessionStrategy: "persistent_room",
            sessionKey: committed.sessionKey,
            sessionScope: committed.scope,
            sessionEpoch: committed.epoch,
            harnessSessionId: result.sessionId,
            harnessInvocationId: result.invocationId,
            resumeAttempted: result.resumeAttempted,
            resumed: result.resumed,
            contextPacketId: prepared.context.packet.packetId,
            contextHealth: prepared.context.packet.health,
            routeReasons: route?.reasons ?? [],
            ...guarded.metadata
          });
        }
        const result = await generateModelChat(provider, {
          model,
          systemPrompt: buildSystemPrompt(agent),
          userPrompt: buildUserPrompt(kernel, producerMessage, agent, route?.reasons ?? [], prepared.context.prompt),
          maxTokens: 1800,
          timeoutMs: 120_000
        });
        const committed = sessionCoordinator.commitSuccess(kernel, prepared.session, prepared.context.packet, { outputText: result.content });
        const guarded = enforceProducerGateBoundary(kernel, result.content);
        return createAgentMessage(kernel, producerMessage, agent.agentId, guarded.messageType ?? inferMessageType(producerMessage), guarded.content, {
          generatedBy: "model_agent_runtime",
          providerId: result.providerId,
          model: result.model,
          latencyMs: result.latencyMs,
          executionPath: "direct_model_api",
          configuredHarnessId: assignment.harnessId,
          sessionStrategy: "persistent_room_cursor",
          sessionKey: committed.sessionKey,
          sessionScope: committed.scope,
          contextPacketId: prepared.context.packet.packetId,
          contextHealth: prepared.context.packet.health,
          routeReasons: route?.reasons ?? [],
          ...guarded.metadata
        });
      } catch (error) {
        const failure = describeModelReplyFailure(error);
        sessionCoordinator.markFailed(kernel, prepared.session, failure.userMessage);
        return createAgentMessage(
          kernel,
          producerMessage,
          agent.agentId,
          "blocker",
          `我被路由到这条消息，但模型回复失败：${failure.userMessage}`,
          {
            generatedBy: "model_agent_runtime",
            providerId: provider.providerId,
            model,
            executionPath: assignment.harnessId === "claude-cli" ? "claude_cli_room_session" : "direct_model_api",
            configuredHarnessId: assignment.harnessId,
            sessionKey: prepared.session.sessionKey,
            contextPacketId: prepared.context.packet.packetId,
            contextHealth: prepared.context.packet.health,
            failureKind: failure.kind,
            routeReasons: route?.reasons ?? [],
            failure: true
          }
        );
      }
    });
  }
}

export function finalizeTaskSessionProtocol(kernel: StudioKernel, task: Task, message: StudioMessage): void {
  const sessionKey = typeof message.metadata.sessionKey === "string" ? message.metadata.sessionKey : undefined;
  if (!sessionKey) return;
  const session = kernel.findAgentSession(sessionKey);
  if (!session || session.scope !== "task_child") return;
  const control = readMessageLoopControl(message);
  const toolResults = Array.isArray(message.metadata.toolExecutions)
    ? (message.metadata.toolExecutions as ToolExecutionResult[])
    : [];
  const changedPaths = toolResults
    .filter((result) => result.status === "completed" && result.path)
    .map((result) => result.path as string);
  const alreadyReturned = kernel.listHandoffCapsules().some(
    (capsule) => capsule.kind === "child_to_parent" && capsule.messageIds.includes(message.messageId)
  );
  if (!alreadyReturned) {
    sessionCoordinator.returnChildToParent(kernel, session, {
      summary: message.content,
      message,
      changedPaths,
      artifactIds: task.outputArtifacts
    });
  }
  if (control?.status === "handoff") {
    const alreadyHandedOff = kernel.listHandoffCapsules().some(
      (capsule) => capsule.kind === "agent_handoff" && capsule.messageIds.includes(message.messageId)
    );
    if (!alreadyHandedOff) {
      const targets = defaultAgentContracts.filter((candidate) => control.handoffAgentIds.includes(candidate.agentId));
      if (targets.length > 0) {
        sessionCoordinator.handoffToAgents(kernel, session, targets, sessionIdentityFor, {
          summary: control.reason,
          message,
          changedPaths,
          artifactIds: task.outputArtifacts
        });
      }
    }
  }
  const currentTask = kernel.findTask(task.taskId) ?? task;
  const reviewAccepted = control?.status === "ready_for_review"
    && ["review", "done"].includes(currentTask.status)
    && taskOutputsVerified(kernel, currentTask);
  if (reviewAccepted || control?.status === "handoff") {
    sessionCoordinator.sealCompletedChild(kernel, session, `任务回流协议以 ${control.status} 收束：${control.reason}`);
  }
}

function readMessageLoopControl(message: StudioMessage): AgentLoopControl | undefined {
  const value = message.metadata.loopControl;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const control = value as Partial<AgentLoopControl>;
  const statuses: AgentLoopControl["status"][] = ["continue", "waiting_for_producer", "handoff", "ready_for_review", "blocked"];
  if (!control.status || !statuses.includes(control.status) || typeof control.reason !== "string" || !control.reason.trim()) {
    return undefined;
  }
  return {
    status: control.status,
    reason: control.reason,
    handoffAgentIds: Array.isArray(control.handoffAgentIds) ? control.handoffAgentIds : []
  };
}

async function runClaudeTaskSession(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  provider: ReturnType<typeof modelSettingsStore.getProviderConfig>,
  model: string,
  input: AgentTaskRunInput,
  projectRoot: string,
  session: AgentSessionRecord,
  contextPrompt: string
) {
  return claudeCliHarness.run({
    projectId: kernel.project.projectId,
    projectRoot,
    agent,
    provider,
    model,
    systemPrompt: buildClaudeHarnessSystemPrompt(agent),
    userPrompt: buildClaudeHarnessTaskPrompt(kernel, task, agent, input, contextPrompt),
    allowedRoots: allowedRootsForAgent(agent),
    expectedPaths: expectedHarnessOutputPaths(kernel, task),
    requireToolProgress: true,
    toolMode: "task",
    sessionKey: session.sessionKey,
    sessionScope: session.scope,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });
}

async function runClaudeRoomSession(
  kernel: StudioKernel,
  producerMessage: StudioMessage,
  agent: AgentContract,
  provider: ReturnType<typeof modelSettingsStore.getProviderConfig>,
  model: string,
  routeReasons: string[],
  session: AgentSessionRecord,
  contextPrompt: string
) {
  const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
  syncProjectWorkspace(kernel);
  return claudeCliHarness.run({
    projectId: kernel.project.projectId,
    projectRoot,
    agent,
    provider,
    model,
    systemPrompt: buildClaudeRoomSystemPrompt(agent),
    userPrompt: [
      contextPrompt,
      "",
      `本次路由原因：${routeReasons.join("、") || "房间职责匹配"}`,
      `制作人当前消息：${producerMessage.content}`,
      "请直接以当前角色回复制作人。当前是房间讨论 session，不创建产物；需要落地工作时应明确关联或创建任务，由独立 task child session 执行。"
    ].join("\n"),
    allowedRoots: allowedRootsForAgent(agent),
    expectedPaths: [],
    requireToolProgress: false,
    toolMode: "conversation",
    sessionKey: session.sessionKey,
    sessionScope: session.scope,
    ...(session.sessionId ? { sessionId: session.sessionId } : {})
  });
}

function buildClaudeRoomSystemPrompt(agent: AgentContract): string {
  return [
    buildSystemPrompt(agent),
    "这是持久化房间讨论 session。你可以读取项目事实，但本 session 不写文件、不执行任务状态工具，也不把讨论冒充为已落地产物。",
    "任务执行将由独立 task child session 完成；你负责澄清、评审、解释、形成可交接的意图，并吸收 child session 回流胶囊。"
  ].join("\n");
}

function sessionIdentityFor(agent: AgentContract): { providerId: string; model: string; harnessId: "direct-api" | "claude-cli" } {
  const assignment = modelSettingsStore.getAgentAssignment(agent.agentId);
  const provider = modelSettingsStore.getProviderConfig(assignment.providerId);
  return {
    providerId: provider.providerId,
    model: assignment.model || provider.defaultModel,
    harnessId: assignment.harnessId
  };
}

function createTaskFailureMessage(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  roomId: string,
  providerId: string,
  model: string,
  input: AgentTaskRunInput,
  session: AgentSessionRecord,
  error: unknown,
  generatedBy = "agent_loop"
): StudioMessage {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const failureKind = /没有产生工具写入/.test(errorMessage) ? "harness_timeout_no_progress" : "harness_execution_error";
  return {
    messageId: `msg_${agent.agentId}_harness_error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId,
    senderType: "agent",
    senderId: agent.agentId,
    messageType: "blocker",
    content: `任务「${task.title}」的执行失败：${errorMessage}`,
    mentions: [],
    relatedTaskIds: [task.taskId],
    relatedArtifactIds: [],
    metadata: {
      generatedBy,
      harnessId: session.harnessId,
      providerId,
      model,
      loopIteration: input.iteration,
      loopTaskId: task.taskId,
      sessionKey: session.sessionKey,
      sessionScope: session.scope,
      sessionEpoch: session.epoch,
      failureKind,
      failure: true
    },
    createdAt: new Date().toISOString()
  };
}

function describeModelReplyFailure(error: unknown): { kind: "timeout" | "cancelled" | "configuration_or_provider"; userMessage: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/超时|超过\s*\d+\s*秒/i.test(message)) {
    return {
      kind: "timeout",
      userMessage: `${message} 这不代表 API Key 无效；可以重试消息，系统不会把本次超时误判为角色配置错误。`
    };
  }
  if (/暂停|切换|取消|终止/i.test(message)) {
    return {
      kind: "cancelled",
      userMessage: message
    };
  }
  return {
    kind: "configuration_or_provider",
    userMessage: `${message} 请在设置中检查该角色的 Provider、模型名和连通性测试。`
  };
}

function buildTaskLoopPrompt(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  input: AgentTaskRunInput,
  contextPrompt: string
): string {
  const inputArtifacts = task.inputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact) => artifact !== undefined)
    .map((artifact) => {
      const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId);
      const content = ledger?.status === "verified" ? readArtifactContentForModel(kernel.project.projectId, artifact, 8_000) : undefined;
      return [
        `### ${artifact.artifactId}`,
        `路径：${artifact.path}`,
        `状态：${artifact.status}；证据：${ledger?.status ?? "missing"}`,
        content ? `内容：\n${content}` : "内容：当前不可读取或尚未验证。"
      ].join("\n");
    })
    .join("\n\n");
  const outputs = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId) ?? { artifactId, path: "由你选择安全的项目相对路径", type: "待推断" })
    .map((artifact) => `- artifactId=${artifact.artifactId}；type=${artifact.type}；path=${artifact.path}`)
    .join("\n");
  const tools = executableToolsForAgent(agent);
  const previousToolResults = input.previousToolResults?.length
    ? input.previousToolResults.map((result) => `- ${result.toolName}: ${result.status}${result.path ? ` ${result.path}` : ""}${result.error ? `；${result.error}` : ""}`).join("\n")
    : "无";

  return [
    contextPrompt,
    "",
    `这是 Agent Loop 第 ${input.iteration} 轮。你正在持续执行一个已分配任务。`,
    `项目：${kernel.project.name}`,
    `初始 idea：${kernel.project.initialIdea ?? "未记录"}`,
    `阶段：${kernel.project.currentStage}`,
    `任务 ID：${task.taskId}`,
    `任务：${task.title}`,
    `说明：${task.description}`,
    `当前状态：${task.status}；进度：${task.progressPercent ?? 0}%`,
    `阻塞：${task.blockers.join("；") || "无"}`,
    `验收标准：${task.acceptanceCriteria.join("；") || "无"}`,
    "",
    "预期输出：",
    outputs || "该任务没有登记输出产物；只能汇报、交接或请求制作人判断。",
    "",
    "已验证的上游产物：",
    inputArtifacts || "无",
    "",
    "上一轮工具结果：",
    previousToolResults,
    "",
    `你当前真正可调用的服务端工具：${tools.join("、") || "无"}。只能调用这里列出的工具。`,
    toolExecutionGuidance(tools),
    "产出文件时必须在本轮直接提交工具请求，不能说稍后执行或等待服务端代替你执行。",
    "写入型工具请求必须包含 tool、path、content；已登记输出还必须填写 artifactId 和 taskId。run_typecheck 只需要 tool 和 path；Cocos Bridge 与 run_playtest 按工具参数调用，不需要 content。",
    "",
    "回复末尾必须且只能附加一个 JSON 代码块作为循环控制协议：",
    "```json",
    '{"loopControl":{"status":"continue|waiting_for_producer|handoff|ready_for_review|blocked","reason":"具体原因","handoffAgentIds":[]},"toolRequests":[]}',
    "```",
    "status 规则：有可立即执行的后续步骤用 continue；必须让制作人判断时用 waiting_for_producer；需要其他角色接棒用 handoff；本任务输出已在本轮提交且可验证时用 ready_for_review；缺工具、依赖或环境时用 blocked。",
    "你不能把任务或阶段直接标记 done，也不能绕过制作人阶段门禁。",
    stageGateInstruction(kernel.project.currentStage)
  ].join("\n");
}

function buildClaudeHarnessSystemPrompt(agent: AgentContract): string {
  const roleSpecificInstructions = agent.agentId === "asset_production"
    ? [
        "SVG 只能作为可编辑源资产，不能作为 Cocos 运行时交付物。每个登记到任务的 SVG 都必须调用 mcp__btp_workspace__render_svg_to_png 生成同名 PNG，并在 asset manifest 中把 PNG 标记为 runtimePath。",
        "只有全部 SVG 都存在对应 PNG、PNG 已通过工具证据登记且 manifest 指向 PNG 时，才可以请求 ready_for_review。"
      ]
    : agent.agentId === "qa_evaluator"
      ? [
          "你不能通过阅读代码或手写测试报告宣布可玩性通过。每次首个可玩或发布门禁任务必须调用 mcp__btp_workspace__run_playtest，让服务端真实构建并驱动游戏。",
          "run_playtest 的 fail/blocked 是有效测试结果，不要反复运行同一个未修复构建。必须报告 handoff，把结构化缺陷交给对应程序、Cocos 或美术角色；只有 verdict=pass 才能请求 ready_for_review。",
          "你禁止直接修改游戏代码和美术资产。你的职责是执行、取证、分级、复测和守住门禁。"
        ]
      : [];
  return [
    `你是 Be The Producer 游戏工作室里的 ${agent.displayName}。`,
    `职责：${agent.roleScope}`,
    `角色主工作区：${agent.workspace}`,
    "当前工作目录是该游戏项目的 Cocos Creator 项目根目录。你可以读取项目，并通过 btp_workspace MCP 工具创建、替换、追加和枚举角色获准路径中的文件。",
    "创建或替换文件必须调用 mcp__btp_workspace__write_artifact，追加文档调用 mcp__btp_workspace__append_document。必须实际调用工具，不能声称等待服务端代写，也不能只在回复中给出一个虚构路径。",
    "不要修改 .be-the-producer、shared/task-board、shared/tasks、shared/chat、shared/memory、shared/artifacts、shared/claims、shared/audit 下由调度器维护的状态文件。",
    "不要访问项目根目录之外的路径，不要读取或回显 API key、环境变量和本机凭据。",
    "不要提交 git，不要部署生产环境，不要执行破坏性命令；这些动作需要制作人门禁和专用工具。",
    ...roleSpecificInstructions,
    "阶段必须保持开放，除非制作人完成门禁评审和二次确认。你不能宣布阶段结束、批准发布或擅自进入下一阶段。",
    "结束本轮前必须调用 mcp__btp_workspace__report_task_status 上报 continue、waiting_for_producer、handoff、ready_for_review 或 blocked，并用中文简要说明实际检查了什么、实际改了哪些文件、仍有哪些问题。完成声明必须与真实文件一致。"
  ].join("\n");
}

function buildClaudeHarnessTaskPrompt(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  input: AgentTaskRunInput,
  contextPrompt: string
): string {
  const expectedOutputs = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact) => artifact !== undefined)
    .map((artifact) => {
      const evidence = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId);
      return `- ${artifact.artifactId}: ${artifact.path} (${artifact.type}; ${artifact.metadata.toolExecutedAt && evidence?.status === "verified" ? "已验证" : "待验证"})`;
    })
    .join("\n");
  const verifiedInputs = task.inputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact) => artifact !== undefined)
    .map((artifact) => `- ${artifact.path}`)
    .join("\n");
  const runtimePngOutputs = requiredRuntimePngPaths(kernel, task);
  return [
    contextPrompt,
    "",
    `持续执行轮次：${input.iteration}`,
    `项目：${kernel.project.name}`,
    `初始 idea：${kernel.project.initialIdea ?? "未记录"}`,
    `当前阶段：${kernel.project.currentStage}`,
    `角色：${agent.displayName} (${agent.agentId})`,
    `任务 ID：${task.taskId}`,
    `任务：${task.title}`,
    `说明：${task.description}`,
    `当前进度：${task.progressPercent ?? 0}%`,
    `验收标准：${task.acceptanceCriteria.join("；") || "无"}`,
    `当前阻塞：${task.blockers.join("；") || "无"}`,
    "",
    "本任务登记输出：",
    expectedOutputs || "没有预登记文件；请在角色工作区创建可验证的工作产物。",
    expectedOutputs ? "必须先创建或更新上面列出的精确路径；可以增加辅助文件，但辅助文件不能替代登记输出。" : "",
    ...(runtimePngOutputs.length > 0
      ? [
          "",
          "Cocos 运行时 PNG（必须由 render_svg_to_png 从对应 SVG 生成）：",
          ...runtimePngOutputs.map((path) => {
            const artifact = kernel.listArtifacts().find((candidate) => candidate.path === path);
            const evidence = artifact ? kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId) : undefined;
            return `- ${path} (${artifact?.metadata.toolExecutedAt && evidence?.status === "verified" ? "已验证，无需重复渲染" : "待生成或待验证"})`;
          })
        ]
      : []),
    "",
    "已验证的上游文件：",
    verifiedInputs || "无",
    "",
    agent.agentId === "qa_evaluator"
      ? "请现在调用 run_playtest 执行真实试玩。不要编辑游戏产物；失败时依据工具返回的结构化缺陷 handoff 给责任角色，成功时才请求评审。"
      : `请现在持续完成该任务，直接使用工具检查和修改项目。优先写入 ${agent.workspace} 或上述登记输出路径。`,
    "不要输出 JSON 工具协议；直接调用 btp_workspace MCP 工具。没有实际文件变化时，不得说已完成。",
    "本轮结束前必须调用 report_task_status。能继续推进就填 continue；只有确实需要制作人决定时填 waiting_for_producer；需要其他角色接棒时填 handoff；真实依赖缺失时填 blocked。ready_for_review 仍必须由 Artifact Ledger 证据通过后才生效。",
    stageGateInstruction(kernel.project.currentStage)
  ].join("\n");
}

function renderHarnessResult(content: string, changedPaths: string[], violations: string[]): string {
  const evidence = changedPaths.length > 0
    ? ["", "---", "本轮已验证文件：", ...changedPaths.map((path) => `- \`${path}\``)]
    : ["", "---", "本轮没有检测到新的文件证据。"];
  if (violations.length > 0) {
    evidence.push("", "未登记的越权操作：", ...violations.map((path) => `- ${path}`));
  }
  return [content.trim(), ...evidence].join("\n");
}

function selectTargets(message: StudioMessage, routePlan: RoutePlan): AgentId[] {
  const routeIds = routePlan.targets.map((target) => target.agentId);
  if (message.mentions.length > 0) {
    const mentionedRouteIds = routeIds.filter((agentId) => message.mentions.includes(agentId));
    return uniqueAgentIds(mentionedRouteIds.length > 0 ? mentionedRouteIds : message.mentions);
  }

  return uniqueAgentIds(routeIds.slice(0, 3));
}

function buildSystemPrompt(agent: AgentContract): string {
  const executableTools = executableToolsForAgent(agent);
  return [
    `你是 Be The Producer 游戏工作室里的 ${agent.displayName}。`,
    `你的角色职责：${agent.roleScope}`,
    `你的工作空间：${agent.workspace}`,
    "项目本地文件夹就是 Cocos Creator 项目根目录；所有资产、代码、文档、中间产物、构建和发布记录都必须使用相对该项目根目录的路径。",
    "Cocos 运行资产放在 assets/ 下，设计与技术文档放在 docs/，中间产物放在 intermediate/，可评审交付物放在 artifacts/，构建与发布输出放在 builds/、outputs/、release/。",
    "你必须以自己的角色身份回复制作人，不要冒充其他角色，不要声称已经完成没有实际完成的工具操作。",
    "除非系统消息明确给出服务端产物工具结果和 artifact ledger 证据，否则不要使用“已完成、已生成、已更新、已提交、已创建、已写入”等完成类表述。",
    "如果需要产出文件，不要只说“等待服务端工具执行”。必须在回复末尾附加一个 JSON 工具请求代码块，服务端只会执行这个结构化请求。",
    `你当前可执行的产物工具：${executableTools.join("、") || "无"}。不得虚构或调用未列出的工具。`,
    toolExecutionGuidance(executableTools),
    "工具请求格式：```json\n{\"toolRequests\":[{\"tool\":\"write_artifact\",\"path\":\"docs/design/example.md\",\"artifactType\":\"gdd\",\"content\":\"# 文档标题\\n正文\"}]}\n```",
    "写入型工具的 path 必须是项目根目录内的相对路径，content 必须是完整可写入内容。Cocos Bridge 工具使用各自声明的参数，不需要伪造 content。",
    "你可以先用自然语言说明计划，然后附加工具请求；工具请求成功后，系统会自动回填服务端执行结果和证据。",
    "硬约束：每个制作阶段在制作人明确发起门禁评审并发送二次确认口令前都保持开放。你不能宣布阶段结束、流程完成、进入下一阶段、批准发布或结束讨论。",
    "当信息看起来已经足够时，只能询问制作人是否继续讨论细节，或是否发起门禁评审；不能替制作人做结束决定。",
    "开局讨论必须根据制作人的具体 idea 提出定制澄清问题，不要复用固定四问。",
    "如果制作人 @ 你，要直接回答被问到的问题；如果问题超出职责，说明需要哪个角色接手。",
    "回复使用中文，保持具体、简洁、可执行。"
  ].join("\n");
}

function toolExecutionGuidance(tools: ReturnType<typeof executableToolsForAgent>): string {
  const guidance: string[] = [];
  if (tools.includes("generate_image")) {
    guidance.push("generate_image 生成可审计的 SVG 源资产：path 必须以 .svg 结尾，content 必须是完整且不含脚本的 SVG 文档；SVG 不能直接作为 Cocos 运行时交付物。");
  }
  if (tools.includes("render_svg_to_png")) {
    guidance.push("render_svg_to_png 把 SVG 源资产转换为 Cocos 可导入的透明 PNG：sourcePath 指向 .svg，path 指向同名 .png，可选 width；该工具不需要 content。每个 SVG 都必须生成对应 PNG 后才能请求评审。");
  }
  if (tools.includes("run_typecheck")) {
    guidance.push("run_typecheck 用于检查已写入的 .ts/.tsx 文件，必须放在对应 write_code 请求之后并传入同一路径；它不接受 content。");
  }
  if (tools.includes("cocos_validate_project")) {
    guidance.push("Cocos 自动化必须按 cocos_validate_project → cocos_import_assets → cocos_apply_blueprint → cocos_build 的顺序调用。前一步失败时立即报告真实阻塞，不得继续或声称完成。cocos_build 只有真实 Creator 进程成功且产生本轮新构建文件时才成立。");
  }
  if (tools.includes("run_playtest")) {
    guidance.push("run_playtest 不需要 path/content。它会真实构建 Cocos Web 包并用 Chrome 覆盖开始、运行、终局、动态数字、UI 重叠、重开和控制台错误；verdict=fail/blocked 时必须 handoff，禁止重复测试未修改的构建或手写通过报告。");
  }
  return guidance.join("\n") || "所有工具都由服务端执行并登记证据；没有成功结果就不能宣称产物成立。";
}

function buildUserPrompt(
  kernel: StudioKernel,
  producerMessage: StudioMessage,
  agent: AgentContract,
  routeReasons: string[],
  contextPrompt: string
): string {
  const room = kernel.listRooms().find((candidate) => candidate.roomId === producerMessage.roomId);
  const ownedTasks = kernel
    .listTasks()
    .filter((task) => task.ownerAgentId === agent.agentId)
    .slice(0, 6)
    .map((task) => `- ${task.title} [${task.status}, ${task.progressPercent ?? 0}%]${task.blockers.length ? ` 阻塞：${task.blockers.join("；")}` : ""}`)
    .join("\n");
  const ownedArtifacts = kernel
    .listArtifacts()
    .filter((artifact) => artifact.ownerAgentId === agent.agentId)
    .slice(0, 6)
    .map((artifact) => `- ${artifact.type} [${artifact.status}]`)
    .join("\n");

  return [
    contextPrompt,
    "",
    `项目：${kernel.project.name}`,
    `当前阶段：${kernel.project.currentStage}`,
    `当前房间：${room?.name ?? producerMessage.roomId}`,
    `路由原因：${routeReasons.join(", ") || "未记录"}`,
    "",
    `制作人最新消息：${producerMessage.content}`,
    "",
    `你的当前任务：\n${ownedTasks || "暂无"}`,
    "",
    `你的相关交付物：\n${ownedArtifacts || "暂无"}`,
    "",
    stageGateInstruction(kernel.project.currentStage),
    "",
    "请作为该 Agent 回复制作人。"
  ].join("\n");
}

function enforceProducerGateBoundary(
  kernel: StudioKernel,
  content: string
): { content: string; messageType?: MessageType; metadata: Record<string, unknown> } {
  if (!containsUnauthorizedStageClosure(content)) {
    return {
      content,
      metadata: {
        producerGateBoundary: "passed"
      }
    };
  }

  return {
    messageType: "decision_request",
    content: [
      `我不能宣布「${stageLabel(kernel.project.currentStage)}」结束，也不能直接推进到下一阶段。`,
      "当前阶段仍保持开放，制作人可以继续追问机制、世界观、美术、程序或测试细节。",
      "如果制作人确认本阶段讨论已经足够，请先发起对应门禁评审；阅读相关 Agent 风险提示后，再发送二次确认口令，系统才会推进阶段。"
    ].join("\n"),
    metadata: {
      producerGateBoundary: "blocked_stage_closure_claim"
    }
  };
}

function containsUnauthorizedStageClosure(content: string): boolean {
  const normalized = content.replace(/\s+/g, " ");
  const stageTerms = "(阶段|Stage\\s*\\d|立项|开发落地|首个可玩|发布|上线|本阶段|下一阶段|流程)";
  const closureTerms = "(结束|完成|通过|批准|审批|进入|转入|推进|关闭|交付)";
  const directStageClosure = new RegExp(`${stageTerms}.{0,24}${closureTerms}|${closureTerms}.{0,24}${stageTerms}`, "i");
  const transitionClaim = /(已|已经|现在|接下来).{0,16}(进入|转入|推进).{0,20}(开发|发布|上线|下一阶段)/i;
  return directStageClosure.test(normalized) || transitionClaim.test(normalized);
}

function stageGateInstruction(stageId: string): string {
  return [
    `阶段控制：当前阶段是 ${stageLabel(stageId)}。`,
    "该阶段没有制作人的门禁评审和二次确认口令前不能结束。",
    "如果你认为信息已足够，只能说“可以继续讨论，或请制作人发起门禁评审”，不能说阶段已完成。"
  ].join("\n");
}

function stageLabel(stageId: string): string {
  switch (stageId) {
    case "concept_discussion":
      return "立项讨论";
    case "concept_review":
      return "立项评审";
    case "production":
      return "开发落地";
    case "first_playable_review":
      return "首个可玩评审";
    case "release_preparation":
      return "发布准备";
    case "release_gate":
      return "发布门禁";
    case "production_deploy":
      return "生产部署";
    case "liveops":
      return "持续运营";
    default:
      return stageId;
  }
}

function createAgentMessage(
  kernel: StudioKernel,
  producerMessage: StudioMessage,
  agentId: AgentId,
  messageType: MessageType,
  content: string,
  metadata: Record<string, unknown>
): StudioMessage {
  const room = kernel.listRooms().find((candidate) => candidate.roomId === producerMessage.roomId) ?? kernel.getRoom("studio-main");
  return {
    messageId: `msg_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId: room.roomId,
    senderType: "agent",
    senderId: agentId,
    messageType,
    content,
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata,
    createdAt: new Date().toISOString()
  };
}

function inferMessageType(message: StudioMessage): MessageType {
  if (message.messageType === "review") {
    return "review";
  }
  if (message.messageType === "change_request") {
    return "progress_update";
  }
  return "progress_update";
}

function uniqueAgentIds(agentIds: string[]): AgentId[] {
  return [...new Set(agentIds)].filter((agentId) => defaultAgentContracts.some((agent) => agent.agentId === agentId));
}
