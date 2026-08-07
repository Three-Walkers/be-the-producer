import type {
  AgentId,
  AgentLoopControl,
  AgentLoopState,
  StudioMessage,
  Task,
  TaskId
} from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import { finalizeTaskSessionProtocol, ModelAgentRuntime } from "./modelAgentRuntime.js";
import { executeAgentToolRequests, type ToolExecutionResult } from "./toolExecutor.js";
import { taskOutputsVerified } from "./taskOutputEvidence.js";
import { resumeQaTasksAfterVerifiedRepairs } from "./qaRepairFlow.js";
import { finalizeMessageActivity, recordServerToolActivity } from "./agentActivity.js";

export interface AgentLoopWakeOptions {
  reason: string;
  triggerMessageId?: string;
  preferredAgentIds?: AgentId[];
  unlockProducerWaits?: boolean;
  unlockRetryableFailures?: boolean;
}

interface AgentLoopDependencies {
  getKernel(projectId: string): StudioKernel;
  checkpoint(kernel: StudioKernel): void;
  modelRuntime: ModelAgentRuntime;
}

interface ActiveRun {
  generation: number;
  abortController: AbortController;
}

const loopBlockerPrefix = "Agent Loop：";
const maxParallelAgents = 3;
const maxRoundsPerBatch = 24;
const maxTransientFailures = 3;

