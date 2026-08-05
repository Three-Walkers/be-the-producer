import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContract, AgentLoopControl } from "@game-pipeline/shared-schemas";
import type { AgentHarness, AgentHarnessRunInput, AgentHarnessRunResult, AgentHarnessStatus, AgentHarnessToolOperation } from "./agentHarness.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";

const defaultTimeoutMs = 20 * 60 * 1000;
const defaultInitialProgressTimeoutMs = 3 * 60 * 1000;
const defaultIdleAfterProgressMs = 2 * 60 * 1000;
const defaultSettleAfterExpectedOutputsMs = 2 * 60 * 1000;

export interface ClaudeCliHarnessOptions {
  timeoutMs?: number;
  initialProgressTimeoutMs?: number;
  idleAfterProgressMs?: number;
  settleAfterExpectedOutputsMs?: number;
}

export class ClaudeSessionResumeError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeSessionResumeError";
    this.sessionId = sessionId;
  }
}

export type ClaudeCliTimeoutKind = "overall" | "idle" | "initial_progress";

export class ClaudeCliTimeoutError extends Error {
  readonly kind: ClaudeCliTimeoutKind;
  readonly timeoutMs: number;

  constructor(kind: ClaudeCliTimeoutKind, timeoutMs: number, message: string) {
    super(message);
    this.name = "ClaudeCliTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

export class ClaudeCliHarness implements AgentHarness {
  readonly harnessId = "claude-cli" as const;

  constructor(private readonly options: ClaudeCliHarnessOptions = {}) {}

  async status(): Promise<AgentHarnessStatus> {
    const testedAt = new Date().toISOString();
    try {
      const result = await runProcess(resolveClaudeExecutable(), ["--version"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 15_000
      });
      const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).find(Boolean) ?? "unknown";
      return {
        harnessId: this.harnessId,
        label: "Claude Code CLI",
        available: true,
        version,
        executable: resolveClaudeExecutable(),
        message: `Claude Code CLI 可用：${version}`,
        testedAt
      };
    } catch (error) {
      return {
        harnessId: this.harnessId,
        label: "Claude Code CLI",
        available: false,
        executable: resolveClaudeExecutable(),
        message: `Claude Code CLI 不可用：${error instanceof Error ? error.message : String(error)}`,
        testedAt
      };
    }
  }

  async run(input: AgentHarnessRunInput): Promise<AgentHarnessRunResult> {
    assertClaudeCompatibleProvider(input);
    const invocationId = `inv_${randomUUID()}`;
    const configDir = join(input.projectRoot, ".be-the-producer", "harness", input.agent.agentId);
    const controlPath = join(configDir, `control-${invocationId}.json`);
    const operationLogPath = join(configDir, `operations-${invocationId}.jsonl`);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    const args = [
      "--print",
      "--bare",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      claudeToolsForAgent(input.agent, input.toolMode ?? "task").join(","),
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig(input, controlPath, operationLogPath),
      "--model",
      input.model,
      "--name",
      safeSessionName(input.sessionKey ?? `btp-${input.projectId}-${input.agent.agentId}`),
      "--append-system-prompt",
      input.systemPrompt
    ];
    if (input.includePartialMessages) {
      args.push("--include-partial-messages");
    }
    if (input.effort) {
      args.push("--effort", input.effort);
    }
    if (input.sessionId) {
      args.push("--resume", input.sessionId);
    }

    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(resolveClaudeExecutable(), args, {
        cwd: input.projectRoot,
        env: claudeEnvironment(input, configDir),
        stdin: input.userPrompt,
        timeoutMs: input.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs,
        ...(input.idleTimeoutMs ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
        ...(input.requireToolProgress === false
          ? {}
          : {
              progress: {
                operationLogPath,
                projectRoot: input.projectRoot,
                expectedPaths: input.expectedPaths ?? [],
                initialProgressTimeoutMs: this.options.initialProgressTimeoutMs ?? defaultInitialProgressTimeoutMs,
                idleAfterProgressMs: this.options.idleAfterProgressMs ?? defaultIdleAfterProgressMs,
                settleAfterExpectedOutputsMs: this.options.settleAfterExpectedOutputsMs ?? defaultSettleAfterExpectedOutputsMs
              }
            }),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
    } catch (error) {
      if (input.sessionId && isRecoverableResumeFailure(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ClaudeSessionResumeError(input.sessionId, `Claude CLI --resume ${input.sessionId} 失败：${detail}`, {
          cause: error
        });
      }
      throw error;
    }
    const parsed = parseStreamJson(result.stdout);
    const loopControl = readLoopControl(controlPath);
    const toolOperations = readToolOperations(operationLogPath);
    const changedPaths = [...new Set(toolOperations.map((operation) => operation.path))];
    if (!parsed.content.trim() && !result.terminationReason) {
      const error = new Error(`Claude CLI 没有返回可读取内容。${compactProcessError(result.stderr)}`);
      if (input.sessionId) {
        throw new ClaudeSessionResumeError(input.sessionId, `Claude CLI --resume ${input.sessionId} 失败：${error.message}`, {
          cause: error
        });
      }
      throw error;
    }
    const content = parsed.content.trim() || `Claude CLI 已通过工具写入 ${changedPaths.length} 个文件，调度器已收束本轮并保留产物证据。`;

    return {
      harnessId: this.harnessId,
      invocationId,
      content,
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : input.sessionId ? { sessionId: input.sessionId } : {}),
      resumeAttempted: Boolean(input.sessionId),
      resumed: Boolean(input.sessionId && (parsed.sessionId || result.terminationReason)),
      model: input.model,
      providerId: input.provider.providerId,
      latencyMs: Date.now() - startedAt,
      ...(result.firstOutputMs !== undefined ? { firstOutputMs: result.firstOutputMs } : {}),
      rawEventCount: parsed.eventCount,
      changedPaths,
      toolOperations,
      ...(loopControl ? { loopControl } : {}),
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {})
    };
  }
}

export const claudeCliHarness = new ClaudeCliHarness();

function assertClaudeCompatibleProvider(input: AgentHarnessRunInput): void {
  if (!input.provider.apiKey) {
    throw new Error(`${input.provider.label} API key 未配置。`);
  }
  if (input.provider.protocol !== "anthropic") {
    throw new Error(`Claude CLI 需要 Anthropic-compatible 连接；当前 ${input.provider.label} 使用 ${input.provider.protocol}。`);
  }
  if (!input.provider.baseUrl.trim()) {
    throw new Error(`${input.provider.label} Base URL 未配置。`);
  }
  if (!input.model.trim()) {
    throw new Error(`${input.provider.label} 模型名未配置。`);
  }
}

function claudeToolsForAgent(agent: AgentContract, mode: "conversation" | "task"): string[] {
  if (mode === "conversation") {
    return ["Read", "Glob", "Grep"];
  }
  const tools = [
    "Read",
    "Glob",
    "Grep",
    "mcp__btp_workspace__write_artifact",
    "mcp__btp_workspace__append_document",
    "mcp__btp_workspace__list_files",
    "mcp__btp_workspace__report_task_status"
  ];
  if (["art_director", "asset_production"].includes(agent.agentId)) {
    tools.push("mcp__btp_workspace__render_svg_to_png");
  }
  if (["coding", "evaluation"].includes(agent.modelProfile.capability) || ["devops", "wechat_platform", "cocos_automation"].includes(agent.agentId)) {
    tools.push("mcp__btp_workspace__run_project_check");
  }
  if (agent.agentId === "qa_evaluator") {
    tools.push("mcp__btp_workspace__run_playtest");
  }
  if (agent.agentId === "cocos_automation") {
    tools.push(
      "mcp__btp_workspace__cocos_validate_project",
      "mcp__btp_workspace__cocos_import_assets",
      "mcp__btp_workspace__cocos_apply_blueprint",
      "mcp__btp_workspace__cocos_build"
    );
  }
  return tools;
}

function mcpConfig(input: AgentHarnessRunInput, controlPath: string, operationLogPath: string): string {
  const cocosConfig = cocosEngineSettingsStore.getResolvedConfig();
  return JSON.stringify({
    mcpServers: {
      btp_workspace: {
        type: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./harnessMcpServer.js", import.meta.url))],
        env: {
          BTP_PROJECT_ROOT: input.projectRoot,
          BTP_AGENT_ID: input.agent.agentId,
          BTP_SESSION_KEY: input.sessionKey ?? "",
          BTP_SESSION_SCOPE: input.sessionScope ?? "room",
          BTP_ALLOWED_ROOTS: JSON.stringify(input.allowedRoots ?? [input.agent.workspace.replace(/\/+$/, "")]),
          BTP_EXPECTED_PATHS: JSON.stringify(input.expectedPaths ?? []),
          BTP_CONTROL_PATH: controlPath,
          BTP_OPERATION_LOG_PATH: operationLogPath,
          BTP_COCOS_EXECUTABLE: cocosConfig.executablePath,
          BTP_COCOS_VERSION: cocosConfig.version,
          BTP_COCOS_PLATFORM: cocosConfig.platform,
          BTP_COCOS_BUILD_CONFIG: cocosConfig.buildConfigPath,
          BTP_COCOS_TIMEOUT_MS: String(cocosConfig.timeoutMs),
          BTP_ALLOW_PROJECT_CHECKS: String(
            ["coding", "evaluation"].includes(input.agent.modelProfile.capability) || ["devops", "wechat_platform", "cocos_automation"].includes(input.agent.agentId)
          )
        }
      }
    }
  });
}

function readToolOperations(operationLogPath: string): AgentHarnessToolOperation[] {
  if (!existsSync(operationLogPath)) {
    return [];
  }
  try {
    const operations = readFileSync(operationLogPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed.path !== "string" || !parsed.path.trim() || typeof parsed.toolName !== "string") {
            return [];
          }
          return [{
            toolName: parsed.toolName,
            path: parsed.path.trim(),
            ...(typeof parsed.hash === "string" ? { hash: parsed.hash } : {}),
            ...(typeof parsed.sizeBytes === "number" ? { sizeBytes: parsed.sizeBytes } : {}),
            ...(typeof parsed.recordedAt === "string" ? { recordedAt: parsed.recordedAt } : {})
          } satisfies AgentHarnessToolOperation];
        } catch {
          return [];
        }
      });
    return operations;
  } finally {
    try {
      unlinkSync(operationLogPath);
    } catch {
      // The operation trace is consumed once by the parent Harness process.
    }
  }
}

