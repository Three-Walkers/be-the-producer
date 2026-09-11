import type {
  AgentId,
  AgentLoopControl,
  AgentLoopState,
  StudioMessage,
  Task,
  TaskId
} from "@game-pipeline/shared-schemas";
import { workflowTaskStages, type StudioKernel } from "@game-pipeline/agent-runtime";
import { finalizeTaskSessionProtocol, ModelAgentRuntime } from "./modelAgentRuntime.js";
import { executeAgentToolRequests, type ToolExecutionResult } from "./toolExecutor.js";
import { artifactReadyForConsumption, artifactReadyForTaskCompletion, taskOutputsVerified } from "./taskOutputEvidence.js";
import { resumeQaTasksAfterVerifiedRepairs } from "./qaRepairFlow.js";
import { finalizeMessageActivity, recordServerToolActivity } from "./agentActivity.js";
import { implementationReportNeedsRefresh } from "./implementationReview.js";

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
const handoffFeedbackPattern = /\n?\[HANDOFF_EVIDENCE_REPAIR\][\s\S]*?\[\/HANDOFF_EVIDENCE_REPAIR\]/g;

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
    const inFlight = new Map<TaskId, {
      task: Task;
      controller: AbortController;
      inputs: string;
      superseded: boolean;
      completion: Promise<{ taskId: TaskId; error?: unknown }>;
    }>();
    const cancelSupersededInputs = (kernel: StudioKernel) => {
      for (const entry of inFlight.values()) {
        const currentTask = kernel.findTask(entry.task.taskId);
        if (!entry.superseded && (!currentTask || taskInputRevision(kernel, currentTask) !== entry.inputs)) {
          entry.superseded = true;
          entry.controller.abort(new Error("上游输入已更新，取消旧快照任务并重新排队。"));
        }
      }
    };
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
        resumeSupersededImplementationTasks(kernel);
        advanceVerifiedTasksToReview(kernel);
        cancelSupersededInputs(kernel);

        const occupiedAgents = new Set([...inFlight.values()].map((entry) => entry.task.ownerAgentId));
        const candidates = selectRunnableTasks(kernel, options.preferredAgentIds).filter((task) => {
          if (inFlight.has(task.taskId) || occupiedAgents.has(task.ownerAgentId)) return false;
          occupiedAgents.add(task.ownerAgentId);
          return true;
        }).slice(0, Math.max(0, maxParallelAgents - inFlight.size));
        if (candidates.length === 0 && inFlight.size === 0) {
          settleWithoutRunnableTasks(kernel);
          this.dependencies.checkpoint(kernel);
          return;
        }

        rounds += 1;
        const iteration = kernel.getAgentLoopState().iteration + (candidates.length > 0 ? 1 : 0);
        const now = new Date().toISOString();
        kernel.updateAgentLoop({
          status: "running",
          iteration,
          activeAgentIds: [...inFlight.values()].map((entry) => entry.task.ownerAgentId).concat(candidates.map((task) => task.ownerAgentId)),
          pendingTaskIds: [...inFlight.keys(), ...candidates.map((task) => task.taskId)],
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

        for (const task of candidates) {
          const controller = new AbortController();
          const inputs = taskInputRevision(kernel, task);
          const relayAbort = () => controller.abort(active.abortController.signal.reason);
          active.abortController.signal.addEventListener("abort", relayAbort, { once: true });
          if (active.abortController.signal.aborted) relayAbort();
          const inputsAreCurrent = () => {
            const currentTask = kernel.findTask(task.taskId);
            return Boolean(currentTask && taskInputRevision(kernel, currentTask) === inputs);
          };
          const execution = (async () => {
            const message = await this.dependencies.modelRuntime.respondToTask(kernel, task, {
              iteration,
              abortSignal: controller.signal,
              inputsAreCurrent,
              onAgentActivity: () => {
                cancelSupersededInputs(kernel);
                this.dependencies.checkpoint(kernel);
              },
              ...(options.triggerMessageId ? { triggerMessageId: options.triggerMessageId } : {})
            });
            cancelSupersededInputs(kernel);
            if (controller.signal.aborted || !inputsAreCurrent() || this.activeRuns.get(projectId)?.generation !== generation || kernel.project.executionStatus !== "running") return;
            kernel.recordMessage(message);
            await executeAgentToolRequests(kernel, [message], {
              onActivity: (toolMessage, event) => {
                recordServerToolActivity(kernel, toolMessage, event);
                this.dependencies.checkpoint(kernel);
              }
            });
            if (this.activeRuns.get(projectId)?.generation !== generation || kernel.project.executionStatus !== "running") return;
            finalizeMessageActivity(kernel, message);
            applyTaskOutcome(kernel, task, message, noProgressCounts, failureCounts);
            finalizeTaskSessionProtocol(kernel, kernel.findTask(task.taskId) ?? task, message);
            // Publish each completed task immediately, not after the slowest sibling.
            const pendingTaskIds = kernel.getAgentLoopState().pendingTaskIds.filter((id) => id !== task.taskId);
            kernel.updateAgentLoop({
              pendingTaskIds,
              activeAgentIds: [...new Set(pendingTaskIds.map((id) => kernel.findTask(id)?.ownerAgentId).filter((id): id is AgentId => Boolean(id)))],
              updatedAt: new Date().toISOString()
            });
            this.dependencies.checkpoint(kernel);
          })();
          // Observe all rejections immediately while waiting only for the first
          // free slot, so a fast branch can launch its downstream work without
          // waiting for an unrelated slow specialist.
          inFlight.set(task.taskId, { task, controller, inputs, superseded: false, completion: execution.finally(() => {
            active.abortController.signal.removeEventListener("abort", relayAbort);
          }).then(
            () => ({ taskId: task.taskId }),
            (error: unknown) => ({ taskId: task.taskId, error })
          ) });
        }
        const finished = await Promise.race([...inFlight.values()].map((entry) => entry.completion));
        const completedEntry = inFlight.get(finished.taskId);
        inFlight.delete(finished.taskId);
        if (finished.error !== undefined && !completedEntry?.superseded) throw finished.error;

        const current = this.activeRuns.get(projectId);
        if (!current || current.generation !== generation || kernel.project.executionStatus !== "running") {
          return;
        }

        if (completedEntry?.superseded) {
          // Cancellation is not a model failure or a product verdict. Keep the
          // role slot until the worker settles, then retry against fresh inputs.
          noProgressCounts.delete(finished.taskId);
          failureCounts.delete(finished.taskId);
          for (const activity of kernel.listAgentActivities()) {
            if (activity.taskId === finished.taskId) kernel.removeAgentActivity(activity.activityId);
          }
          kernel.updateAgentLoopAgent(completedEntry.task.ownerAgentId, {
            status: "queued", lastError: undefined, updatedAt: new Date().toISOString()
          });
        }

        advanceVerifiedTasksToReview(kernel);
        kernel.updateAgentLoop({
          activeAgentIds: [...inFlight.values()].map((entry) => entry.task.ownerAgentId),
          pendingTaskIds: [...inFlight.keys()],
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
      const active = this.activeRuns.get(projectId);
      if (!active || active.generation !== generation) return;
      active.abortController.abort();
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

/** Ignore status-only feedback: a negative review legitimately marks its own
 * inputs change_requested. Only an actual input identity/revision change makes
 * an isolated workspace obsolete. Never track a task's own in-place outputs. */
function taskInputRevision(kernel: StudioKernel, task: Task): string {
  return JSON.stringify([...new Set(task.inputArtifacts)].filter((id) => !task.outputArtifacts.includes(id)).sort().map((id) => {
    const artifact = kernel.listArtifacts().find((entry) => entry.artifactId === id);
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === id);
    return [id, artifact?.version, artifact?.path, ledger?.path, ledger?.hash, ledger?.sizeBytes, ledger?.directoryManifest?.digest];
  }));
}

export function resumeSupersededImplementationTasks(kernel: StudioKernel): void {
  for (const taskId of ["task_stage_2_cocos_implementation", "task_stage_2_qa_implementation_review"]) {
    const task = kernel.findTask(taskId);
    if (!task || task.stageId !== kernel.project.currentStage || !["review", "blocked"].includes(task.status)) continue;
    // Product waits and real failures need their own resolution. This path only
    // recovers an obsolete verifier receipt, never an arbitrary blocked task.
    if (task.blockers.some((blocker) => blocker !== `${loopBlockerPrefix}Agent 请求评审，但任务输出尚未全部通过 Artifact Ledger 验证。`)) continue;
    if (!inputArtifactsVerified(kernel, task)) continue;
    const reports = kernel.listArtifacts().filter((artifact) => task.outputArtifacts.includes(artifact.artifactId));
    if (!reports.some((artifact) => implementationReportNeedsRefresh(kernel, artifact))) continue;
    kernel.updateTask(task.taskId, { status: "doing", progressPercent: 65, blockers: [], updatedAt: new Date().toISOString() });
    kernel.updateAgentLoopAgent(task.ownerAgentId, { status: "queued", taskId: task.taskId, lastError: undefined, updatedAt: new Date().toISOString() });
  }
}

function selectRunnableTasks(kernel: StudioKernel, preferredAgentIds: AgentId[] = []): Task[] {
  const preferred = new Set(preferredAgentIds);
  const executionStages = taskExecutionStages(kernel);
  return kernel
    .listTasks()
    .filter(
      (task) =>
        executionStages.has(task.stageId) &&
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
  return task.inputArtifacts.every((artifactId) => artifactReadyForConsumption(kernel, artifactId));
}

function advanceVerifiedTasksToReview(kernel: StudioKernel): void {
  const executionStages = taskExecutionStages(kernel);
  for (const task of kernel.listTasks()) {
    if (!executionStages.has(task.stageId) || task.taskLevel === "task_group" || !taskOutputsVerified(kernel, task)) {
      continue;
    }
    const description = task.description.replace(handoffFeedbackPattern, "");
    if (description !== task.description) kernel.updateTask(task.taskId, { description });
    const now = new Date().toISOString();
    const advancedToReview = ["todo", "doing"].includes(task.status);
    if (advancedToReview) {
      kernel.updateTask(task.taskId, {
        status: "review",
        progressPercent: 90,
        blockers: [],
        updatedAt: now
      });
    }
    const agentState = kernel.getAgentLoopState().agents[task.ownerAgentId];
    if (
      (advancedToReview || ["review", "done"].includes(task.status)) &&
      agentState?.taskId === task.taskId &&
      agentState.status !== "working"
    ) {
      kernel.updateAgentLoopAgent(task.ownerAgentId, {
        status: "waiting",
        taskId: task.taskId,
        lastError: undefined,
        updatedAt: now
      });
    }
  }
}

function unlockTasksWaitingForProducer(kernel: StudioKernel): void {
  const executionStages = taskExecutionStages(kernel);
  for (const task of kernel.listTasks()) {
    if (!executionStages.has(task.stageId) || task.taskLevel === "task_group") {
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
  const executionStages = taskExecutionStages(kernel);
  for (const task of kernel.listTasks()) {
    if (!executionStages.has(task.stageId) || task.taskLevel === "task_group" || task.status !== "blocked") {
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
  if (kernel.findTask(task.taskId)?.status === "done" && kernel.listClaimRepairs().some((repair) =>
    repair.taskId === task.taskId && repair.status === "resolved")) {
    // Claim verification may resolve this task while its worker is returning.
    // Its empty output list is intentional; a late loop-control reply must not
    // reopen already-verified audit work or consume retries forever.
    noProgressCounts.delete(task.taskId);
    failureCounts.delete(task.taskId);
    kernel.updateAgentLoopAgent(task.ownerAgentId, {status: "waiting", taskId: task.taskId, lastError: undefined, updatedAt: new Date().toISOString()});
    return;
  }
  const control = readLoopControl(message);
  const toolResults = readToolResults(message);
  const successfulTools = toolResults.filter((result) => result.status === "completed");
  const failedTools = toolResults.filter(
    (result) => result.status === "failed" && !toolFailureWasSuperseded(result, successfulTools)
  );
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
  // A downstream recipient cannot repair the evidence it is waiting to consume.
  // Reject this control transition before resetting the retry budget; otherwise
  // a repeated handoff can either deadlock both sides or retry without a limit.
  if (control.status === "handoff" && inputArtifactsVerified(kernel, currentTask) &&
      !taskOutputsVerified(kernel, currentTask) && handoffTargetsDownstream(kernel, currentTask, control.handoffAgentIds)) {
    const artifacts = kernel.listArtifacts();
    const missing = currentTask.outputArtifacts.filter((id) => !artifactReadyForTaskCompletion(kernel, id));
    const labels = (missing.length ? missing : currentTask.outputArtifacts).map((id) => {
      const artifact = artifacts.find((entry) => entry.artifactId === id);
      return `${id} (${artifact?.path ?? "未登记路径"}; ${artifact?.status ?? "missing"})`;
    });
    const feedback = `交接未成立：下游仍依赖本任务的未验证输出 ${labels.join("、")}。请用工具补齐或重新提交这些输出；聊天结论、清单 status 和交接声明不能替代实际证据。`;
    // lastError is cleared when a worker starts. Persist bounded feedback in the
    // task context so the next invocation actually sees what it must repair.
    kernel.updateTask(task.taskId, { description: `${currentTask.description.replace(handoffFeedbackPattern, "")}\n[HANDOFF_EVIDENCE_REPAIR]\n${feedback}\n[/HANDOFF_EVIDENCE_REPAIR]` });
    retryTransientFailure(kernel, currentTask, message, failureCounts, feedback);
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

function handoffTargetsDownstream(kernel: StudioKernel, task: Task, recipients: AgentId[]): boolean {
  const stages = taskExecutionStages(kernel);
  const tasks = kernel.listTasks().filter((candidate) => candidate.taskId !== task.taskId &&
    stages.has(candidate.stageId) && candidate.taskLevel !== "task_group" && candidate.status !== "cancelled");
  // Preserve legitimate requests to upstream authors (including mixed handoffs).
  if (tasks.some((candidate) => recipients.includes(candidate.ownerAgentId) &&
      candidate.outputArtifacts.some((id) => task.inputArtifacts.includes(id)))) return false;
  const outputs = new Set(task.outputArtifacts);
  const visited = new Set<TaskId>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of tasks) {
      if (visited.has(candidate.taskId) || !candidate.inputArtifacts.some((id) => outputs.has(id))) continue;
      if (recipients.includes(candidate.ownerAgentId)) return true;
      visited.add(candidate.taskId);
      candidate.outputArtifacts.forEach((id) => outputs.add(id));
      changed = true;
    }
  }
  return false;
}

function settleWithoutRunnableTasks(kernel: StudioKernel): void {
  const executionStages = taskExecutionStages(kernel);
  const stageTasks = kernel
    .listTasks()
    .filter((task) => executionStages.has(task.stageId) && task.taskLevel !== "task_group");
  const blocked = stageTasks.filter((task) => task.status === "blocked");
  const review = stageTasks.filter((task) => task.status === "review");
  const pendingDependencies = stageTasks.filter((task) => ["todo", "doing"].includes(task.status));
  const workBlocked = blocked.filter((task) => !task.blockers.length || task.blockers.some((blocker) =>
    !blocker.startsWith(`${loopBlockerPrefix}等待制作人`) && !/^等待制作人/.test(blocker)));
  const waitingForProducer = workBlocked.length === 0 &&
    (blocked.length > 0 || (review.length > 0 && pendingDependencies.length === 0));
  const reason = waitingForProducer
    ? review.length > 0
      ? `${review.length} 个任务已进入评审，阶段保持开放，等待制作人继续讨论或发起门禁评审。`
      : blocked.flatMap((task) => task.blockers).join("；")
    : blocked.length > 0
      ? workBlocked.flatMap((task) => task.blockers).join("；") || "存在尚未解决的任务阻塞。"
      : pendingDependencies.length > 0
        ? "剩余任务正在等待已验证的上游产物。"
        : "当前阶段没有可自动执行的角色任务，等待制作人下一步指令。";
  kernel.updateAgentLoop({
    status: waitingForProducer || (blocked.length === 0 && pendingDependencies.length === 0) ? "waiting_for_producer" : "blocked",
    activeAgentIds: [],
    pendingTaskIds: pendingDependencies.map((task) => task.taskId),
    waitingReason: reason,
    updatedAt: new Date().toISOString()
  });
}

function taskExecutionStages(kernel: StudioKernel): ReadonlySet<Task["stageId"]> {
  return new Set(workflowTaskStages(kernel.project.currentStage));
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

function toolFailureWasSuperseded(
  failure: ToolExecutionResult,
  successfulTools: ToolExecutionResult[]
): boolean {
  if (
    !failure.path ||
    (failure.toolName !== "write_artifact" && failure.toolName !== "append_document")
  ) {
    return false;
  }
  return successfulTools.some(
    (success) =>
      success.path === failure.path &&
      (success.toolName === "write_artifact" || success.toolName === "append_document")
  );
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