export class AgentLoopService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingWakeups = new Map<string, AgentLoopWakeOptions>();
  private generation = 0;

  constructor(private readonly dependencies: AgentLoopDependencies) {}

  start(projectId: string, options: AgentLoopWakeOptions): AgentLoopState {
    const kernel = this.dependencies.getKernel(projectId);
    if (kernel.project.executionStatus !== "running") {
      return kernel.getAgentLoopState();
    }

    if (this.activeRuns.has(projectId)) {
      this.pendingWakeups.set(projectId, mergeWakeOptions(this.pendingWakeups.get(projectId), options));
      return kernel.getAgentLoopState();
    }

    const generation = ++this.generation;
    const abortController = new AbortController();
    this.activeRuns.set(projectId, { generation, abortController });
    const now = new Date().toISOString();
    for (const agent of Object.values(kernel.getAgentLoopState().agents)) {
      if (agent.status === "working") {
        kernel.updateAgentLoopAgent(agent.agentId, {
          status: "queued",
          lastError: undefined,
          updatedAt: now
        });
      }
    }
    kernel.updateAgentLoop({
      status: "running",
      runId: `run_${projectId}_${Date.now()}`,
      activeAgentIds: [],
      pendingTaskIds: [],
      waitingReason: undefined,
      lastError: undefined,
      startedAt: now,
      updatedAt: now
    });
    this.dependencies.checkpoint(kernel);
    queueMicrotask(() => {
      void this.runProject(projectId, generation, options);
    });
    return kernel.getAgentLoopState();
  }

  pause(projectId: string, reason = "制作人暂停了项目。"): AgentLoopState {
    const kernel = this.dependencies.getKernel(projectId);
    this.activeRuns.get(projectId)?.abortController.abort();
    this.activeRuns.delete(projectId);
    this.pendingWakeups.delete(projectId);
    ++this.generation;
    const now = new Date().toISOString();
    for (const agentId of kernel.getAgentLoopState().activeAgentIds) {
      kernel.updateAgentLoopAgent(agentId, {
        status: "waiting",
        lastError: undefined,
        updatedAt: now
      });
    }
    for (const activity of kernel.listAgentActivities()) {
      kernel.removeAgentActivity(activity.activityId);
    }
    const state = kernel.updateAgentLoop({
      status: "paused",
      activeAgentIds: [],
      pendingTaskIds: [],
      waitingReason: reason,
      updatedAt: now
    });
    this.dependencies.checkpoint(kernel);
    return state;
  }

  cancel(projectId: string): void {
    this.activeRuns.get(projectId)?.abortController.abort();
    this.activeRuns.delete(projectId);
    this.pendingWakeups.delete(projectId);
    ++this.generation;
  }

  private async runProject(projectId: string, generation: number, initialOptions: AgentLoopWakeOptions): Promise<void> {
    let options = initialOptions;
    const noProgressCounts = new Map<TaskId, number>();
    const failureCounts = new Map<TaskId, number>();
    let rounds = 0;
    try {
      while (true) {
        const active = this.activeRuns.get(projectId);
        const kernel = this.dependencies.getKernel(projectId);
        if (!active || active.generation !== generation || kernel.project.executionStatus !== "running") {
          return;
        }

        if (options.unlockProducerWaits) {
          unlockTasksWaitingForProducer(kernel);
          options = { ...options, unlockProducerWaits: false };
        }
        if (options.unlockRetryableFailures) {
          unlockRetryableAgentFailures(kernel);
          options = { ...options, unlockRetryableFailures: false };
        }
        resumeQaTasksAfterVerifiedRepairs(kernel);
        advanceVerifiedTasksToReview(kernel);

        const candidates = selectRunnableTasks(kernel, options.preferredAgentIds).slice(0, maxParallelAgents);
        if (candidates.length === 0) {
          settleWithoutRunnableTasks(kernel);
          this.dependencies.checkpoint(kernel);
          return;
        }

        rounds += 1;
        const iteration = kernel.getAgentLoopState().iteration + 1;
        const now = new Date().toISOString();
        kernel.updateAgentLoop({
          status: "running",
          iteration,
          activeAgentIds: candidates.map((task) => task.ownerAgentId),
          pendingTaskIds: candidates.map((task) => task.taskId),
          waitingReason: undefined,
          updatedAt: now
        });
        for (const task of candidates) {
          kernel.updateTask(task.taskId, {
            status: "doing",
            progressPercent: Math.max(5, task.progressPercent ?? 0),
            updatedAt: now
          });
          kernel.updateAgentLoopAgent(task.ownerAgentId, {
            status: "working",
            taskId: task.taskId,
            iteration,
            lastError: undefined,
            updatedAt: now
          });
        }
        this.dependencies.checkpoint(kernel);

        const messages = new Array<StudioMessage>(candidates.length);
        await Promise.all(
          candidates.map(async (task, index) => {
            const message = await this.dependencies.modelRuntime.respondToTask(kernel, task, {
              iteration,
              abortSignal: active.abortController.signal,
              onAgentActivity: () => this.dependencies.checkpoint(kernel),
              ...(options.triggerMessageId ? { triggerMessageId: options.triggerMessageId } : {})
            });
            messages[index] = message;
            kernel.recordMessage(message);
            this.dependencies.checkpoint(kernel);
          })
        );

        const current = this.activeRuns.get(projectId);
        if (!current || current.generation !== generation || kernel.project.executionStatus !== "running") {
          return;
        }

        await executeAgentToolRequests(kernel, messages, {
          onActivity: (message, event) => {
            recordServerToolActivity(kernel, message, event);
            this.dependencies.checkpoint(kernel);
          }
        });
        for (const message of messages) {
          finalizeMessageActivity(kernel, message);
        }
        this.dependencies.checkpoint(kernel);

        for (let index = 0; index < candidates.length; index += 1) {
          const task = candidates[index];
          const message = messages[index];
          if (task && message) {
            applyTaskOutcome(kernel, task, message, noProgressCounts, failureCounts);
            finalizeTaskSessionProtocol(kernel, kernel.findTask(task.taskId) ?? task, message);
          }
        }
        advanceVerifiedTasksToReview(kernel);
        kernel.updateAgentLoop({
          activeAgentIds: [],
          pendingTaskIds: [],
          updatedAt: new Date().toISOString()
        });
        this.dependencies.checkpoint(kernel);

        const pending = this.pendingWakeups.get(projectId);
        if (pending) {
          this.pendingWakeups.delete(projectId);
          options = mergeWakeOptions(options, pending);
        } else {
          options = {
            reason: "继续处理可执行任务。"
          };
        }
        if (rounds % maxRoundsPerBatch === 0) {
          await yieldToEventLoop();
        }
      }
    } catch (error) {
      const kernel = this.dependencies.getKernel(projectId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      for (const agentId of kernel.getAgentLoopState().activeAgentIds) {
        kernel.updateAgentLoopAgent(agentId, {
          status: "error",
          lastError: errorMessage,
          updatedAt: now
        });
      }
      kernel.updateAgentLoop({
        status: "error",
        activeAgentIds: [],
        pendingTaskIds: [],
        lastError: errorMessage,
        waitingReason: "Agent Loop 发生未处理错误，需要制作人检查配置或日志。",
        updatedAt: now
      });
      this.dependencies.checkpoint(kernel);
    } finally {
      const active = this.activeRuns.get(projectId);
      if (active?.generation === generation) {
        this.activeRuns.delete(projectId);
      }
      const pending = this.pendingWakeups.get(projectId);
      if (pending) {
        this.pendingWakeups.delete(projectId);
        this.start(projectId, pending);
      }
    }
  }
}