function readLoopControl(controlPath: string): AgentLoopControl | undefined {
  if (!existsSync(controlPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(controlPath, "utf8")) as Partial<AgentLoopControl>;
    const statuses = new Set<AgentLoopControl["status"]>([
      "continue",
      "waiting_for_producer",
      "handoff",
      "ready_for_review",
      "blocked"
    ]);
    if (!parsed.status || !statuses.has(parsed.status) || typeof parsed.reason !== "string" || !parsed.reason.trim()) {
      return undefined;
    }
    return {
      status: parsed.status,
      reason: parsed.reason.trim(),
      handoffAgentIds: Array.isArray(parsed.handoffAgentIds)
        ? parsed.handoffAgentIds.filter((agentId): agentId is string => typeof agentId === "string" && Boolean(agentId.trim()))
        : []
    };
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(controlPath);
    } catch {
      // The status report is best-effort cleanup inside the isolated Harness directory.
    }
  }
}

function claudeEnvironment(input: AgentHarnessRunInput, configDir: string): NodeJS.ProcessEnv {
  const key = input.provider.apiKey ?? "";
  return {
    ...process.env,
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_BASE_URL: input.provider.baseUrl.replace(/\/+$/, ""),
    ANTHROPIC_MODEL: input.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.model,
    CLAUDE_CODE_SUBAGENT_MODEL: input.model,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1"
  };
}

