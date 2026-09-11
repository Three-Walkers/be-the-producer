import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContract, AgentLoopControl } from "@game-pipeline/shared-schemas";
import type { AgentHarness, AgentHarnessProgressEvent, AgentHarnessRunInput, AgentHarnessRunResult, AgentHarnessStatus, AgentHarnessToolOperation } from "./agentHarness.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { modelSettingsStore } from "./modelSettings.js";
import { resolvePathWithinRoot } from "./pathSafety.js";

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

export type ClaudeCliProcessFailureKind =
  | "provider_terminated"
  | "provider_rate_limited"
  | "provider_overloaded"
  | "provider_timeout"
  | "authentication"
  | "session"
  | "process_exit";

export class ClaudeCliProcessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly kind: ClaudeCliProcessFailureKind;
  readonly retryable: boolean;
  readonly detail: string;

  constructor(input: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    kind: ClaudeCliProcessFailureKind;
    retryable: boolean;
    detail: string;
  }) {
    const exit = input.exitCode === null ? "未知退出码" : `退出码 ${input.exitCode}`;
    const signal = input.signal ? `，信号 ${input.signal}` : "";
    super(`Claude CLI 会话失败（${exit}${signal}）：${input.detail}`);
    this.name = "ClaudeCliProcessError";
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.detail = input.detail;
  }
}

