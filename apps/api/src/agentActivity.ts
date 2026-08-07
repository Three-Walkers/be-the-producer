import { randomUUID } from "node:crypto";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type {
  AgentActivity,
  AgentActivityKind,
  AgentActivityStatus,
  AgentActivityStep,
  AgentId,
  StudioMessage
} from "@game-pipeline/shared-schemas";
import type { AgentHarnessProgressEvent } from "./agentHarness.js";
import type { ModelRequestActivity } from "./modelClient.js";

export interface AgentActivityReporterInput {
  roomId: string;
  agentId: AgentId;
  kind: AgentActivityKind;
  taskId?: string;
  triggerMessageId?: string;
  onChange?: () => void | Promise<void>;
}

export class AgentActivityReporter {
  private activity: AgentActivity;
  private toolSequence = 0;

  constructor(private readonly kernel: StudioKernel, private readonly input: AgentActivityReporterInput) {
    const now = new Date().toISOString();
    const label = input.kind === "task_execution" ? "读取任务与验收标准" : "读取房间上下文";
    this.activity = {
      activityId: `activity_${randomUUID()}`,
      projectId: kernel.project.projectId,
      roomId: input.roomId,
      agentId: input.agentId,
      kind: input.kind,
      status: input.kind === "task_execution" ? "working" : "thinking",
      label,
      progressPercent: 8,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      steps: [createStep("context", label, 8, "active", now)],
      startedAt: now,
      updatedAt: now
    };
    this.persist();
  }

  get activityId(): string {
    return this.activity.activityId;
  }

  transition(
    phase: string,
    label: string,
    progressPercent: number,
    status: AgentActivityStatus,
    detail?: string
  ): void {
    const now = new Date().toISOString();
    const progress = Math.max(this.activity.progressPercent, Math.min(99, Math.round(progressPercent)));
    const current = this.activity.steps.at(-1);
    if (current?.phase === phase) {
      current.label = label;
      current.progressPercent = progress;
      current.status = status === "failed" ? "failed" : "active";
      if (detail) current.detail = detail;
    } else {
      if (current?.status === "active") current.status = "completed";
      this.activity.steps.push(createStep(phase, label, progress, status === "failed" ? "failed" : "active", now, detail));
    }
    this.activity = {
      ...this.activity,
      status,
      label,
      ...(detail ? { detail } : {}),
      progressPercent: progress,
      updatedAt: now
    };
    this.persist();
  }

  onModelActivity(event: ModelRequestActivity): void {
    switch (event.type) {
      case "request_started":
        this.transition("model_request", "已向模型提交请求", 24, "thinking", `${event.providerId} · ${event.model}`);
        break;
      case "response_headers":
        this.transition("model_connected", "模型已响应，正在处理上下文", 42, "thinking", event.providerRequestId);
        break;
      case "first_output":
        this.transition("model_output", "模型正在生成答复", 64, this.activity.kind === "task_execution" ? "working" : "thinking");
        break;
      case "response_completed":
        this.transition("model_complete", "模型输出完成，正在整理结果", 82, "finalizing");
        break;
      case "request_failed":
        this.transition("model_failed", "模型请求失败", 99, "failed", event.failureKind ?? "unknown");
        break;
    }
  }

  onHarnessProgress(event: AgentHarnessProgressEvent): void {
    switch (event.type) {
      case "started":
        this.transition("harness_start", "启动角色工作会话", 18, "working", event.resumed ? "恢复已有 session" : "创建本轮 session");
        break;
      case "model_output":
        this.transition("harness_model", "模型正在分析并执行", 38, "working");
        break;
      case "tool_started":
        this.toolSequence += 1;
        this.transition(`tool_${this.toolSequence}_start`, `正在执行工具：${event.toolName ?? "unknown"}`, event.progressPercent ?? 52, "tool_call", event.path);
        break;
      case "tool_completed":
        this.toolSequence += 1;
        this.transition(`tool_${this.toolSequence}_done`, `工具执行完成：${event.toolName ?? "unknown"}`, event.progressPercent ?? 72, "tool_call", event.path);
        break;
      case "completed":
        this.transition("harness_complete", "工作会话已返回，正在核对产物证据", 88, "finalizing");
        break;
      case "failed":
        this.transition("harness_failed", "角色工作会话失败", 99, "failed", event.detail);
        break;
    }
  }

