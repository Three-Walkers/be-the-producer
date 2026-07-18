import { defaultAgentContracts, type RoutePlan, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentContract, AgentId, MessageType, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import { generateModelChat } from "./modelClient.js";
import { modelSettingsStore } from "./modelSettings.js";
import { executableToolsForAgent, type ToolExecutionResult } from "./toolExecutor.js";
import { claudeCliHarness } from "./claudeCliHarness.js";
import { allowedRootsForAgent, attachHarnessEvidenceToMessage, captureWorkspaceSnapshot, recordHarnessWorkspaceChanges } from "./harnessWorkspaceEvidence.js";
import { readArtifactContentForModel, resolveProjectWorkspaceRoot, syncProjectWorkspace } from "./workspaceWriter.js";

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
    if (assignment.harnessId === "claude-cli") {
      return this.respondToTaskWithClaudeHarness(kernel, task, agent, room.roomId, provider, model, input);
    }
    try {
      const result = await generateModelChat(provider, {
        model,
        systemPrompt: buildSystemPrompt(agent),
        userPrompt: buildTaskLoopPrompt(kernel, task, agent, input),
        maxTokens: 3000,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      const guarded = enforceProducerGateBoundary(kernel, result.content);
      return {
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
          ...guarded.metadata
        },
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        messageId: `msg_${agent.agentId}_loop_error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        projectId: kernel.project.projectId,
        roomId: room.roomId,
        senderType: "agent",
        senderId: agent.agentId,
        messageType: "blocker",
        content: `任务「${task.title}」的模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        mentions: [],
        relatedTaskIds: [task.taskId],
        relatedArtifactIds: [],
        metadata: {
          generatedBy: "agent_loop",
          providerId: provider.providerId,
          model,
          loopIteration: input.iteration,
          loopTaskId: task.taskId,
          failure: true
        },
        createdAt: new Date().toISOString()
      };
    }
  }

  private async respondToTaskWithClaudeHarness(
    kernel: StudioKernel,
    task: Task,
    agent: AgentContract,
    roomId: string,
    provider: ReturnType<typeof modelSettingsStore.getProviderConfig>,
    model: string,
    input: AgentTaskRunInput
  ): Promise<StudioMessage> {
    const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
    syncProjectWorkspace(kernel);
    const before = captureWorkspaceSnapshot(projectRoot);
    const previousAgentState = kernel.getAgentLoopState().agents[agent.agentId];
    try {
      const result = await claudeCliHarness.run({
        projectId: kernel.project.projectId,
        projectRoot,
        agent,
        provider,
        model,
        systemPrompt: buildClaudeHarnessSystemPrompt(agent),
        userPrompt: buildClaudeHarnessTaskPrompt(kernel, task, agent, input),
        allowedRoots: allowedRootsForAgent(agent),
        expectedPaths: task.outputArtifacts
          .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId)?.path)
          .filter((path): path is string => Boolean(path)),
        ...(previousAgentState?.sessionId ? { sessionId: previousAgentState.sessionId } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      const after = captureWorkspaceSnapshot(projectRoot);
      const evidence = recordHarnessWorkspaceChanges(kernel, task, agent, before, after, result.invocationId, result.changedPaths);
      const outputsVerified = areTaskOutputsVerified(kernel, task);
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
            : reportedControl
              ? reportedControl
          : {
              status: "continue" as const,
              reason: evidence.changedPaths.length > 0 ? "本轮已有文件进展，继续完成尚未验证的任务输出。" : "本轮未形成新的文件证据，继续执行任务。",
              handoffAgentIds: []
            };
      const guarded = enforceProducerGateBoundary(kernel, result.content);
      const message: StudioMessage = {
        messageId: `msg_${agent.agentId}_harness_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        projectId: kernel.project.projectId,
        roomId,
        senderType: "agent",
        senderId: agent.agentId,
        messageType: guarded.messageType ?? "progress_update",
        content: renderHarnessResult(guarded.content, evidence.changedPaths, evidence.violations),
        mentions: [],
        relatedTaskIds: [task.taskId],
        relatedArtifactIds: [],
        metadata: {
          generatedBy: "claude_cli_harness",
          harnessId: result.harnessId,
          harnessInvocationId: result.invocationId,
          harnessSessionId: result.sessionId,
          providerId: result.providerId,
          model: result.model,
          latencyMs: result.latencyMs,
          rawEventCount: result.rawEventCount,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        messageId: `msg_${agent.agentId}_harness_error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        projectId: kernel.project.projectId,
        roomId,
        senderType: "agent",
        senderId: agent.agentId,
        messageType: "blocker",
        content: `任务「${task.title}」的 Claude CLI Harness 执行失败：${errorMessage}`,
        mentions: [],
        relatedTaskIds: [task.taskId],
        relatedArtifactIds: [],
        metadata: {
          generatedBy: "claude_cli_harness",
          harnessId: "claude-cli",
          providerId: provider.providerId,
          model,
          loopIteration: input.iteration,
          loopTaskId: task.taskId,
          failure: true
        },
        createdAt: new Date().toISOString()
      };
    }
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
    try {
      const result = await generateModelChat(provider, {
        model,
        systemPrompt: buildSystemPrompt(agent),
        userPrompt: buildUserPrompt(kernel, producerMessage, agent, route?.reasons ?? []),
        maxTokens: 1800
      });
      const guarded = enforceProducerGateBoundary(kernel, result.content);
      return createAgentMessage(kernel, producerMessage, agent.agentId, guarded.messageType ?? inferMessageType(producerMessage), guarded.content, {
        generatedBy: "model_agent_runtime",
        providerId: result.providerId,
        model: result.model,
        latencyMs: result.latencyMs,
        routeReasons: route?.reasons ?? [],
        ...guarded.metadata
      });
    } catch (error) {
      return createAgentMessage(
        kernel,
        producerMessage,
        agent.agentId,
        "blocker",
        `我被路由到这条消息，但模型回复失败：${error instanceof Error ? error.message : String(error)} 请在设置里检查该角色的 provider、模型名和连通性测试。`,
        {
          generatedBy: "model_agent_runtime",
          providerId: provider.providerId,
          model,
          routeReasons: route?.reasons ?? [],
          failure: true
        }
      );
    }
  }
}

function buildTaskLoopPrompt(kernel: StudioKernel, task: Task, agent: AgentContract, input: AgentTaskRunInput): string {
  const recentMessages = kernel
    .listMessages()
    .slice(-12)
    .map((message) => `${message.senderType === "producer" ? "制作人" : message.senderId}: ${message.content}`)
    .join("\n");
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
    "最近协作消息：",
    recentMessages || "暂无",
    "",
    `你当前真正可调用的服务端工具：${tools.join("、") || "无"}。只能调用这里列出的工具。`,
    toolExecutionGuidance(tools),
    "产出文件时必须在本轮直接提交工具请求，不能说稍后执行或等待服务端代替你执行。",
    "写入型工具请求必须包含 tool、path、content；已登记输出还必须填写 artifactId 和 taskId。run_typecheck 只需要 tool 和 path。",
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
  return [
    `你是 Be The Producer 游戏工作室里的 ${agent.displayName}。`,
    `职责：${agent.roleScope}`,
    `角色主工作区：${agent.workspace}`,
    "当前工作目录是该游戏项目的 Cocos Creator 项目根目录。你可以读取项目，并通过 btp_workspace MCP 工具创建、替换、追加和枚举角色获准路径中的文件。",
    "创建或替换文件必须调用 mcp__btp_workspace__write_artifact，追加文档调用 mcp__btp_workspace__append_document。必须实际调用工具，不能声称等待服务端代写，也不能只在回复中给出一个虚构路径。",
    "不要修改 .be-the-producer、shared/task-board、shared/tasks、shared/chat、shared/memory、shared/artifacts、shared/claims、shared/audit 下由调度器维护的状态文件。",
    "不要访问项目根目录之外的路径，不要读取或回显 API key、环境变量和本机凭据。",
    "不要提交 git，不要部署生产环境，不要执行破坏性命令；这些动作需要制作人门禁和专用工具。",
    "阶段必须保持开放，除非制作人完成门禁评审和二次确认。你不能宣布阶段结束、批准发布或擅自进入下一阶段。",
    "结束本轮前必须调用 mcp__btp_workspace__report_task_status 上报 continue、waiting_for_producer、handoff、ready_for_review 或 blocked，并用中文简要说明实际检查了什么、实际改了哪些文件、仍有哪些问题。完成声明必须与真实文件一致。"
  ].join("\n");
}

function buildClaudeHarnessTaskPrompt(kernel: StudioKernel, task: Task, agent: AgentContract, input: AgentTaskRunInput): string {
  const recentMessages = kernel
    .listMessages()
    .slice(-16)
    .map((message) => `${message.senderType === "producer" ? "制作人" : message.senderId}: ${message.content}`)
    .join("\n");
  const expectedOutputs = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact) => artifact !== undefined)
    .map((artifact) => `- ${artifact.artifactId}: ${artifact.path} (${artifact.type})`)
    .join("\n");
  const verifiedInputs = task.inputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact) => artifact !== undefined)
    .map((artifact) => `- ${artifact.path}`)
    .join("\n");
  return [
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
    "",
    "已验证的上游文件：",
    verifiedInputs || "无",
    "",
    "最近协作消息：",
    recentMessages || "暂无",
    "",
    `请现在持续完成该任务，直接使用工具检查和修改项目。优先写入 ${agent.workspace} 或上述登记输出路径。`,
    "不要输出 JSON 工具协议；直接调用 btp_workspace MCP 工具。没有实际文件变化时，不得说已完成。",
    "本轮结束前必须调用 report_task_status。能继续推进就填 continue；只有确实需要制作人决定时填 waiting_for_producer；需要其他角色接棒时填 handoff；真实依赖缺失时填 blocked。ready_for_review 仍必须由 Artifact Ledger 证据通过后才生效。",
    stageGateInstruction(kernel.project.currentStage)
  ].join("\n");
}

function areTaskOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  if (task.outputArtifacts.length === 0) {
    return false;
  }
  return task.outputArtifacts.every((artifactId) => {
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
    return Boolean(artifact?.metadata.toolExecutedAt && ledger?.status === "verified");
  });
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
    "不同工具使用同样的请求字段。path 必须是项目根目录内的相对路径，content 必须是完整可写入内容。",
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
    guidance.push("generate_image 当前生成可审计的 SVG 游戏资产：path 必须以 .svg 结尾，content 必须是完整且不含脚本的 SVG 文档。");
  }
  if (tools.includes("run_typecheck")) {
    guidance.push("run_typecheck 用于检查已写入的 .ts/.tsx 文件，必须放在对应 write_code 请求之后并传入同一路径；它不接受 content。");
  }
  return guidance.join("\n") || "所有工具都由服务端执行并登记证据；没有成功结果就不能宣称产物成立。";
}

function buildUserPrompt(kernel: StudioKernel, producerMessage: StudioMessage, agent: AgentContract, routeReasons: string[]): string {
  const room = kernel.listRooms().find((candidate) => candidate.roomId === producerMessage.roomId);
  const recentMessages = kernel
    .listMessages()
    .slice(-8)
    .map((message) => `${message.senderType === "producer" ? "制作人" : message.senderId}: ${message.content}`)
    .join("\n");
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
    `项目：${kernel.project.name}`,
    `当前阶段：${kernel.project.currentStage}`,
    `当前房间：${room?.name ?? producerMessage.roomId}`,
    `路由原因：${routeReasons.join(", ") || "未记录"}`,
    "",
    `制作人最新消息：${producerMessage.content}`,
    "",
    "最近对话：",
    recentMessages || "暂无",
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