export interface ClaudeCliFailureDiagnosis {
  kind: ClaudeCliProcessFailureKind;
  retryable: boolean;
  detail: string;
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
    if (input.authorization.mode !== (input.toolMode ?? "task")) {
      throw new Error(`Harness authorization mode=${input.authorization.mode} 与 toolMode=${input.toolMode ?? "task"} 不一致。`);
    }
    const invocationId = `inv_${randomUUID()}`;
    const configDir = join(input.stateRoot ?? input.projectRoot, ".be-the-producer", "harness", input.agent.agentId);
    const controlPath = join(configDir, `control-${invocationId}.json`);
    const operationLogPath = join(configDir, `operations-${invocationId}.jsonl`);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Claude indexes conversations by cwd. The MCP workspace is fresh per run,
    // but its control-plane cwd must stay stable for the logical session.
    const sessionCwd = input.stateRoot && input.sessionKey
      ? resolvePathWithinRoot(input.stateRoot,
        `.be-the-producer/harness/${input.agent.agentId}/session-cwd/${createHash("sha256").update(input.sessionKey).digest("hex")}`,
        { allowMissing: true, label: "Claude 会话目录" }).absolutePath
      : input.projectRoot;
    mkdirSync(sessionCwd, { recursive: true, mode: 0o700 });
    emitHarnessProgress(input, {
      type: "started",
      invocationId,
      createdAt: new Date().toISOString(),
      resumed: Boolean(input.sessionId)
    });

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
      mcpConfig(input, controlPath, operationLogPath, invocationId),
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
    let reportedToolProgressCount = 0;
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(resolveClaudeExecutable(), args, {
        cwd: sessionCwd,
        env: claudeEnvironment(input, configDir),
        stdin: input.userPrompt,
        timeoutMs: input.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs,
        ...(input.idleTimeoutMs ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
        onOutputActivity: () => {
          emitHarnessProgress(input, {
            type: "model_output",
            invocationId,
            createdAt: new Date().toISOString()
          });
        },
        ...(input.requireToolProgress === false
          ? {}
          : {
              progress: {
                operationLogPath,
                projectRoot: input.projectRoot,
                expectedPaths: input.expectedPaths ?? [],
                initialProgressTimeoutMs:
                  input.initialProgressTimeoutMs ?? this.options.initialProgressTimeoutMs ?? defaultInitialProgressTimeoutMs,
                idleAfterProgressMs: this.options.idleAfterProgressMs ?? defaultIdleAfterProgressMs,
                settleAfterExpectedOutputsMs: this.options.settleAfterExpectedOutputsMs ?? defaultSettleAfterExpectedOutputsMs,
                onOperation: (operation) => {
                  if (operation.status === "failed" || operation.bridgeOk === false) {
                    emitHarnessProgress(input, {
                      type: "tool_failed", invocationId,
                      createdAt: operation.recordedAt ?? new Date().toISOString(),
                      toolName: operation.toolName, path: operation.path,
                      detail: operation.error ?? "工具返回失败，尚未产生可用产物。"
                    });
                    return;
                  }
                  reportedToolProgressCount += 1;
                  const expectedCount = input.expectedPaths?.length ?? 0;
                  const progressPercent = expectedCount > 0
                    ? Math.min(84, Math.round(48 + (Math.min(reportedToolProgressCount, expectedCount) / expectedCount) * 36))
                    : Math.min(84, 48 + reportedToolProgressCount * 7);
                  emitHarnessProgress(input, {
                    type: "tool_completed",
                    invocationId,
                    createdAt: operation.recordedAt ?? new Date().toISOString(),
                    toolName: operation.toolName,
                    path: operation.path,
                    progressPercent
                  });
                }
              }
            }),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        diagnosticConfigDir: configDir,
        ...(input.sessionId ? { diagnosticSessionId: input.sessionId } : {})
      });
    } catch (error) {
      emitHarnessProgress(input, {
        type: "failed",
        invocationId,
        createdAt: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error)
      });
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
    const changedPaths = [
      ...new Set(
        toolOperations
          .filter((operation) => toolOperationSucceeded(operation) && operation.access !== "read")
          .map((operation) => operation.path)
      )
    ];
    if (!parsed.content.trim() && !result.terminationReason) {
      const error = new Error(`Claude CLI 没有返回可读取内容。${compactProcessError(result.stderr)}`);
      emitHarnessProgress(input, {
        type: "failed",
        invocationId,
        createdAt: new Date().toISOString(),
        detail: error.message
      });
      if (input.sessionId) {
        throw new ClaudeSessionResumeError(input.sessionId, `Claude CLI --resume ${input.sessionId} 失败：${error.message}`, {
          cause: error
        });
      }
      throw error;
    }
    const content = parsed.content.trim() || `Claude CLI 已通过工具写入 ${changedPaths.length} 个文件，调度器已收束本轮并保留产物证据。`;
    emitHarnessProgress(input, {
      type: "completed",
      invocationId,
      createdAt: new Date().toISOString(),
      ...(changedPaths.length > 0 ? { detail: `已记录 ${changedPaths.length} 个文件操作` } : {})
    });

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

function emitHarnessProgress(input: AgentHarnessRunInput, event: AgentHarnessProgressEvent): void {
  try {
    input.onProgress?.(event);
  } catch {
    // Progress telemetry is observational and must not interrupt the Harness.
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
    return ["mcp__btp_workspace__read_file", "mcp__btp_workspace__list_files"];
  }
  const tools = [
    "mcp__btp_workspace__read_file",
    "mcp__btp_workspace__write_artifact",
    "mcp__btp_workspace__append_document",
    "mcp__btp_workspace__list_files",
    "mcp__btp_workspace__report_task_status"
  ];
  if (["art_director", "asset_production"].includes(agent.agentId)) {
    tools.push("mcp__btp_workspace__render_svg_to_png");
    tools.push("mcp__btp_workspace__generate_raster_asset");
  }
  if (agent.agentId === "visual_quality_reviewer") {
    tools.push("mcp__btp_workspace__inspect_visual_assets");
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

function mcpConfig(
  input: AgentHarnessRunInput,
  controlPath: string,
  operationLogPath: string,
  invocationId: string
): string {
  const cocosConfig = cocosEngineSettingsStore.getResolvedConfig();
  const mediaEnabled =
    input.authorization.mode === "task" &&
    ["art_director", "asset_production", "visual_quality_reviewer"].includes(input.agent.agentId);
  const mediaProvider = mediaEnabled ? modelSettingsStore.getProviderConfig("dashscope") : undefined;
  const mediaOrigin = mediaProvider?.baseUrl ? new URL(mediaProvider.baseUrl).origin : undefined;
  return JSON.stringify({
    mcpServers: {
      btp_workspace: {
        type: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./harnessMcpServer.js", import.meta.url))],
        env: {
          BTP_PROJECT_ROOT: input.projectRoot,
          BTP_AGENT_ID: input.agent.agentId,
          BTP_TOOL_MODE: input.toolMode ?? "task",
          BTP_AUTHORIZATION: JSON.stringify(input.authorization),
          BTP_SESSION_KEY: input.sessionKey ?? "",
          BTP_SESSION_SCOPE: input.sessionScope ?? "room",
          BTP_TASK_INPUT_EVIDENCE: JSON.stringify(input.taskInputEvidence ?? []),
          BTP_CONTROL_PATH: controlPath,
          BTP_OPERATION_LOG_PATH: operationLogPath,
          BTP_PROVIDER_ID: input.provider.providerId,
          BTP_MODEL: input.model,
          BTP_HARNESS_INVOCATION_ID: invocationId,
          ...(mediaProvider?.apiKey
            ? {
                BTP_MULTIMODAL_API_KEY: mediaProvider.apiKey,
                BTP_IMAGE_GENERATION_ENDPOINT:
                  process.env.BTP_IMAGE_GENERATION_ENDPOINT ??
                  `${mediaOrigin}/api/v1/services/aigc/multimodal-generation/generation`,
                BTP_VISION_REVIEW_ENDPOINT:
                  process.env.BTP_VISION_REVIEW_ENDPOINT ??
                  `${mediaProvider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
                BTP_IMAGE_GENERATION_MODEL: process.env.BTP_IMAGE_GENERATION_MODEL ?? "wan2.7-image-pro",
                BTP_VISION_REVIEW_MODEL: process.env.BTP_VISION_REVIEW_MODEL ?? "qwen3.8-max"
              }
            : {}),
          BTP_COCOS_EXECUTABLE: cocosConfig.executablePath,
          BTP_COCOS_VERSION: cocosConfig.version,
          BTP_COCOS_PLATFORM: cocosConfig.platform,
          BTP_COCOS_BUILD_CONFIG: cocosConfig.buildConfigPath,
          BTP_COCOS_TIMEOUT_MS: String(cocosConfig.timeoutMs)
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
    return parseToolOperations(operationLogPath);
  } finally {
    try {
      unlinkSync(operationLogPath);
    } catch {
      // The operation trace is consumed once by the parent Harness process.
    }
  }
}

function parseToolOperations(operationLogPath: string): AgentHarnessToolOperation[] {
  if (!existsSync(operationLogPath)) return [];
  return readFileSync(operationLogPath, "utf8")
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
          ...(parsed.access === "read" || parsed.access === "write" ? { access: parsed.access } : {}),
          ...(parsed.status === "completed" || parsed.status === "failed" ? { status: parsed.status } : {}),
          ...(typeof parsed.bridgeOk === "boolean" ? { bridgeOk: parsed.bridgeOk } : {}),
          ...(typeof parsed.operationId === "string" ? { operationId: parsed.operationId } : {}),
          ...(typeof parsed.operationType === "string" ? { operationType: parsed.operationType } : {}),
          ...(isDirectoryManifest(parsed.directoryManifest) ? { directoryManifest: parsed.directoryManifest } : {}),
          ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
          ...(typeof parsed.hash === "string" ? { hash: parsed.hash } : {}),
          ...(typeof parsed.sizeBytes === "number" ? { sizeBytes: parsed.sizeBytes } : {}),
          ...(typeof parsed.providerId === "string" ? { providerId: parsed.providerId } : {}),
          ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
          ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
          ...(typeof parsed.promptHash === "string" ? { promptHash: parsed.promptHash } : {}),
          ...(typeof parsed.negativePromptHash === "string"
            ? { negativePromptHash: parsed.negativePromptHash }
            : {}),
          ...(typeof parsed.seed === "number" ? { seed: parsed.seed } : {}),
          ...(typeof parsed.width === "number" ? { width: parsed.width } : {}),
          ...(typeof parsed.height === "number" ? { height: parsed.height } : {}),
          ...(typeof parsed.mime === "string" ? { mime: parsed.mime } : {}),
          ...(typeof parsed.endpointFingerprint === "string"
            ? { endpointFingerprint: parsed.endpointFingerprint }
            : {}),
          ...(typeof parsed.latencyMs === "number" ? { latencyMs: parsed.latencyMs } : {}),
          ...(Array.isArray(parsed.inspectedPaths) && parsed.inspectedPaths.every((path) => typeof path === "string")
            ? { inspectedPaths: parsed.inspectedPaths as string[] }
            : {}),
          ...(isInspectedEvidence(parsed.inspectedEvidence)
            ? { inspectedEvidence: parsed.inspectedEvidence }
            : {}),
          ...(typeof parsed.visionResponseHash === "string"
            ? { visionResponseHash: parsed.visionResponseHash }
            : {}),
          ...(typeof parsed.visionSemanticHash === "string"
            ? { visionSemanticHash: parsed.visionSemanticHash }
            : {}),
          ...(isRecord(parsed.visionSemanticResult)
            ? {
                visionSemanticResult:
                  parsed.visionSemanticResult as unknown as NonNullable<AgentHarnessToolOperation["visionSemanticResult"]>
              }
            : {}),
          ...(Array.isArray(parsed.authoritativeContextEvidence)
            ? {
                authoritativeContextEvidence:
                  parsed.authoritativeContextEvidence as NonNullable<AgentHarnessToolOperation["authoritativeContextEvidence"]>
              }
            : {}),
          ...(typeof parsed.authoritativeContextHash === "string"
            ? { authoritativeContextHash: parsed.authoritativeContextHash }
            : {}),
          ...(typeof parsed.requestSemanticHash === "string"
            ? { requestSemanticHash: parsed.requestSemanticHash }
            : {}),
          ...(Array.isArray(parsed.visionSemanticReceipts)
            ? {
                visionSemanticReceipts:
                  parsed.visionSemanticReceipts as NonNullable<AgentHarnessToolOperation["visionSemanticReceipts"]>
              }
            : {}),
          ...(typeof parsed.recordedAt === "string" ? { recordedAt: parsed.recordedAt } : {})
        } satisfies AgentHarnessToolOperation];
      } catch {
        return [];
      }
    });
}

function isInspectedEvidence(value: unknown): value is Array<{ path: string; hash: string; sizeBytes: number }> {
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as { path?: unknown }).path === "string" &&
    typeof (entry as { hash?: unknown }).hash === "string" &&
    typeof (entry as { sizeBytes?: unknown }).sizeBytes === "number"
  );
}

function isDirectoryManifest(value: unknown): value is import("@game-pipeline/shared-schemas").ArtifactDirectoryManifest {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (value as { rootPath?: unknown }).rootPath === "string" &&
    typeof (value as { digest?: unknown }).digest === "string" &&
    Array.isArray((value as { files?: unknown }).files);
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
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
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
  return /no (?:conversation|session) found|(?:resume|session|conversation).{0,100}(?:not found|does not exist|cannot be resumed|invalid|expired)|(?:找不到|不存在|失效|无法恢复).{0,40}(?:会话|session)|(?:会话|session).{0,40}(?:找不到|不存在|失效|无法恢复)/i.test(message);
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
  onOutputActivity?: () => void;
  diagnosticConfigDir?: string;
  diagnosticSessionId?: string;
  progress?: {
    operationLogPath: string;
    projectRoot: string;
    expectedPaths: string[];
    initialProgressTimeoutMs: number;
    idleAfterProgressMs: number;
    settleAfterExpectedOutputsMs: number;
    onOperation?: (operation: AgentHarnessToolOperation) => void;
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
    let lastOutputAt = 0;
    let progressDetected = false;
    let firstOutputMs: number | undefined;
    let outputActivityReported = false;
    let reportedOperationCount = 0;
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
          ? `Claude CLI 首次工具写入前连续 ${formatTimeout(timeoutMs)} 无输出进展，已停止本轮。`
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
      const checkInitialProgress = (): void => {
        if (progressDetected || hasRecordedProgress(progress.operationLogPath)) {
          return;
        }
        // A large blueprint can stream for several minutes before the first
        // complete JSON write. Treat this as an inactivity limit; the overall
        // invocation deadline still bounds a model that never writes anything.
        const remaining = progress.initialProgressTimeoutMs - (Date.now() - Math.max(startedAt, lastOutputAt));
        if (remaining > 0) {
          initialProgressTimeout = setTimeout(checkInitialProgress, remaining);
          return;
        }
        requestTimeout("initial_progress", progress.initialProgressTimeoutMs);
      };
      initialProgressTimeout = setTimeout(checkInitialProgress, progress.initialProgressTimeoutMs);
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
          const operations = parseToolOperations(progress.operationLogPath);
          for (const operation of operations.slice(reportedOperationCount)) {
            progress.onOperation?.(operation);
          }
          reportedOperationCount = operations.length;
        }
        if (!progressDetected || lastProgressAt === 0) {
          return;
        }
        // A streaming model may still be composing a large strict receipt after
        // a tool call. Do not mistake active output for a stalled worker.
        const elapsed = Date.now() - Math.max(lastProgressAt, lastOutputAt);
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
      lastOutputAt = Date.now();
      firstOutputMs ??= Date.now() - startedAt;
      if (!outputActivityReported) {
        outputActivityReported = true;
        options.onOutputActivity?.();
      }
      stdout += chunk;
      resetIdleTimeout();
    });
    child.stderr.on("data", (chunk: string) => {
      lastOutputAt = Date.now();
      firstOutputMs ??= Date.now() - startedAt;
      if (!outputActivityReported) {
        outputActivityReported = true;
        options.onOutputActivity?.();
      }
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
        const sessionLog = readClaudeSessionLogTail(
          options.diagnosticConfigDir,
          options.diagnosticSessionId ?? parseStreamJson(stdout).sessionId
        );
        const diagnosis = diagnoseClaudeCliFailure({ stdout, stderr, sessionLog });
        reject(new ClaudeCliProcessError({
          exitCode: code,
          signal,
          ...diagnosis
        }));
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
  if (progress.expectedPaths.length === 0) return false;
  const operations = parseToolOperations(progress.operationLogPath);
  return progress.expectedPaths.every((path) =>
    operations.some((operation) =>
      toolOperationSucceeded(operation) &&
      (operation.path === path || operation.path.startsWith(`${path.replace(/\/+$/, "")}/`))
    )
  );
}

function toolOperationSucceeded(operation: AgentHarnessToolOperation): boolean {
  return operation.status !== "failed" && operation.bridgeOk !== false;
}

function compactProcessError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function diagnoseClaudeCliFailure(input: {
  stdout?: string;
  stderr?: string;
  sessionLog?: string;
}): ClaudeCliFailureDiagnosis {
  const structuredCandidates = [input.sessionLog ?? "", input.stdout ?? ""]
    .flatMap((source) => extractStructuredFailureCandidates(source))
    .reverse();
  const stderrCandidate = extractPlainFailureCandidate(input.stderr ?? "");
  const rawDetail = structuredCandidates.find(Boolean) ?? stderrCandidate;
  return classifyClaudeCliFailure(rawDetail);
}

function extractStructuredFailureCandidates(source: string): string[] {
  const candidates: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const type = typeof event.type === "string" ? event.type : "";
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    const explicitFailure = event.is_error === true
      || type === "error"
      || /error|failed|failure/i.test(subtype)
      || (type === "assistant" && typeof event.error === "string");
    if (!explicitFailure) continue;

    const textParts = extractTextParts(event.message);
    const values = [
      ...textParts,
      typeof event.result === "string" ? event.result : "",
      typeof event.error === "string" && event.error !== "unknown" ? event.error : "",
      typeof event.message === "string" ? event.message : ""
    ];
    const candidate = values.find((value) => /API Error|error|terminated|timeout|timed out|rate.?limit|overload|unauthor|forbidden|session/i.test(value))
      ?? values.find((value) => value.trim());
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function extractPlainFailureCandidate(source: string): string | undefined {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\{.*"type"\s*:\s*"system".*"subtype"\s*:\s*"init"/.test(line));
  return lines.reverse().find((line) => /error|terminated|timeout|timed out|rate.?limit|overload|unauthor|forbidden|session/i.test(line))
    ?? lines[0];
}

function classifyClaudeCliFailure(rawDetail: string | undefined): ClaudeCliFailureDiagnosis {
  const detail = sanitizeClaudeCliFailureDetail(rawDetail ?? "");
  if (/API Error:\s*terminated|\bterminated\b/i.test(detail)) {
    return {
      kind: "provider_terminated",
      retryable: true,
      detail: "上游模型在生成过程中终止了请求（API Error: terminated）。CLI 与工作区工具已完成初始化，本次没有形成可验收结果；可以安全重试。"
    };
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(detail)) {
    return {
      kind: "provider_rate_limited",
      retryable: true,
      detail: "上游模型服务触发限流，请稍后重试。"
    };
  }
  if (/overload|\b529\b/i.test(detail)) {
    return {
      kind: "provider_overloaded",
      retryable: true,
      detail: "上游模型服务当前过载，请稍后重试。"
    };
  }
  if (/timeout|timed out|超时/i.test(detail)) {
    return {
      kind: "provider_timeout",
      retryable: true,
      detail: "上游模型请求超时，本次没有形成可验收结果；可以安全重试。"
    };
  }
  if (/authentication|unauthor|forbidden|invalid.{0,20}api.?key|\b401\b|\b403\b/i.test(detail)) {
    return {
      kind: "authentication",
      retryable: false,
      detail: "模型服务认证失败，请检查该角色绑定的 Provider、API Key 和 Base URL。"
    };
  }
  if (/no (?:conversation|session) found|(?:resume|session|conversation).{0,100}(?:not found|does not exist|cannot be resumed|invalid|expired)|(?:找不到|不存在|失效|无法恢复).{0,40}(?:会话|session)/i.test(detail)) {
    return {
      kind: "session",
      retryable: true,
      detail: "原 Claude CLI 会话无法恢复，调度器将创建新的 task child session 后重试。"
    };
  }
  return {
    kind: "process_exit",
    retryable: true,
    detail: detail
      ? `Claude CLI 未正常完成：${detail}`
      : "Claude CLI 未正常完成，且没有返回可识别的错误详情；可以重试，若持续发生请查看服务端日志。"
  };
}

function sanitizeClaudeCliFailureDetail(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\/Users\/[^\s"']+/g, "[local-path]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "[session]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function readClaudeSessionLogTail(configDir: string | undefined, sessionId: string | undefined): string {
  if (!configDir || !sessionId) return "";
  const projectsRoot = join(configDir, "projects");
  const logPath = findFileByName(projectsRoot, `${sessionId}.jsonl`, 3);
  if (!logPath) return "";
  try {
    return readFileSync(logPath, "utf8").slice(-256 * 1024);
  } catch {
    return "";
  }
}

function findFileByName(root: string, fileName: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(root)) return undefined;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFileByName(join(root, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
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
