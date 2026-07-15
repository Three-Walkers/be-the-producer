import type {
  AgentId,
  ProjectId,
  RoomId,
  StageId,
  Task,
  TaskBoardGroup,
  TaskBoardItem,
  TaskBoardSnapshot,
  TaskBucket,
  TaskChildrenSummary,
  TaskStatus
} from "@game-pipeline/shared-schemas";

const emptyChildrenSummary = (): TaskChildrenSummary => ({
  doing: 0,
  blocked: 0,
  todo: 0,
  done: 0,
  cancelled: 0
});

export function toTaskBucket(status: TaskStatus): TaskBucket | undefined {
  if (status === "doing" || status === "review") {
    return "doing";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "todo") {
    return "todo";
  }
  if (status === "done") {
    return "done";
  }
  return undefined;
}

export function aggregateTaskStatus(children: Task[]): TaskStatus {
  if (children.length === 0) {
    return "todo";
  }

  if (children.every((task) => task.status === "cancelled")) {
    return "cancelled";
  }

  if (children.some((task) => task.status === "blocked")) {
    return "blocked";
  }

  const activeChildren = children.filter((task) => task.status !== "cancelled");
  if (activeChildren.length > 0 && activeChildren.every((task) => task.status === "done")) {
    return "done";
  }

  if (activeChildren.some((task) => task.status === "doing" || task.status === "review")) {
    return "doing";
  }

  return "todo";
}

export function aggregateChildrenSummary(children: Task[]): TaskChildrenSummary {
  return children.reduce((summary, task) => {
    if (task.status === "doing" || task.status === "review") {
      summary.doing += 1;
      return summary;
    }
    summary[task.status] += 1;
    return summary;
  }, emptyChildrenSummary());
}

export function calculateProgressPercent(task: Task, children: Task[]): number | undefined {
  if (children.length === 0) {
    if (task.status === "todo") return 0;
    if (task.status === "doing" || task.status === "review" || task.status === "blocked") return 50;
    if (task.status === "done") return 100;
    return undefined;
  }

  const effectiveChildren = children.filter((child) => child.status !== "cancelled");
  if (effectiveChildren.length === 0) {
    return undefined;
  }

  return Math.round((effectiveChildren.filter((child) => child.status === "done").length / effectiveChildren.length) * 100);
}

export interface TaskBoardFilter {
  projectId: ProjectId;
  scope?: "project" | "stage" | "room" | "agent";
  stageId?: StageId;
  roomId?: RoomId;
  agentId?: AgentId;
}

export class TaskBoardBuilder {
  build(tasks: Task[], filter: TaskBoardFilter, createdAt = new Date().toISOString()): TaskBoardSnapshot {
    const scopedTasks = this.applyFilter(tasks, filter);
    const taskGroups = scopedTasks
      .filter((task) => task.taskLevel === "task_group")
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((group) => this.toGroup(group, scopedTasks));

    const buckets = this.countBuckets(scopedTasks.filter((task) => task.taskLevel !== "task_group"));

    return {
      projectId: filter.projectId,
      scope: filter.scope ?? "project",
      ...(filter.roomId ? { roomId: filter.roomId } : {}),
      ...(filter.stageId ? { stageId: filter.stageId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      total: scopedTasks.filter((task) => task.taskLevel !== "task_group").length,
      buckets,
      taskGroups,
      createdAt
    };
  }

  private applyFilter(tasks: Task[], filter: TaskBoardFilter): Task[] {
    return tasks.filter((task) => {
      if (task.projectId !== filter.projectId) return false;
      if (filter.stageId && task.stageId !== filter.stageId) return false;
      if (filter.roomId && task.roomId !== filter.roomId) return false;
      if (filter.agentId && task.ownerAgentId !== filter.agentId && task.taskLevel !== "task_group") return false;
      return true;
    });
  }

  private countBuckets(tasks: Task[]): Record<TaskBucket, number> {
    const buckets: Record<TaskBucket, number> = {
      doing: 0,
      blocked: 0,
      todo: 0,
      done: 0
    };

    for (const task of tasks) {
      const bucket = toTaskBucket(task.status);
      if (bucket) {
        buckets[bucket] += 1;
      }
    }

    return buckets;
  }

  private toGroup(group: Task, tasks: Task[]): TaskBoardGroup {
    const children = tasks
      .filter((task) => task.parentTaskId === group.taskId && task.taskLevel === "task")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const allDescendants = this.descendants(group.taskId, tasks);
    const childrenSummary = aggregateChildrenSummary(allDescendants.filter((task) => task.taskLevel !== "task_group"));
    const progressPercent = calculateProgressPercent(group, allDescendants);

    return {
      taskId: group.taskId,
      title: group.title,
      status: allDescendants.length > 0 ? aggregateTaskStatus(allDescendants) : group.status,
      ...(progressPercent === undefined ? {} : { progressPercent }),
      childrenSummary,
      tasks: children.map((task) => this.toItem(task, tasks))
    };
  }

  private toItem(task: Task, tasks: Task[]): TaskBoardItem {
    const subtasks = tasks
      .filter((candidate) => candidate.parentTaskId === task.taskId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const childrenSummary = aggregateChildrenSummary(subtasks);
    const progressPercent = calculateProgressPercent(task, subtasks);

    return {
      taskId: task.taskId,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      title: task.title,
      status: subtasks.length > 0 ? aggregateTaskStatus(subtasks) : task.status,
      ownerAgentId: task.ownerAgentId,
      ...(progressPercent === undefined ? {} : { progressPercent }),
      blockers: task.blockers,
      childrenSummary,
      subtasks: subtasks.map((subtask) => this.toItem(subtask, tasks))
    };
  }

  private descendants(taskId: string, tasks: Task[]): Task[] {
    const direct = tasks.filter((task) => task.parentTaskId === taskId);
    return direct.flatMap((task) => [task, ...this.descendants(task.taskId, tasks)]);
  }
}
