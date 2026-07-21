import { randomUUID } from "node:crypto";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type {
  AgentContract,
  AgentHarnessId,
  AgentSessionRecord,
  ContextPacket,
  HandoffCapsuleKind,
  SessionHandoffCapsule,
  StudioMessage,
  Task
} from "@game-pipeline/shared-schemas";
import { buildContextPacket, type BuiltContextPacket } from "./contextPacket.js";

interface SessionIdentity {
  providerId: string;
  model: string;
  harnessId: AgentHarnessId;
}

interface CapsuleInput {
  kind: HandoffCapsuleKind;
  summary: string;
  messageIds?: string[];
  artifactIds?: string[];
  changedPaths?: string[];
  taskId?: string;
  targetAgentIds?: string[];
}

class SessionMutex {
  private readonly entries = new Map<string, { locked: boolean; waiters: Array<() => void> }>();

  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await work();
    } finally {
      this.release(key);
    }
  }

  isLocked(key: string): boolean {
    return this.entries.get(key)?.locked ?? false;
  }

  private acquire(key: string): Promise<void> {
    const entry = this.entries.get(key) ?? { locked: false, waiters: [] };
    this.entries.set(key, entry);
    if (!entry.locked) {
      entry.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const next = entry.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.entries.delete(key);
  }
}

export class SessionCoordinator {
  private readonly mutex = new SessionMutex();

  getOrCreateRoomSession(
    kernel: StudioKernel,
    agent: AgentContract,
    roomId: string,
    identity: SessionIdentity
  ): AgentSessionRecord {
    const logicalSessionKey = roomLogicalKey(kernel.project.projectId, roomId, agent.agentId);
    return this.getOrCreateSession(kernel, {
      logicalSessionKey,
      agent,
      roomId,
      scope: "room",
      identity
    });
  }

  getOrCreateTaskChildSession(
    kernel: StudioKernel,
    task: Task,
    agent: AgentContract,
    roomId: string,
    identity: SessionIdentity
  ): AgentSessionRecord {
    const parent = this.getOrCreateRoomSession(kernel, agent, roomId, identity);
    const logicalSessionKey = taskLogicalKey(kernel.project.projectId, roomId, task.taskId, agent.agentId);
    const previous = kernel.findActiveAgentSession(logicalSessionKey);
    const child = this.getOrCreateSession(kernel, {
      logicalSessionKey,
      agent,
      roomId,
      task,
      parentSessionKey: parent.sessionKey,
      scope: "task_child",
      identity
    });
    if (previous?.sessionKey === child.sessionKey) return child;
    this.createCapsule(kernel, parent, [child], {
      kind: "parent_to_child",
      taskId: task.taskId,
      summary: [
        `房间会话把任务「${task.title}」交给独立 child session。`,
        `当前阶段：${kernel.project.currentStage}。`,
        `验收标准：${task.acceptanceCriteria.join("；") || "无"}。`,
        `父会话游标：${parent.cursor.lastMessageId ?? "起点"}。`
      ].join("\n"),
      artifactIds: [...task.inputArtifacts, ...task.outputArtifacts]
    });
    return kernel.findAgentSession(child.sessionKey) ?? child;
  }

  async runExclusive<T>(kernel: StudioKernel, session: AgentSessionRecord, work: (current: AgentSessionRecord) => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(session.logicalSessionKey, async () => {
      const current = kernel.findActiveAgentSession(session.logicalSessionKey) ?? session;
      return work(current);
    });
  }

  isLocked(session: AgentSessionRecord): boolean {
    return this.mutex.isLocked(session.logicalSessionKey);
  }

