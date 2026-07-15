import type { AgentContract, AgentId, RoomKind, StageId } from "@game-pipeline/shared-schemas";

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentContract>();

  constructor(initialAgents: AgentContract[] = []) {
    for (const agent of initialAgents) {
      this.register(agent);
    }
  }

  register(agent: AgentContract): void {
    if (this.agents.has(agent.agentId)) {
      throw new Error(`Agent already registered: ${agent.agentId}`);
    }

    this.agents.set(agent.agentId, agent);
  }

  get(agentId: AgentId): AgentContract {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    return agent;
  }

  maybeGet(agentId: AgentId): AgentContract | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentContract[] {
    return Array.from(this.agents.values());
  }

  byRoom(roomKind: RoomKind): AgentContract[] {
    return this.list().filter((agent) => agent.roomMemberships.includes(roomKind));
  }

  byStageLead(stageId: StageId): AgentContract[] {
    return this.list().filter((agent) => agent.stageLeads.includes(stageId));
  }

  has(agentId: AgentId): boolean {
    return this.agents.has(agentId);
  }
}