function resolveClaudeExecutable(): string {
  return process.env.CLAUDE_CLI_PATH?.trim() || "claude";
}

function safeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

function isRecoverableResumeFailure(error: unknown): boolean {
  if (error instanceof ClaudeCliTimeoutError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/暂停|取消|abort/i.test(message)) return false;
  if (/API key|认证|unauthorized|forbidden|余额|rate.?limit/i.test(message)) return false;
  return /(?:resume|session|conversation).{0,100}(?:not found|does not exist|cannot be resumed|invalid|expired)|(?:找不到|不存在|失效|无法恢复).{0,40}(?:会话|session)|(?:会话|session).{0,40}(?:找不到|不存在|失效|无法恢复)/i.test(message);
}

function parseStreamJson(stdout: string): { content: string; sessionId?: string; eventCount: number } {
  let sessionId: string | undefined;
  let resultContent = "";
  const assistantParts: string[] = [];
  let eventCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    eventCount += 1;
    sessionId ??= findStringField(event, "session_id");
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === "result" && typeof event.result === "string") {
      resultContent = event.result;
    }
    if (event.type === "assistant") {
      assistantParts.push(...extractTextParts(event.message));
    }
  }
  const content = resultContent.trim() || assistantParts.join("\n").trim();
  return {
    content,
    ...(sessionId ? { sessionId } : {}),
    eventCount
  };
}