  prepareContext(
    kernel: StudioKernel,
    session: AgentSessionRecord,
    agent: AgentContract,
    roomId: string,
    task?: Task,
    triggerMessageId?: string
  ): { session: AgentSessionRecord; context: BuiltContextPacket } {
    let current = kernel.findActiveAgentSession(session.logicalSessionKey) ?? session;
    let context = buildContextPacket(kernel, {
      session: current,
      agent,
      roomId,
      ...(task ? { task } : {}),
      ...(triggerMessageId ? { triggerMessageId } : {})
    });
    const hasCommittedContext = Boolean(
      current.sessionId
      || current.contextTokensEstimate > 0
      || current.cursor.deliveredMessageCount > 0
    );
    if ((context.packet.health.status === "stale" || (hasCommittedContext && context.packet.health.status === "oversized"))) {
      current = this.rotateSession(kernel, current, `Context Health=${context.packet.health.status}：${context.packet.health.reasons.join("；")}`, "resume_recovery");
      context = buildContextPacket(kernel, {
        session: current,
        agent,
        roomId,
        ...(task ? { task } : {}),
        ...(triggerMessageId ? { triggerMessageId } : {})
      });
    }
    kernel.recordContextPacket(context.packet);
    kernel.upsertAgentSession({
      ...current,
      contextHealth: context.packet.health,
      lastContextPacketId: context.packet.packetId,
      updatedAt: new Date().toISOString()
    });
    return { session: kernel.findAgentSession(current.sessionKey) ?? current, context };
  }