function selectRunnableTasks(kernel: StudioKernel, preferredAgentIds: AgentId[] = []): Task[] {
  const preferred = new Set(preferredAgentIds);
  return kernel
    .listTasks()
    .filter(
      (task) =>
        task.stageId === kernel.project.currentStage &&
        task.taskLevel !== "task_group" &&
        ["todo", "doing"].includes(task.status) &&
        !["producer", "studio_orchestrator"].includes(task.ownerAgentId) &&
        task.blockers.length === 0 &&
        inputArtifactsVerified(kernel, task)
    )
    .sort((left, right) => {
      const preferredDelta = Number(preferred.has(right.ownerAgentId)) - Number(preferred.has(left.ownerAgentId));
      return preferredDelta || right.priority - left.priority || left.sortOrder - right.sortOrder;
    });
}

function inputArtifactsVerified(kernel: StudioKernel, task: Task): boolean {
  if (task.inputArtifacts.length === 0) {
    return true;
  }
  const artifacts = kernel.listArtifacts();
  const ledger = kernel.listArtifactLedger();
  return task.inputArtifacts.every((artifactId) => {
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    const evidence = ledger.find((entry) => entry.artifactId === artifactId);
    return Boolean(artifact?.metadata.toolExecutedAt && evidence?.status === "verified");
  });
}

function advanceVerifiedTasksToReview(kernel: StudioKernel): void {
  for (const task of kernel.listTasks()) {
    if (
      task.stageId === kernel.project.currentStage &&
      task.taskLevel !== "task_group" &&
      ["todo", "doing"].includes(task.status) &&
      taskOutputsVerified(kernel, task)
    ) {
      kernel.updateTask(task.taskId, {
        status: "review",
        progressPercent: 90,
        blockers: [],
        updatedAt: new Date().toISOString()
      });
    }
  }
}

function unlockTasksWaitingForProducer(kernel: StudioKernel): void {
  for (const task of kernel.listTasks()) {
    if (task.stageId !== kernel.project.currentStage || task.taskLevel === "task_group") {
      continue;
    }
    const remaining = task.blockers.filter(
      (blocker) => !blocker.startsWith(`${loopBlockerPrefix}等待制作人`) && !/^等待制作人/.test(blocker)
    );
    if (remaining.length === task.blockers.length) {
      continue;
    }
    kernel.updateTask(task.taskId, {
      status: "doing",
      blockers: remaining,
      updatedAt: new Date().toISOString()
    });
  }
}

function unlockRetryableAgentFailures(kernel: StudioKernel): void {
  const nonRetryable = /越权|删除操作|项目根目录之外|阶段门禁/;
  const now = new Date().toISOString();
  for (const task of kernel.listTasks()) {
    if (task.stageId !== kernel.project.currentStage || task.taskLevel === "task_group" || task.status !== "blocked") {
      continue;
    }
    const remaining = task.blockers.filter(
      (blocker) => !blocker.startsWith(loopBlockerPrefix) || nonRetryable.test(blocker) || blocker.includes("等待制作人")
    );
    if (remaining.length === task.blockers.length) {
      continue;
    }
    kernel.updateTask(task.taskId, {
      status: remaining.length > 0 ? "blocked" : "doing",
      blockers: remaining,
      updatedAt: now
    });
    if (remaining.length === 0) {
      kernel.updateAgentLoopAgent(task.ownerAgentId, {
        status: "queued",
        taskId: task.taskId,
        lastError: undefined,
        updatedAt: now
      });
    }
  }
}

