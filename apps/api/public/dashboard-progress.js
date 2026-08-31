const statusProgress = {
  todo: 0,
  doing: 50,
  blocked: 50,
  review: 90,
  done: 100,
  cancelled: 0
};

export function taskProgressPercent(task) {
  const progress = task?.progressPercent ?? statusProgress[task?.status] ?? 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function summarizeTaskProgress(tasks) {
  if (tasks.length === 0) {
    return {
      total: 0,
      doneCount: 0,
      blockedCount: 0,
      progressPercent: 0
    };
  }

  return {
    total: tasks.length,
    doneCount: tasks.filter((task) => task.status === "done").length,
    blockedCount: tasks.filter((task) => task.status === "blocked").length,
    progressPercent: Math.round(tasks.reduce((sum, task) => sum + taskProgressPercent(task), 0) / tasks.length)
  };
}

export function selectTeamTasks(tasks, taskOwnerIds) {
  return tasks.filter(
    (task) => task.parentTaskId !== "task_group_claim_repair" && task.taskId !== "task_group_claim_repair" && taskOwnerIds.includes(task.ownerAgentId)
  );
}

export function flattenTaskBoard(taskBoard) {
  if (!taskBoard?.taskGroups) {
    return [];
  }
  const tasks = [];
  const visit = (task) => {
    tasks.push(task);
    (task.subtasks ?? []).forEach(visit);
  };
  for (const group of taskBoard.taskGroups) {
    for (const task of group.tasks ?? []) visit(task);
  }
  return tasks;
}

export function groupProjectDeliverables(artifacts) {
  const families = new Map();
  for (const artifact of artifacts) {
    const familyId = [artifact.type ?? artifact.artifactId, artifact.ownerAgentId ?? "", artifact.stageId ?? ""].join("::");
    const family = families.get(familyId) ?? { familyId, artifacts: [] };
    family.artifacts.push(artifact);
    families.set(familyId, family);
  }

  return [...families.values()].map((family) => {
    const versions = [...family.artifacts].sort(compareDeliverableRecency);
    return {
      familyId: family.familyId,
      latest: versions[0],
      history: versions.slice(1),
      versionCount: versions.length
    };
  });
}

function compareDeliverableRecency(left, right) {
  const versionDelta = numericVersion(right.version) - numericVersion(left.version);
  if (versionDelta !== 0) return versionDelta;
  const timestampDelta = artifactTimestamp(right) - artifactTimestamp(left);
  if (timestampDelta !== 0) return timestampDelta;
  return String(right.artifactId).localeCompare(String(left.artifactId));
}

function numericVersion(version) {
  const number = Number(version);
  return Number.isFinite(number) ? number : 0;
}

function artifactTimestamp(artifact) {
  const timestamp = Date.parse(artifact.updatedAt ?? artifact.createdAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function summarizeProjectDashboard({ taskBoard, artifacts = [], productionAudit, teamOwnerGroups = [] }) {
  const allTasks = flattenTaskBoard(taskBoard);
  const tasks = allTasks.filter(
    (task) => task.parentTaskId !== "task_group_claim_repair" && task.taskId !== "task_group_claim_repair"
  );
  const taskProgress = summarizeTaskProgress(tasks);
  const deliverables = artifacts.filter(
    (artifact) => artifact.status !== "superseded" && artifact.status !== "rejected"
  );
  const auditBlockingCount = (productionAudit?.findings ?? []).filter(
    (finding) => finding.status === "open" && ["critical", "high"].includes(finding.severity)
  ).length;
  const blockedTasks = allTasks.filter((task) => task.status === "blocked");
  const blockedTaskCount = taskBoard?.buckets?.blocked ?? blockedTasks.length;
  const deliveryBlockedTasks = tasks.filter((task) => task.status === "blocked" || (task.blockers?.length ?? 0) > 0);
  const activeTeamCount = teamOwnerGroups.filter((owners) =>
    tasks.some((task) => owners.includes(task.ownerAgentId) && ["doing", "review", "blocked"].includes(task.status))
  ).length;
  const nextTask =
    deliveryBlockedTasks[0] ??
    tasks.find((task) => task.status === "review") ??
    tasks.find((task) => task.status === "doing") ??
    tasks.find((task) => task.status === "todo") ??
    blockedTasks[0] ??
    null;

  return {
    taskTotal: taskBoard?.total ?? allTasks.length,
    doneCount: taskBoard?.buckets?.done ?? summarizeTaskProgress(allTasks).doneCount,
    progressPercent: taskProgress.progressPercent,
    deliverableCount: deliverables.length,
    blockedTaskCount,
    auditBlockingCount,
    blockerCount: blockedTaskCount + auditBlockingCount,
    activeTeamCount,
    nextTask
  };
}