  commitSuccess(
    kernel: StudioKernel,
    session: AgentSessionRecord,
    packet: ContextPacket,
    input: { sessionId?: string; invocationId?: string; outputText?: string }
  ): AgentSessionRecord {
    const now = new Date().toISOString();
    const latest = kernel.findAgentSession(session.sessionKey) ?? session;
    const next: AgentSessionRecord = {
      ...latest,
      status: "active",
      cursor: packet.cursorAfter,
      contextHealth: packet.health,
      contextTokensEstimate: packet.health.estimatedTokens + estimateTokens(input.outputText ?? ""),
      lastContextPacketId: packet.packetId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.invocationId ? { lastInvocationId: input.invocationId } : {}),
      lastSuccessfulAt: now,
      updatedAt: now
    };
    kernel.upsertAgentSession(next);
    const deliveredCapsuleIds = packet.layers
      .filter((layer) => layer.kind === "handoff_capsules")
      .flatMap((layer) => layer.sourceRefs);
    kernel.consumeHandoffCapsules(session.sessionKey, deliveredCapsuleIds);
    return kernel.findAgentSession(session.sessionKey) ?? next;
  }

  recoverResumeFailure(kernel: StudioKernel, session: AgentSessionRecord, reason: string): AgentSessionRecord {
    const now = new Date().toISOString();
    kernel.upsertAgentSession({
      ...session,
      status: "recovering",
      resumeFailureCount: session.resumeFailureCount + 1,
      updatedAt: now
    });
    const recovering = kernel.findAgentSession(session.sessionKey) ?? session;
    return this.rotateSession(kernel, recovering, `Claude CLI --resume 失败，自动创建后继会话：${reason}`, "resume_recovery");
  }

  markFailed(kernel: StudioKernel, session: AgentSessionRecord, reason: string): void {
    const latest = kernel.findAgentSession(session.sessionKey) ?? session;
    kernel.upsertAgentSession({
      ...latest,
      status: "failed",
      sealReason: reason,
      updatedAt: new Date().toISOString()
    });
  }

  returnChildToParent(
    kernel: StudioKernel,
    child: AgentSessionRecord,
    input: { summary: string; message?: StudioMessage; changedPaths?: string[]; artifactIds?: string[] }
  ): SessionHandoffCapsule | undefined {
    if (child.scope !== "task_child" || !child.parentSessionKey) return undefined;
    const source = kernel.findAgentSession(child.sessionKey) ?? child;
    const recordedParent = kernel.findAgentSession(child.parentSessionKey);
    const parent = recordedParent
      ? kernel.findActiveAgentSession(recordedParent.logicalSessionKey) ?? recordedParent
      : undefined;
    if (!parent) return undefined;
    return this.createCapsule(kernel, source, [parent], {
      kind: "child_to_parent",
      ...(child.taskId ? { taskId: child.taskId } : {}),
      summary: input.summary,
      messageIds: input.message ? [input.message.messageId] : [],
      artifactIds: input.artifactIds ?? [],
      changedPaths: input.changedPaths ?? []
    });
  }

  handoffToAgents(
    kernel: StudioKernel,
    source: AgentSessionRecord,
    targetAgents: AgentContract[],
    identityFor: (agent: AgentContract) => SessionIdentity,
    input: { summary: string; message?: StudioMessage; changedPaths?: string[]; artifactIds?: string[] }
  ): SessionHandoffCapsule | undefined {
    const currentSource = kernel.findAgentSession(source.sessionKey) ?? source;
    const sourceRoom = kernel.listRooms().find((room) => room.roomId === currentSource.roomId);
    const targets = targetAgents.map((target) => {
      const roomKind = sourceRoom && target.roomMemberships.includes(sourceRoom.kind)
        ? sourceRoom.kind
        : target.roomMemberships[0] ?? "studio-main";
      return this.getOrCreateRoomSession(kernel, target, kernel.getRoom(roomKind).roomId, identityFor(target));
    });
    if (targets.length === 0) return undefined;
    return this.createCapsule(kernel, currentSource, targets, {
      kind: "agent_handoff",
      ...(source.taskId ? { taskId: source.taskId } : {}),
      summary: input.summary,
      messageIds: input.message ? [input.message.messageId] : [],
      artifactIds: input.artifactIds ?? [],
      changedPaths: input.changedPaths ?? [],
      targetAgentIds: targetAgents.map((target) => target.agentId)
    });
  }

  sealCompletedChild(kernel: StudioKernel, session: AgentSessionRecord, reason: string): void {
    const latest = kernel.findAgentSession(session.sessionKey) ?? session;
    if (latest.scope !== "task_child" || latest.status === "sealed") return;
    kernel.upsertAgentSession({
      ...latest,
      status: "sealed",
      sealReason: reason,
      sealedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  private getOrCreateSession(
    kernel: StudioKernel,
    input: {
      logicalSessionKey: string;
      agent: AgentContract;
      roomId: string;
      task?: Task;
      parentSessionKey?: string;
      scope: AgentSessionRecord["scope"];
      identity: SessionIdentity;
    }
  ): AgentSessionRecord {
    const existing = kernel.findActiveAgentSession(input.logicalSessionKey);
    if (existing) {
      if (sameIdentity(existing, input.identity)) return existing;
      return this.rotateSession(
        kernel,
        existing,
        `执行身份变化：${existing.harnessId}/${existing.providerId}/${existing.model} → ${input.identity.harnessId}/${input.identity.providerId}/${input.identity.model}`,
        "resume_recovery",
        input.identity
      );
    }
    const now = new Date().toISOString();
    const previous = kernel.listAgentSessions()
      .filter((candidate) => candidate.logicalSessionKey === input.logicalSessionKey)
      .sort((left, right) => right.epoch - left.epoch)[0];
    const epoch = previous ? previous.epoch + 1 : 0;
    const session: AgentSessionRecord = {
      sessionKey: `${input.logicalSessionKey}:e${epoch}`,
      logicalSessionKey: input.logicalSessionKey,
      projectId: kernel.project.projectId,
      agentId: input.agent.agentId,
      roomId: input.roomId,
      ...(input.task ? { taskId: input.task.taskId } : {}),
      scope: input.scope,
      ...(input.parentSessionKey ? { parentSessionKey: input.parentSessionKey } : {}),
      ...(previous ? { predecessorSessionKey: previous.sessionKey } : {}),
      harnessId: input.identity.harnessId,
      providerId: input.identity.providerId,
      model: input.identity.model,
      epoch,
      status: "active",
      cursor: { roomId: input.roomId, deliveredMessageCount: 0, updatedAt: now },
      contextTokensEstimate: 0,
      resumeFailureCount: 0,
      incomingCapsuleIds: [],
      outgoingCapsuleIds: [],
      createdAt: now,
      updatedAt: now
    };
    return kernel.upsertAgentSession(session);
  }

  private rotateSession(
    kernel: StudioKernel,
    session: AgentSessionRecord,
    reason: string,
    capsuleKind: HandoffCapsuleKind,
    identity: SessionIdentity = session
  ): AgentSessionRecord {
    const now = new Date().toISOString();
    const sealed = kernel.upsertAgentSession({
      ...session,
      status: "sealed",
      sealReason: reason,
      sealedAt: now,
      updatedAt: now
    });
    const pendingCapsuleSummary = kernel
      .listHandoffCapsules(session.sessionKey)
      .filter((capsule) => !capsule.consumedBySessionKeys.includes(session.sessionKey))
      .map((capsule) => `${capsule.kind}: ${capsule.summary}`)
      .join("\n");
    const successor: AgentSessionRecord = {
      sessionKey: `${session.logicalSessionKey}:e${session.epoch + 1}`,
      logicalSessionKey: session.logicalSessionKey,
      projectId: session.projectId,
      agentId: session.agentId,
      roomId: session.roomId,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      scope: session.scope,
      ...(session.parentSessionKey ? { parentSessionKey: session.parentSessionKey } : {}),
      predecessorSessionKey: session.sessionKey,
      harnessId: identity.harnessId,
      providerId: identity.providerId,
      model: identity.model,
      epoch: session.epoch + 1,
      status: "active",
      cursor: { ...session.cursor, updatedAt: now },
      contextTokensEstimate: 0,
      resumeFailureCount: session.resumeFailureCount,
      incomingCapsuleIds: [],
      outgoingCapsuleIds: [],
      createdAt: now,
      updatedAt: now
    };
    kernel.upsertAgentSession(successor);
    this.createCapsule(kernel, sealed, [successor], {
      kind: capsuleKind,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      summary: [
        `前一会话已 seal：${reason}`,
        `最后游标：${session.cursor.lastMessageId ?? "起点"}。`,
        `累计上下文估算：${session.contextTokensEstimate} tokens。`,
        pendingCapsuleSummary ? `尚未消费的交接内容：\n${pendingCapsuleSummary}` : "没有尚未消费的交接内容。",
        `后继会话必须从持久状态、房间游标和工具证据恢复，不得依赖旧进程内存。`
      ].join("\n")
    });
    return kernel.findAgentSession(successor.sessionKey) ?? successor;
  }

  private createCapsule(
    kernel: StudioKernel,
    source: AgentSessionRecord,
    targets: AgentSessionRecord[],
    input: CapsuleInput
  ): SessionHandoffCapsule {
    const currentSource = kernel.findAgentSession(source.sessionKey) ?? source;
    const currentTargets = targets.map((target) => kernel.findAgentSession(target.sessionKey) ?? target);
    const capsule: SessionHandoffCapsule = {
      capsuleId: `capsule_${randomUUID()}`,
      projectId: kernel.project.projectId,
      kind: input.kind,
      sourceSessionKey: currentSource.sessionKey,
      targetSessionKeys: currentTargets.map((target) => target.sessionKey),
      sourceAgentId: currentSource.agentId,
      targetAgentIds: input.targetAgentIds ?? [...new Set(currentTargets.map((target) => target.agentId))],
      roomId: currentSource.roomId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      summary: input.summary,
      messageIds: input.messageIds ?? [],
      artifactIds: input.artifactIds ?? [],
      changedPaths: input.changedPaths ?? [],
      ...(currentSource.contextHealth ? { contextHealth: currentSource.contextHealth } : {}),
      consumedBySessionKeys: [],
      createdAt: new Date().toISOString()
    };
    kernel.recordHandoffCapsule(capsule);
    kernel.upsertAgentSession({
      ...currentSource,
      outgoingCapsuleIds: [...new Set([...currentSource.outgoingCapsuleIds, capsule.capsuleId])],
      updatedAt: new Date().toISOString()
    });
    for (const target of currentTargets) {
      const latestTarget = kernel.findAgentSession(target.sessionKey) ?? target;
      kernel.upsertAgentSession({
        ...latestTarget,
        incomingCapsuleIds: [...new Set([...latestTarget.incomingCapsuleIds, capsule.capsuleId])],
        updatedAt: new Date().toISOString()
      });
    }
    return capsule;
  }
}

export const sessionCoordinator = new SessionCoordinator();

function roomLogicalKey(projectId: string, roomId: string, agentId: string): string {
  return `room:${projectId}:${roomId}:${agentId}`;
}

function taskLogicalKey(projectId: string, roomId: string, taskId: string, agentId: string): string {
  return `task:${projectId}:${roomId}:${taskId}:${agentId}`;
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3.2);
}

function sameIdentity(session: AgentSessionRecord, identity: SessionIdentity): boolean {
  return session.harnessId === identity.harnessId
    && session.providerId === identity.providerId
    && session.model === identity.model;
}