function extractTextParts(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return [];
  }
  return value.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text));
}

function findStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value[key] === "string") {
    return value[key] as string;
  }
  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      const found = findStringField(child, key);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
  progress?: {
    operationLogPath: string;
    projectRoot: string;
    expectedPaths: string[];
    initialProgressTimeoutMs: number;
    idleAfterProgressMs: number;
    settleAfterExpectedOutputsMs: number;
  };
}

type ProcessTerminationReason = NonNullable<AgentHarnessRunResult["terminationReason"]>;

function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<{ stdout: string; stderr: string; terminationReason?: ProcessTerminationReason; firstOutputMs?: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let requestedTermination: ProcessTerminationReason | undefined;
    let requestedError: Error | undefined;
    let lastProgressSignature = "";
    let lastProgressAt = 0;
    let progressDetected = false;
    let firstOutputMs: number | undefined;
    let timeout: NodeJS.Timeout;
    let idleTimeout: NodeJS.Timeout | undefined;
    let initialProgressTimeout: NodeJS.Timeout | undefined;
    let progressPoll: NodeJS.Timeout | undefined;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      if (initialProgressTimeout) {
        clearTimeout(initialProgressTimeout);
      }
      if (progressPoll) {
        clearInterval(progressPoll);
      }
      options.abortSignal?.removeEventListener("abort", abort);
      callback();
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    };
    const abort = (): void => {
      requestedError = new Error("Agent Harness 已被暂停或取消。");
      terminate();
    };
    const requestProgressTermination = (reason: ProcessTerminationReason): void => {
      if (requestedTermination || requestedError || settled) {
        return;
      }
      requestedTermination = reason;
      terminate();
    };
    const requestTimeout = (kind: ClaudeCliTimeoutKind, timeoutMs: number): void => {
      if (requestedTermination || requestedError || settled) {
        return;
      }
      if (hasRecordedProgress(options.progress?.operationLogPath)) {
        requestProgressTermination("timeout_with_progress");
        return;
      }
      const completionDetail = options.progress ? "且没有产生工具写入" : "且未完成回复";
      const detail = kind === "idle"
        ? `Claude CLI 连续 ${formatTimeout(timeoutMs)} 没有输出活动，已终止。`
        : kind === "initial_progress"
          ? `Claude CLI 在 ${formatTimeout(timeoutMs)} 内没有产生工具写入，已停止本轮。`
          : `Claude CLI 执行超过 ${formatTimeout(timeoutMs)}（总时限）${completionDetail}，已终止。`;
      requestedError = new ClaudeCliTimeoutError(kind, timeoutMs, detail);
      terminate();
    };
    const resetIdleTimeout = (): void => {
      const idleTimeoutMs = options.idleTimeoutMs;
      if (!idleTimeoutMs || settled) return;
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => requestTimeout("idle", idleTimeoutMs), idleTimeoutMs);
    };
    timeout = setTimeout(() => {
      requestTimeout("overall", options.timeoutMs);
    }, options.timeoutMs);
    resetIdleTimeout();
    const progress = options.progress;
    if (progress) {
      initialProgressTimeout = setTimeout(() => {
        if (progressDetected || hasRecordedProgress(progress.operationLogPath)) {
          return;
        }
        requestTimeout("initial_progress", progress.initialProgressTimeoutMs);
      }, progress.initialProgressTimeoutMs);
      progressPoll = setInterval(() => {
        const signature = progressSignature(progress.operationLogPath);
        if (signature && signature !== lastProgressSignature) {
          lastProgressSignature = signature;
          lastProgressAt = Date.now();
          progressDetected = true;
          resetIdleTimeout();
          if (initialProgressTimeout) {
            clearTimeout(initialProgressTimeout);
            initialProgressTimeout = undefined;
          }
        }
        if (!progressDetected || lastProgressAt === 0) {
          return;
        }
        const elapsed = Date.now() - lastProgressAt;
        if (expectedOutputsExist(progress)) {
          if (elapsed >= progress.settleAfterExpectedOutputsMs) {
            requestProgressTermination("expected_outputs_materialized");
          }
          return;
        }
        if (elapsed >= progress.idleAfterProgressMs) {
          requestProgressTermination("idle_after_progress");
        }
      }, Math.min(500, Math.max(25, Math.round(progress.settleAfterExpectedOutputsMs / 2))));
      progressPoll.unref();
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      firstOutputMs ??= Date.now() - startedAt;
      stdout += chunk;
      resetIdleTimeout();
    });
    child.stderr.on("data", (chunk: string) => {
      firstOutputMs ??= Date.now() - startedAt;
      stderr += chunk;
      resetIdleTimeout();
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (requestedError) {
          reject(requestedError);
          return;
        }
        if (requestedTermination) {
          resolve({ stdout, stderr, terminationReason: requestedTermination, ...(firstOutputMs !== undefined ? { firstOutputMs } : {}) });
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr, ...(firstOutputMs !== undefined ? { firstOutputMs } : {}) });
          return;
        }
        if (hasRecordedProgress(options.progress?.operationLogPath)) {
          resolve({ stdout, stderr, terminationReason: "process_exit_with_progress", ...(firstOutputMs !== undefined ? { firstOutputMs } : {}) });
          return;
        }
        reject(new Error(`Claude CLI 退出异常（code=${code ?? "null"}, signal=${signal ?? "none"}）：${compactProcessError(stderr || stdout)}`));
      });
    });
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    if (options.abortSignal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(options.stdin ?? "");
  });
}

function progressSignature(path: string | undefined): string {
  if (!path || !existsSync(path)) {
    return "";
  }
  const stats = statSync(path);
  return stats.isFile() && stats.size > 0 ? `${stats.size}:${stats.mtimeMs}` : "";
}

function hasRecordedProgress(path: string | undefined): boolean {
  return Boolean(progressSignature(path));
}

function expectedOutputsExist(progress: NonNullable<ProcessOptions["progress"]>): boolean {
  return progress.expectedPaths.length > 0 && progress.expectedPaths.every((path) => existsSync(join(progress.projectRoot, path)));
}

function compactProcessError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 60_000) {
    return `${Math.max(1, Math.round(timeoutMs / 1_000))} 秒`;
  }
  return `${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
