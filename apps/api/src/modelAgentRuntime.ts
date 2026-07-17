import { defaultAgentContracts, type RoutePlan, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentContract, AgentId, MessageType, StudioMessage } from "@game-pipeline/shared-schemas";
import { generateModelChat } from "./modelClient.js";
import { modelSettingsStore } from "./modelSettings.js";

export interface ModelAgentRunResult {
  agentMessages: StudioMessage[];
}

export class ModelAgentRuntime {
  async respond(kernel: StudioKernel, producerMessage: StudioMessage, routePlan: RoutePlan): Promise<ModelAgentRunResult> {
    const targets = selectTargets(producerMessage, routePlan);
    const agentMessages: StudioMessage[] = [];
    for (const agentId of targets) {
      const agent = defaultAgentContracts.find((candidate) => candidate.agentId === agentId);
      if (!agent) {
        continue;
      }

      const message = await this.respondAsAgent(kernel, producerMessage, agent, routePlan);
      kernel.recordMessage(message);
      agentMessages.push(message);
    }

    return { agentMessages };
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
        maxTokens: 700
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

function selectTargets(message: StudioMessage, routePlan: RoutePlan): AgentId[] {
  const routeIds = routePlan.targets.map((target) => target.agentId);
  if (message.mentions.length > 0) {
    const mentionedRouteIds = routeIds.filter((agentId) => message.mentions.includes(agentId));
    return uniqueAgentIds(mentionedRouteIds.length > 0 ? mentionedRouteIds : message.mentions);
  }

  return uniqueAgentIds(routeIds.slice(0, 3));
}

function buildSystemPrompt(agent: AgentContract): string {
  return [
    `你是 Be The Producer 游戏工作室里的 ${agent.displayName}。`,
    `你的角色职责：${agent.roleScope}`,
    `你的工作空间：${agent.workspace}`,
    "项目本地文件夹就是 Cocos Creator 项目根目录；所有资产、代码、文档、中间产物、构建和发布记录都必须使用相对该项目根目录的路径。",
    "Cocos 运行资产放在 assets/ 下，设计与技术文档放在 docs/，中间产物放在 intermediate/，可评审交付物放在 artifacts/，构建与发布输出放在 builds/、outputs/、release/。",
    "你必须以自己的角色身份回复制作人，不要冒充其他角色，不要声称已经完成没有实际完成的工具操作。",
    "除非系统消息明确给出 write_artifact / append_document 的工具结果和 artifact ledger 证据，否则不要使用“已完成、已生成、已更新、已提交、已创建、已写入”等完成类表述。",
    "如果需要产出文件，只能说“我准备写入/我需要调用工具/等待服务端工具执行”，不要编造本地路径已经存在。",
    "硬约束：每个制作阶段在制作人明确发起门禁评审并发送二次确认口令前都保持开放。你不能宣布阶段结束、流程完成、进入下一阶段、批准发布或结束讨论。",
    "当信息看起来已经足够时，只能询问制作人是否继续讨论细节，或是否发起门禁评审；不能替制作人做结束决定。",
    "开局讨论必须根据制作人的具体 idea 提出定制澄清问题，不要复用固定四问。",
    "如果制作人 @ 你，要直接回答被问到的问题；如果问题超出职责，说明需要哪个角色接手。",
    "回复使用中文，保持具体、简洁、可执行。"
  ].join("\n");
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
