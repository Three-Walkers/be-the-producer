export function memoryRelation(record, agent) {
  if (!agent) {
    return {
      owned: false,
      injected: false,
      readable: false,
      historical: record.status !== "active"
    };
  }

  return {
    owned: agent.ownedMemoryIds.includes(record.memoryId),
    injected: agent.injectedMemoryIds.includes(record.memoryId),
    readable: agent.readableMemoryIds.includes(record.memoryId),
    historical: record.status !== "active"
  };
}

export function filterMemoryRecords(memoryView, filters = {}) {
  if (!memoryView) {
    return [];
  }

  const agent = memoryView.agents.find((candidate) => candidate.agentId === filters.agentId);
  const query = String(filters.query ?? "").trim().toLocaleLowerCase("zh-CN");
  return memoryView.records.filter((record) => {
    const relation = memoryRelation(record, agent);
    if (filters.scope && filters.scope !== "all" && record.scope !== filters.scope) return false;
    if (filters.status && filters.status !== "all" && record.status !== filters.status) return false;
    if (agent && !relation.owned && !relation.injected && !relation.readable) return false;
    if (filters.relation === "owned" && !relation.owned) return false;
    if (filters.relation === "injected" && !relation.injected) return false;
    if (filters.relation === "readable" && !relation.readable) return false;
    if (filters.relation === "historical" && !relation.historical) return false;
    if (!query) return true;

    return [
      record.memoryId,
      record.type,
      record.scope,
      record.status,
      record.content,
      record.ownerAgent,
      record.sourceMessageId,
      record.sourceEventId,
      record.sourceArtifactId
    ]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase("zh-CN").includes(query));
  });
}

export function summarizeAgentMemory(agent, records) {
  if (!agent) {
    return { owned: 0, injected: 0, readable: 0, historical: 0 };
  }

  const recordIds = new Set(records.map((record) => record.memoryId));
  return {
    owned: agent.ownedMemoryIds.filter((memoryId) => recordIds.has(memoryId)).length,
    injected: agent.injectedMemoryIds.filter((memoryId) => recordIds.has(memoryId)).length,
    readable: agent.readableMemoryIds.filter((memoryId) => recordIds.has(memoryId)).length,
    historical: records.filter((record) => agent.ownedMemoryIds.includes(record.memoryId) && record.status !== "active").length
  };
}