  attachToMessage(message: StudioMessage): void {
    message.metadata = {
      ...message.metadata,
      activityId: this.activity.activityId,
      activityKind: this.activity.kind,
      activityStartedAt: this.activity.startedAt,
      activityTimeline: this.timeline()
    };
  }

  fail(label: string, detail?: string): void {
    this.transition("failed", label, 99, "failed", detail);
  }

  timeline(): AgentActivityStep[] {
    return this.activity.steps.map((step) => ({ ...step }));
  }

  private persist(): void {
    this.kernel.upsertAgentActivity(this.activity);
    try {
      const pending = this.input.onChange?.();
      if (pending && typeof pending.catch === "function") {
        void pending.catch(() => undefined);
      }
    } catch {
      // Activity telemetry must never break the Agent invocation it describes.
    }
  }
}

export function recordServerToolActivity(
  kernel: StudioKernel,
  message: StudioMessage,
  event: { type: "started" | "completed" | "failed"; toolName: string; path?: string; progressPercent?: number }
): void {
  const activityId = stringMetadata(message, "activityId");
  if (!activityId) return;
  const activity = kernel.listAgentActivities().find((candidate) => candidate.activityId === activityId);
  if (!activity) return;
  const now = new Date().toISOString();
  const current = activity.steps.at(-1);
  if (current?.status === "active") current.status = "completed";
  const progress = Math.max(activity.progressPercent, event.progressPercent ?? (event.type === "started" ? 86 : 94));
  const status = event.type === "failed" ? "failed" : "active";
  activity.steps.push(createStep(
    `server_tool_${activity.steps.length}_${event.type}`,
    event.type === "started"
      ? `服务端正在执行：${event.toolName}`
      : event.type === "completed"
        ? `服务端工具完成：${event.toolName}`
        : `服务端工具失败：${event.toolName}`,
    progress,
    status,
    now,
    event.path
  ));
  activity.status = event.type === "failed" ? "failed" : "tool_call";
  activity.label = activity.steps.at(-1)?.label ?? activity.label;
  if (event.path) {
    activity.detail = event.path;
  } else {
    delete activity.detail;
  }
  activity.progressPercent = progress;
  activity.updatedAt = now;
  kernel.upsertAgentActivity(activity);
  message.metadata.activityTimeline = activity.steps.map((step) => ({ ...step }));
}

export function finalizeMessageActivity(kernel: StudioKernel, message: StudioMessage): void {
  const activityId = stringMetadata(message, "activityId");
  if (!activityId) return;
  const activity = kernel.listAgentActivities().find((candidate) => candidate.activityId === activityId);
  if (!activity) return;
  const now = new Date().toISOString();
  const current = activity.steps.at(-1);
  if (current?.status === "active") current.status = message.metadata.failure === true ? "failed" : "completed";
  const failed = message.metadata.failure === true || activity.status === "failed";
  activity.steps.push(createStep(
    failed ? "result_failed" : "result_recorded",
    failed
      ? "失败信息已记录，可重试或检查配置"
      : activity.kind === "task_execution"
        ? "本轮产物与执行结果已记录"
        : "答复已发送",
    100,
    failed ? "failed" : "completed",
    now
  ));
  message.metadata = {
    ...message.metadata,
    activityKind: activity.kind,
    activityStartedAt: activity.startedAt,
    activityCompletedAt: now,
    activityTimeline: activity.steps.map((step) => ({ ...step }))
  };
  kernel.removeAgentActivity(activityId);
}

function createStep(
  phase: string,
  label: string,
  progressPercent: number,
  status: AgentActivityStep["status"],
  createdAt: string,
  detail?: string
): AgentActivityStep {
  return {
    stepId: `activity_step_${randomUUID()}`,
    phase,
    label,
    ...(detail ? { detail } : {}),
    status,
    progressPercent,
    createdAt
  };
}

function stringMetadata(message: StudioMessage, key: string): string | undefined {
  const value = message.metadata[key];
  return typeof value === "string" && value ? value : undefined;
}
