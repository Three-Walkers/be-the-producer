import {
  memoryRecordIsInjectedIntoDurablePack,
  type StudioKernel
} from "@game-pipeline/agent-runtime";
import type {
  AgentId,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  TaskStatus
} from "@game-pipeline/shared-schemas";

const memoryStatuses: MemoryStatus[] = ["active", "draft", "superseded", "rejected", "archived"];
const memoryScopes: MemoryScope[] = [
  "project",
  "role",
  "decision",
  "artifact",
  "qa",
  "release",
  "producer_preference",
  "knowledge"
];

export interface ProjectMemoryAgentView {
  agentId: AgentId;
  displayName: string;
  roleScope: string;
  workspace: string;
  capability: string;
  runtimeStatus: string;
  currentTaskId?: string;
  readableScopes: MemoryScope[];
  writableScopes: MemoryScope[];
  ownedMemoryIds: string[];
  readableMemoryIds: string[];
  injectedMemoryIds: string[];
  context: {
    stageSnapshot: string;
    projectBrief: string;
    roleWorkspaceSummary?: string;
    activeDecisionIds: string[];
    producerPreferenceIds: string[];
    openTasks: Array<{ taskId: string; title: string; status: TaskStatus; blockers: string[] }>;
    relevantArtifactIds: string[];
    recentAuditEventIds: string[];
    durableLayerLimitChars: number;
    sessionMemory: {
      sessionCount: number;
      activeSessionCount: number;
      contextPacketCount: number;
      handoffCapsuleCount: number;
      latestSession?: {
        sessionKey: string;
        scope: string;
        roomId: string;
        status: string;
        model: string;
        contextTokensEstimate: number;
        updatedAt: string;
      };
      latestPacket?: {
        packetId: string;
        roomId: string;
        createdAt: string;
        layers: Array<{
          kind: string;
          title: string;
          characterCount: number;
          sourceRefCount: number;
          truncated: boolean;
        }>;
      };
    };
  };
}

export interface ProjectMemoryView {
  projectId: string;
  projectName: string;
  currentStage: string;
  records: MemoryRecord[];
  /** Backward-compatible alias for the original GET /memory response. */
  memory: MemoryRecord[];
  agents: ProjectMemoryAgentView[];
  summary: {
    total: number;
    active: number;
    shared: number;
    owned: number;
    byStatus: Record<MemoryStatus, number>;
    byScope: Record<MemoryScope, number>;
  };
  architecture: {
    sourceOfTruth: string;
    persistence: string[];
    injection: string;
    search: string;
  };
}

