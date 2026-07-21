import { randomUUID } from "node:crypto";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type {
  AgentContract,
  AgentSessionRecord,
  ContextHealth,
  ContextPacket,
  ContextPacketLayer,
  MemoryPack,
  RoomContextCursor,
  SessionHandoffCapsule,
  StudioMessage,
  Task
} from "@game-pipeline/shared-schemas";

const defaultContextBudgetTokens = 64_000;
const charsPerTokenEstimate = 3.2;

export interface BuildContextPacketInput {
  session: AgentSessionRecord;
  agent: AgentContract;
  roomId: string;
  task?: Task;
  triggerMessageId?: string;
  budgetTokens?: number;
}

export interface BuiltContextPacket {
  packet: ContextPacket;
  prompt: string;
  incomingCapsuleIds: string[];
}

export function buildContextPacket(kernel: StudioKernel, input: BuildContextPacketInput): BuiltContextPacket {
  const now = new Date().toISOString();
  const budgetTokens = input.budgetTokens ?? defaultContextBudgetTokens;
  const room = kernel.listRooms().find((candidate) => candidate.roomId === input.roomId);
  const roomMessages = kernel.listMessages().filter((message) => message.roomId === input.roomId);
  const cursorBefore = normalizeCursor(input.session.cursor, input.roomId, now);
  const cursorIndex = cursorBefore.lastMessageId
    ? roomMessages.findIndex((message) => message.messageId === cursorBefore.lastMessageId)
    : -1;
  const staleCursor = Boolean(cursorBefore.lastMessageId && cursorIndex === -1);
  const deltaStart = staleCursor ? 0 : cursorIndex + 1;
  const deltaMessages = roomMessages.slice(deltaStart);
  const latestMessage = roomMessages.at(-1);
  const cursorAfter: RoomContextCursor = {
    roomId: input.roomId,
    ...(latestMessage ? { lastMessageId: latestMessage.messageId, lastMessageCreatedAt: latestMessage.createdAt } : {}),
    deliveredMessageCount: roomMessages.length,
    updatedAt: now
  };
  const memoryPack = kernel.memory.buildMemoryPack({
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    agentId: input.agent.agentId,
    tasks: kernel.listTasks(),
    artifacts: kernel.listArtifacts(),
    auditEvents: kernel.listAuditEvents()
  });
  const incomingCapsules = pendingCapsules(kernel, input.session);
  const layers: ContextPacketLayer[] = [];

  layers.push(layer("identity", "身份、项目与房间", [
    `项目：${kernel.project.name} (${kernel.project.projectId})`,
    `初始 idea：${kernel.project.initialIdea ?? "未记录"}`,
    `当前阶段：${kernel.project.currentStage}`,
    `当前房间：${room?.name ?? input.roomId} (${input.roomId})`,
    `角色：${input.agent.displayName} (${input.agent.agentId})`,
    `职责：${input.agent.roleScope}`,
    input.triggerMessageId ? `触发消息：${input.triggerMessageId}` : ""
  ].filter(Boolean).join("\n"), [kernel.project.projectId, input.roomId], false));

  const durableMemory = renderMemoryPack(memoryPack);
  layers.push(layer("durable_memory", "持久记忆与已确认事实", limitText(durableMemory, 10_000), memoryRefs(memoryPack), durableMemory.length > 10_000));

  if (input.task) {
    const taskState = renderTask(input.task);
    layers.push(layer("task_state", "当前任务", limitText(taskState, 8_000), [input.task.taskId], taskState.length > 8_000));
    const artifactEvidence = renderArtifactEvidence(kernel, input.task, input.agent.agentId);
    layers.push(layer("artifact_evidence", "产物与证据", limitText(artifactEvidence, 10_000), artifactRefs(input.task), artifactEvidence.length > 10_000));
  } else {
    const ownedState = renderOwnedWork(kernel, input.agent.agentId);
    layers.push(layer("task_state", "角色当前工作", limitText(ownedState, 8_000), [], ownedState.length > 8_000));
  }

  if (incomingCapsules.length > 0) {
    const capsuleText = incomingCapsules.map(renderCapsule).join("\n\n");
    layers.push(layer(
      "handoff_capsules",
      "跨会话交接胶囊",
      limitText(capsuleText, 10_000),
      incomingCapsules.map((capsule) => capsule.capsuleId),
      capsuleText.length > 10_000
    ));
  }

  const fixedChars = layers.reduce((total, current) => total + current.content.length, 0);
  const conversationBudget = Math.max(6_000, Math.floor(budgetTokens * charsPerTokenEstimate) - fixedChars);
  const roomLayer = renderRoomDelta(deltaMessages, conversationBudget);
  if (roomLayer.omitted.length > 0) {
    const digest = summarizeMessages(roomLayer.omitted);
    layers.push(layer(
      "room_digest",
      staleCursor ? "房间历史恢复摘要" : "本次游标区间压缩摘要",
      limitText(digest, 8_000),
      roomLayer.omitted.map((message) => message.messageId),
      digest.length > 8_000
    ));
  }
  layers.push(layer(
    "room_delta",
    `房间游标增量（${cursorBefore.lastMessageId ?? "起点"} → ${cursorAfter.lastMessageId ?? "空房间"}）`,
    roomLayer.content || "游标之后没有新消息。",
    roomLayer.included.map((message) => message.messageId),
    roomLayer.omitted.length > 0
  ));

  const estimatedTokens = estimateTokens(layers.map((item) => item.content).join("\n"));
  const projectedSessionTokens = input.session.contextTokensEstimate + estimatedTokens;
  const health = assessContextHealth({
    estimatedTokens: projectedSessionTokens,
    budgetTokens,
    deltaMessageCount: deltaMessages.length,
    omittedMessageCount: roomLayer.omitted.length,
    staleCursor,
    checkedAt: now
  });
  const packet: ContextPacket = {
    packetId: `ctx_${randomUUID()}`,
    projectId: kernel.project.projectId,
    sessionKey: input.session.sessionKey,
    agentId: input.agent.agentId,
    roomId: input.roomId,
    ...(input.task ? { taskId: input.task.taskId } : {}),
    cursorBefore,
    cursorAfter,
    layers,
    health,
    createdAt: now
  };
  return {
    packet,
    prompt: renderContextPacket(packet),
    incomingCapsuleIds: incomingCapsules.map((capsule) => capsule.capsuleId)
  };
}

