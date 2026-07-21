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