function applyTaskOutcome(
  kernel: StudioKernel,
  task: Task,
  message: StudioMessage,
  noProgressCounts: Map<TaskId, number>,
  failureCounts: Map<TaskId, number>
): void {
  const control = readLoopControl(message);
  const toolResults = readToolResults(message);
  const successfulTools = toolResults.filter((result) => result.status === "completed");
  const failedTools = toolResults.filter((result) => result.status === "failed");
  const now = new Date().toISOString();

  if (message.metadata.failure === true) {
    const retryLimit = message.metadata.failureKind === "harness_timeout_no_progress" ? 2 : maxTransientFailures;
    retryTransientFailure(kernel, task, message, failureCounts, message.content, retryLimit);
    return;
  }

  if (failedTools.length > 0) {
    const error = failedTools.map((result) => `${result.toolName}: ${result.error ?? "未知错误"}`).join("；");
    retryTransientFailure(kernel, task, message, failureCounts, `工具执行失败：${error}`);
    return;
  }

  const currentTask = kernel.findTask(task.taskId) ?? task;
  const qaFailureBlocker = currentTask.blockers.find((blocker) => blocker.startsWith("QA_PLAYTEST_FAILED:"));
  if (currentTask.status === "blocked" && qaFailureBlocker) {
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "blocked",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: qaFailureBlocker,
      updatedAt: now
    });
    return;
  }
  if (["review", "done"].includes(currentTask.status) && taskOutputsVerified(kernel, currentTask)) {
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "waiting",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: undefined,
      updatedAt: now
    });
    return;
  }

  if (!control) {
    retryTransientFailure(kernel, task, message, failureCounts, "Agent 未返回结构化 loopControl，调度器无法安全决定下一步。");
    return;
  }
  failureCounts.delete(task.taskId);

  if (control.status === "waiting_for_producer") {
    kernel.updateTask(task.taskId, {
      status: "blocked",
      blockers: mergeBlockers(task.blockers, `${loopBlockerPrefix}等待制作人：${control.reason}`),
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "waiting",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: undefined,
      updatedAt: now
    });
    return;
  }

  if (control.status === "blocked") {
    kernel.updateTask(task.taskId, {
      status: "blocked",
      blockers: mergeBlockers(task.blockers, `${loopBlockerPrefix}${control.reason}`),
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "blocked",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: control.reason,
      updatedAt: now
    });
    return;
  }

  if (control.status === "ready_for_review") {
    if (!taskOutputsVerified(kernel, kernel.findTask(task.taskId) ?? task)) {
      kernel.updateTask(task.taskId, {
        status: "blocked",
        blockers: mergeBlockers(task.blockers, `${loopBlockerPrefix}Agent 请求评审，但任务输出尚未全部通过 Artifact Ledger 验证。`),
        updatedAt: now
      });
      kernel.updateAgentLoopAgent(task.ownerAgentId, {
        status: "blocked",
        taskId: task.taskId,
        lastMessageId: message.messageId,
        lastError: "评审证据不足",
        updatedAt: now
      });
      return;
    }
    kernel.updateTask(task.taskId, {
      status: "review",
      progressPercent: 90,
      blockers: [],
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "waiting",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: undefined,
      updatedAt: now
    });
    return;
  }

  if (control.status === "handoff") {
    const verified = taskOutputsVerified(kernel, kernel.findTask(task.taskId) ?? task);
    kernel.updateTask(task.taskId, verified
      ? { status: "review", progressPercent: 90, blockers: [], updatedAt: now }
      : {
          status: "blocked",
          blockers: mergeBlockers(task.blockers, `${loopBlockerPrefix}已交接给 ${control.handoffAgentIds.join("、") || "其他角色"}：${control.reason}`),
          updatedAt: now
        });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "waiting",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: undefined,
      updatedAt: now
    });
    for (const agentId of control.handoffAgentIds) {
      kernel.updateAgentLoopAgent(agentId, {
        status: "queued",
        iteration: kernel.getAgentLoopState().iteration,
        updatedAt: now
      });
    }
    return;
  }

  const previousNoProgress = noProgressCounts.get(task.taskId) ?? 0;
  const noProgress = successfulTools.length === 0 ? previousNoProgress + 1 : 0;
  noProgressCounts.set(task.taskId, noProgress);
  if (noProgress >= 2) {
    kernel.updateTask(task.taskId, {
      status: "blocked",
      blockers: mergeBlockers(task.blockers, `${loopBlockerPrefix}连续两轮没有产生工具结果，已停止自动重试。`),
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "blocked",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: "连续两轮无工具进展",
      updatedAt: now
    });
    return;
  }

  kernel.updateTask(task.taskId, {
    status: "doing",
    progressPercent: Math.min(85, (task.progressPercent ?? 0) + (successfulTools.length > 0 ? 15 : 5)),
    blockers: [],
    updatedAt: now
  });
  kernel.updateAgentLoopAgent(task.ownerAgentId, {
    status: "queued",
    taskId: task.taskId,
    lastMessageId: message.messageId,
    lastError: undefined,
    updatedAt: now
  });
}