export function renderContextPacket(packet: ContextPacket): string {
  const header = [
    `Context Packet：${packet.packetId}`,
    `Session：${packet.sessionKey}`,
    `Context Health：${packet.health.status} (${packet.health.score}/100)` ,
    `游标：${packet.cursorBefore.lastMessageId ?? "起点"} → ${packet.cursorAfter.lastMessageId ?? "空房间"}`
  ].join("\n");
  return [
    header,
    ...packet.layers.map((item) => `\n## ${item.title}\n${item.content}`),
    "\n## 上下文协议",
    "只使用本 Context Packet 与工具读取到的真实项目状态工作。房间增量由服务端游标维护；不要假设未出现的信息，也不要要求回退到固定条数的聊天历史。"
  ].join("\n");
}

function normalizeCursor(cursor: RoomContextCursor | undefined, roomId: string, now: string): RoomContextCursor {
  if (!cursor || cursor.roomId !== roomId) {
    return { roomId, deliveredMessageCount: 0, updatedAt: now };
  }
  return { ...cursor };
}

function pendingCapsules(kernel: StudioKernel, session: AgentSessionRecord): SessionHandoffCapsule[] {
  return kernel.listHandoffCapsules(session.sessionKey).filter(
    (capsule) => capsule.targetSessionKeys.includes(session.sessionKey) && !capsule.consumedBySessionKeys.includes(session.sessionKey)
  );
}

function renderMemoryPack(memory: MemoryPack): string {
  const decisions = memory.activeDecisions.map((record) => `- ${record.content}`).join("\n") || "无";
  const preferences = memory.producerPreferences.map((record) => `- ${record.content}`).join("\n") || "无";
  const blockers = memory.blockers.map((task) => `- ${task.title}: ${task.blockers.join("；")}`).join("\n") || "无";
  return [
    `项目摘要：${memory.projectBrief || "暂无持久摘要"}`,
    `阶段快照：${memory.stageSnapshot}`,
    `已确认决策：\n${decisions}`,
    `制作人偏好：\n${preferences}`,
    `角色工作记忆：${memory.roleWorkspaceSummary || "无"}`,
    `当前阻塞：\n${blockers}`
  ].join("\n\n");
}

