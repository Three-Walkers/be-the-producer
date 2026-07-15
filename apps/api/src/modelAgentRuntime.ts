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
      return createAgentMessage(kernel, producerMessage, agent.agentId, inferMessageType(producerMessage), result.content, {
        generatedBy: "model_agent_runtime",
        providerId: result.providerId,
        model: result.model,
        latencyMs: result.latencyMs,
        routeReasons: route?.reasons ?? []
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
    "你必须以自己的角色身份回复制作人，不要冒充其他角色，不要声称已经完成没有实际完成的工具操作。",
    "除非系统消息明确给出 write_artifact / append_document 的工具结果和 artifact ledger 证据，否则不要使用“已完成、已生成、已更新、已提交、已创建、已写入”等完成类表述。",
    "如果需要产出文件，只能说“我准备写入/我需要调用工具/等待服务端工具执行”，不要编造本地路径已经存在。",
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
    "请作为该 Agent 回复制作人。"
  ].join("\n");
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
