import type {
  AgentId,
  Artifact,
  AuditEvent,
  MemoryPack,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  ProjectId,
  StageId,
  Task
} from "@game-pipeline/shared-schemas";

export interface MemoryQuery {
  projectId: ProjectId;
  stageId?: StageId;
  scope?: MemoryScope;
  ownerAgent?: AgentId;
  status?: MemoryStatus | MemoryStatus[];
}

export class InMemoryProductionMemory {
  private readonly records: MemoryRecord[];

  constructor(records: MemoryRecord[] = []) {
    this.records = [...records];
  }

  write(record: MemoryRecord): MemoryRecord {
    this.records.push(record);
    return record;
  }

  list(projectId?: ProjectId): MemoryRecord[] {
    if (!projectId) {
      return [...this.records];
    }

    return this.records.filter((record) => record.projectId === projectId);
  }

  query(query: MemoryQuery): MemoryRecord[] {
    const statuses = Array.isArray(query.status) ? query.status : query.status ? [query.status] : ["active"];

    return this.records.filter((record) => {
      if (record.projectId !== query.projectId) return false;
      if (query.stageId && record.stageId !== query.stageId) return false;
      if (query.scope && record.scope !== query.scope) return false;
      if (query.ownerAgent && record.ownerAgent !== query.ownerAgent) return false;
      if (!statuses.includes(record.status)) return false;
      return true;
    });
  }

  buildMemoryPack(input: {
    projectId: ProjectId;
    stageId: StageId;
    agentId?: AgentId;
    tasks: Task[];
    artifacts: Artifact[];
    auditEvents: AuditEvent[];
  }): MemoryPack {
    const activeRecords = this.query({
      projectId: input.projectId,
      status: "active"
    });
    const roleRecords = input.agentId
      ? this.query({
          projectId: input.projectId,
          ownerAgent: input.agentId,
          status: "active"
        })
      : [];

    const openTasks = input.tasks.filter(
      (task) =>
        task.projectId === input.projectId &&
        (task.status === "todo" || task.status === "doing" || task.status === "review" || task.status === "blocked") &&
        (!input.agentId || task.ownerAgentId === input.agentId)
    );
    const blockers = openTasks.filter((task) => task.status === "blocked");

    return {
      projectBrief: activeRecords
        .filter((record) => record.scope === "project")
        .map((record) => record.content)
        .join("\n"),
      stageSnapshot: `Current stage: ${input.stageId}`,
      activeDecisions: activeRecords.filter((record) => record.scope === "decision"),
      producerPreferences: activeRecords.filter((record) => record.scope === "producer_preference"),
      ...(roleRecords.length > 0 ? { roleWorkspaceSummary: roleRecords.map((record) => record.content).join("\n") } : {}),
      openTasks,
      blockers,
      relevantArtifacts: input.artifacts.filter((artifact) => artifact.projectId === input.projectId),
      recentAuditEvents: input.auditEvents.filter((event) => event.projectId === input.projectId).slice(-20)
    };
  }
}