function memoryRefs(memory: MemoryPack): string[] {
  return [
    ...memory.activeDecisions.map((record) => record.memoryId),
    ...memory.producerPreferences.map((record) => record.memoryId),
    ...memory.blockers.map((task) => task.taskId)
  ];
}

function renderTask(task: Task): string {
  return [
    `任务 ID：${task.taskId}`,
    `标题：${task.title}`,
    `说明：${task.description}`,
    `状态：${task.status}；进度：${task.progressPercent ?? 0}%`,
    `验收标准：${task.acceptanceCriteria.join("；") || "无"}`,
    `阻塞：${task.blockers.join("；") || "无"}`,
    `上游产物：${task.inputArtifacts.join("、") || "无"}`,
    `登记输出：${task.outputArtifacts.join("、") || "无"}`
  ].join("\n");
}

function renderArtifactEvidence(kernel: StudioKernel, task: Task, agentId: string): string {
  const relevant = new Set([...task.inputArtifacts, ...task.outputArtifacts]);
  const artifacts = kernel.listArtifacts().filter((artifact) => relevant.has(artifact.artifactId) || (artifact.ownerAgentId === agentId && artifact.sourceTaskId === task.taskId));
  const ledger = kernel.listArtifactLedger();
  if (artifacts.length === 0) return "没有登记或关联产物。";
  return artifacts.map((artifact) => {
    const evidence = ledger.find((entry) => entry.artifactId === artifact.artifactId);
    return `- ${artifact.artifactId}: ${artifact.path} [${artifact.status}; evidence=${evidence?.status ?? "missing"}${evidence?.hash ? `; hash=${evidence.hash.slice(0, 12)}` : ""}]`;
  }).join("\n");
}

function artifactRefs(task: Task): string[] {
  return [...new Set([...task.inputArtifacts, ...task.outputArtifacts])];
}

function renderOwnedWork(kernel: StudioKernel, agentId: string): string {
  const tasks = kernel.listTasks().filter((task) => task.ownerAgentId === agentId && !["done", "cancelled"].includes(task.status));
  const artifacts = kernel.listArtifacts().filter((artifact) => artifact.ownerAgentId === agentId && artifact.status !== "superseded");
  return [
    "开放任务：",
    ...(tasks.length > 0
      ? tasks.map((task) => `- ${task.taskId}: ${task.title} [${task.status}, ${task.progressPercent ?? 0}%]${task.blockers.length ? `；阻塞=${task.blockers.join("；")}` : ""}`)
      : ["- 无"]),
    "相关产物：",
    ...(artifacts.length > 0 ? artifacts.map((artifact) => `- ${artifact.artifactId}: ${artifact.path} [${artifact.status}]`) : ["- 无"])
  ].join("\n");
}

function renderRoomDelta(messages: StudioMessage[], budgetChars: number): { content: string; included: StudioMessage[]; omitted: StudioMessage[] } {
  const included: StudioMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const rendered = renderMessage(message);
    if (included.length > 0 && used + rendered.length > budgetChars) break;
    included.unshift(message);
    used += rendered.length;
  }
  const includedIds = new Set(included.map((message) => message.messageId));
  const omitted = messages.filter((message) => !includedIds.has(message.messageId));
  return { content: included.map(renderMessage).join("\n\n"), included, omitted };
}

function renderMessage(message: StudioMessage): string {
  const sender = message.senderType === "producer" ? "制作人" : message.senderId;
  const content = limitText(message.content.trim(), 2_400);
  const refs = [
    message.relatedTaskIds.length ? `tasks=${message.relatedTaskIds.join(",")}` : "",
    message.relatedArtifactIds.length ? `artifacts=${message.relatedArtifactIds.join(",")}` : ""
  ].filter(Boolean).join("; ");
  return `[${message.createdAt}] ${sender} · ${message.messageType} · ${message.messageId}${refs ? ` · ${refs}` : ""}\n${content}`;
}