export function buildProjectMemoryView(kernel: StudioKernel): ProjectMemoryView {
  const projectId = kernel.project.projectId;
  const records = kernel.memory
    .list(projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
  const tasks = kernel.listTasks();
  const artifacts = kernel.listArtifacts();
  const auditEvents = kernel.listAuditEvents();
  const sessions = kernel.listAgentSessions();
  const contextPackets = kernel.listContextPackets();
  const handoffCapsules = kernel.listHandoffCapsules();
  const loop = kernel.getAgentLoopState();

  const agents = kernel.agents.list().map<ProjectMemoryAgentView>((agent) => {
    const pack = kernel.memory.buildMemoryPack({
      projectId,
      stageId: kernel.project.currentStage,
      agentId: agent.agentId,
      tasks,
      artifacts,
      auditEvents
    });
    const ownedRecords = records.filter((record) => record.ownerAgent === agent.agentId);
    const readableRecords = records.filter((record) => agent.memoryScopes.read.includes(record.scope));
    const injectedRecords = records.filter((record) =>
      memoryRecordIsInjectedIntoDurablePack(record, agent.agentId)
    );
    const runtime = loop.agents[agent.agentId];
    const agentSessions = sessions
      .filter((session) => session.agentId === agent.agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const agentPackets = contextPackets
      .filter((packet) => packet.agentId === agent.agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const agentHandoffs = handoffCapsules.filter(
      (capsule) => capsule.sourceAgentId === agent.agentId || capsule.targetAgentIds.includes(agent.agentId)
    );
    const latestSession = agentSessions[0];
    const latestPacket = agentPackets[0];

    return {
      agentId: agent.agentId,
      displayName: agent.displayName,
      roleScope: agent.roleScope,
      workspace: agent.workspace,
      capability: agent.modelProfile.capability,
      runtimeStatus: runtime?.status ?? "idle",
      ...(runtime?.taskId ? { currentTaskId: runtime.taskId } : {}),
      readableScopes: [...agent.memoryScopes.read],
      writableScopes: [...agent.memoryScopes.write],
      ownedMemoryIds: ownedRecords.map((record) => record.memoryId),
      readableMemoryIds: readableRecords.map((record) => record.memoryId),
      injectedMemoryIds: injectedRecords.map((record) => record.memoryId),
      context: {
        stageSnapshot: pack.stageSnapshot,
        projectBrief: pack.projectBrief,
        ...(pack.roleWorkspaceSummary ? { roleWorkspaceSummary: pack.roleWorkspaceSummary } : {}),
        activeDecisionIds: pack.activeDecisions.map((record) => record.memoryId),
        producerPreferenceIds: pack.producerPreferences.map((record) => record.memoryId),
        openTasks: pack.openTasks.map((task) => ({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          blockers: [...task.blockers]
        })),
        relevantArtifactIds: pack.relevantArtifacts.map((artifact) => artifact.artifactId),
        recentAuditEventIds: pack.recentAuditEvents.map((event) => event.eventId),
        durableLayerLimitChars: 10_000,
        sessionMemory: {
          sessionCount: agentSessions.length,
          activeSessionCount: agentSessions.filter((session) => session.status !== "sealed").length,
          contextPacketCount: agentPackets.length,
          handoffCapsuleCount: agentHandoffs.length,
          ...(latestSession
            ? {
                latestSession: {
                  sessionKey: latestSession.sessionKey,
                  scope: latestSession.scope,
                  roomId: latestSession.roomId,
                  status: latestSession.status,
                  model: latestSession.model,
                  contextTokensEstimate: latestSession.contextTokensEstimate,
                  updatedAt: latestSession.updatedAt
                }
              }
            : {}),
          ...(latestPacket
            ? {
                latestPacket: {
                  packetId: latestPacket.packetId,
                  roomId: latestPacket.roomId,
                  createdAt: latestPacket.createdAt,
                  layers: latestPacket.layers.map((layer) => ({
                    kind: layer.kind,
                    title: layer.title,
                    characterCount: layer.content.length,
                    sourceRefCount: layer.sourceRefs.length,
                    truncated: layer.truncated
                  }))
                }
              }
            : {})
        }
      }
    };
  });

  return {
    projectId,
    projectName: kernel.project.name,
    currentStage: kernel.project.currentStage,
    records,
    memory: records,
    agents,
    summary: {
      total: records.length,
      active: records.filter((record) => record.status === "active").length,
      shared: records.filter((record) => !record.ownerAgent).length,
      owned: records.filter((record) => Boolean(record.ownerAgent)).length,
      byStatus: countBy(records, memoryStatuses, (record) => record.status),
      byScope: countBy(records, memoryScopes, (record) => record.scope)
    },
    architecture: {
      sourceOfTruth: "StudioKernel structured MemoryRecord",
      persistence: ["studio-state.json snapshot", "shared/memory/project-memory.jsonl"],
      injection: "active project/decision/producer preference + active owner memory -> durable_memory context layer",
      search: "structured filters only; vector retrieval is not enabled in the local runtime"
    }
  };
}

function countBy<RecordType, Key extends string>(
  records: RecordType[],
  keys: Key[],
  select: (record: RecordType) => Key
): Record<Key, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  for (const record of records) {
    result[select(record)] += 1;
  }
  return result;
}