function retryTransientFailure(
  kernel: StudioKernel,
  task: Task,
  message: StudioMessage,
  failureCounts: Map<TaskId, number>,
  error: string,
  retryLimit = maxTransientFailures
): void {
  const failureCount = (failureCounts.get(task.taskId) ?? 0) + 1;
  failureCounts.set(task.taskId, failureCount);
  const now = new Date().toISOString();
  if (failureCount < retryLimit) {
    kernel.updateTask(task.taskId, {
      status: "doing",
      blockers: task.blockers.filter((blocker) => !blocker.startsWith(loopBlockerPrefix)),
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "queued",
      taskId: task.taskId,
      lastMessageId: message.messageId,
      lastError: `${error}（自动重试 ${failureCount}/${retryLimit}）`,
      updatedAt: now
    });
    return;
  }
  kernel.updateTask(task.taskId, {
    status: "blocked",
    blockers: mergeBlockers(task.blockers, `${loopBlockerPrefix}${error}；连续失败 ${failureCount} 次，已停止自动重试。`),
    updatedAt: now
  });
  kernel.updateAgentLoopAgent(task.ownerAgentId, {
    status: "error",
    taskId: task.taskId,
    lastMessageId: message.messageId,
    lastError: error,
    updatedAt: now
  });
}

function settleWithoutRunnableTasks(kernel: StudioKernel): void {
  const stageTasks = kernel
    .listTasks()
    .filter((task) => task.stageId === kernel.project.currentStage && task.taskLevel !== "task_group");
  const blocked = stageTasks.filter((task) => task.status === "blocked");
  const review = stageTasks.filter((task) => task.status === "review");
  const pendingDependencies = stageTasks.filter((task) => ["todo", "doing"].includes(task.status));
  const waitingForProducer = blocked.some((task) => task.blockers.some((blocker) => blocker.includes("等待制作人"))) || review.length > 0;
  const reason = waitingForProducer
    ? review.length > 0
      ? `${review.length} 个任务已进入评审，阶段保持开放，等待制作人继续讨论或发起门禁评审。`
      : blocked.flatMap((task) => task.blockers).join("；")
    : blocked.length > 0
      ? blocked.flatMap((task) => task.blockers).join("；")
      : pendingDependencies.length > 0
        ? "剩余任务正在等待已验证的上游产物。"
        : "当前阶段没有可自动执行的角色任务，等待制作人下一步指令。";
  kernel.updateAgentLoop({
    status: waitingForProducer || blocked.length === 0 ? "waiting_for_producer" : "blocked",
    activeAgentIds: [],
    pendingTaskIds: pendingDependencies.map((task) => task.taskId),
    waitingReason: reason,
    updatedAt: new Date().toISOString()
  });
}

function readLoopControl(message: StudioMessage): AgentLoopControl | undefined {
  const value = message.metadata.loopControl;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const control = value as Partial<AgentLoopControl>;
  if (!control.status || !control.reason) {
    return undefined;
  }
  return {
    status: control.status,
    reason: control.reason,
    handoffAgentIds: Array.isArray(control.handoffAgentIds) ? control.handoffAgentIds : []
  };
}

function readToolResults(message: StudioMessage): ToolExecutionResult[] {
  return Array.isArray(message.metadata.toolExecutions) ? (message.metadata.toolExecutions as ToolExecutionResult[]) : [];
}

function mergeBlockers(current: string[], blocker: string): string[] {
  return [...new Set([...current.filter((item) => !item.startsWith(loopBlockerPrefix)), blocker])];
}

function mergeWakeOptions(current: AgentLoopWakeOptions | undefined, next: AgentLoopWakeOptions): AgentLoopWakeOptions {
  if (!current) {
    return next;
  }
  return {
    reason: `${current.reason}；${next.reason}`,
    ...((next.triggerMessageId ?? current.triggerMessageId) ? { triggerMessageId: next.triggerMessageId ?? current.triggerMessageId } : {}),
    preferredAgentIds: [...new Set([...(current.preferredAgentIds ?? []), ...(next.preferredAgentIds ?? [])])],
    unlockProducerWaits: Boolean(current.unlockProducerWaits || next.unlockProducerWaits),
    unlockRetryableFailures: Boolean(current.unlockRetryableFailures || next.unlockRetryableFailures)
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