function summarizeMessages(messages: StudioMessage[]): string {
  if (messages.length === 0) return "无。";
  const bySender = new Map<string, number>();
  const taskIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const message of messages) {
    const sender = message.senderType === "producer" ? "制作人" : message.senderId;
    bySender.set(sender, (bySender.get(sender) ?? 0) + 1);
    message.relatedTaskIds.forEach((id) => taskIds.add(id));
    message.relatedArtifactIds.forEach((id) => artifactIds.add(id));
  }
  const salientStatements = selectSalientStatements(messages, 6_000);
  return [
    `压缩消息范围：${messages[0]?.messageId} → ${messages.at(-1)?.messageId}，共 ${messages.length} 条。`,
    `参与者：${[...bySender.entries()].map(([sender, count]) => `${sender}(${count})`).join("、")}`,
    taskIds.size ? `涉及任务：${[...taskIds].join("、")}` : "",
    artifactIds.size ? `涉及产物：${[...artifactIds].join("、")}` : "",
    salientStatements.length ? `高价值原始消息摘录：\n${salientStatements.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function selectSalientStatements(messages: StudioMessage[], budgetChars: number): string[] {
  const selected: string[] = [];
  let used = 0;
  const candidates = messages.filter(
    (message) => message.senderType === "producer"
      || ["decision_record", "decision_request", "change_request", "review", "blocker", "handoff", "bug_report", "qa_failure"].includes(message.messageType)
  );
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (!message) continue;
    const sender = message.senderType === "producer" ? "制作人" : message.senderId;
    const statement = `- [${message.messageId}] ${sender}: ${limitText(message.content.replace(/\s+/g, " "), 360)}`;
    if (selected.length > 0 && used + statement.length > budgetChars) break;
    selected.unshift(statement);
    used += statement.length;
  }
  return selected;
}

function renderCapsule(capsule: SessionHandoffCapsule): string {
  return [
    `### ${capsule.capsuleId} · ${capsule.kind}`,
    `来源：${capsule.sourceSessionKey} (${capsule.sourceAgentId})`,
    capsule.taskId ? `任务：${capsule.taskId}` : "",
    capsule.changedPaths.length ? `变更路径：${capsule.changedPaths.join("、")}` : "",
    capsule.artifactIds.length ? `产物：${capsule.artifactIds.join("、")}` : "",
    capsule.summary
  ].filter(Boolean).join("\n");
}

function assessContextHealth(input: {
  estimatedTokens: number;
  budgetTokens: number;
  deltaMessageCount: number;
  omittedMessageCount: number;
  staleCursor: boolean;
  checkedAt: string;
}): ContextHealth {
  const ratio = input.estimatedTokens / Math.max(1, input.budgetTokens);
  const reasons: string[] = [];
  let status: ContextHealth["status"] = "healthy";
  if (input.staleCursor) {
    status = "stale";
    reasons.push("持久化游标指向的消息已不存在，已通过房间摘要重建上下文。");
  } else if (ratio >= 1) {
    status = "oversized";
    reasons.push("会话累计上下文估算已达到预算，需要 seal 并创建后继会话。");
  } else if (ratio >= 0.78 || input.omittedMessageCount > 0) {
    status = "degraded";
    reasons.push(input.omittedMessageCount > 0 ? "本次消息增量已压缩为摘要。" : "会话累计上下文接近预算。");
  }
  if (reasons.length === 0) reasons.push("游标连续，分层上下文处于预算内。");
  return {
    status,
    score: Math.max(0, Math.min(100, Math.round(100 - ratio * 70 - (input.staleCursor ? 25 : 0) - Math.min(20, input.omittedMessageCount)))),
    estimatedTokens: input.estimatedTokens,
    budgetTokens: input.budgetTokens,
    deltaMessageCount: input.deltaMessageCount,
    omittedMessageCount: input.omittedMessageCount,
    staleCursor: input.staleCursor,
    reasons,
    checkedAt: input.checkedAt
  };
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / charsPerTokenEstimate);
}

function layer(kind: ContextPacketLayer["kind"], title: string, content: string, sourceRefs: string[], truncated: boolean): ContextPacketLayer {
  return { kind, title, content: content || "无", sourceRefs, truncated };
}

function limitText(content: string, limit: number): string {
  return content.length <= limit ? content : `${content.slice(0, limit)}\n…（已按 Context Packet 预算截断）`;
}
