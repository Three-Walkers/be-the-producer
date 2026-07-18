import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContract, AgentLoopControl } from "@game-pipeline/shared-schemas";
import type { AgentHarness, AgentHarnessRunInput, AgentHarnessRunResult, AgentHarnessStatus } from "./agentHarness.js";

const defaultTimeoutMs = 20 * 60 * 1000;

export class ClaudeCliHarness implements AgentHarness {
  readonly harnessId = "claude-cli" as const;

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
      claudeToolsForAgent(input.agent).join(","),
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig(input, controlPath, operationLogPath),
      "--model",
      input.model,
      "--name",
      `btp-${input.projectId}-${input.agent.agentId}`,
      "--append-system-prompt",
      input.systemPrompt
    ];
    if (input.sessionId) {
      args.push("--resume", input.sessionId);
    }

    const startedAt = Date.now();
    const result = await runProcess(resolveClaudeExecutable(), args, {
      cwd: input.projectRoot,
      env: claudeEnvironment(input, configDir),
      stdin: input.userPrompt,
      timeoutMs: defaultTimeoutMs,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    const parsed = parseStreamJson(result.stdout);
    const loopControl = readLoopControl(controlPath);
    const changedPaths = readOperationPaths(operationLogPath);
    if (!parsed.content.trim()) {
      throw new Error(`Claude CLI 没有返回可读取内容。${compactProcessError(result.stderr)}`);
    }

    return {
      harnessId: this.harnessId,
      invocationId,
      content: parsed.content,
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : input.sessionId ? { sessionId: input.sessionId } : {}),
      model: input.model,
      providerId: input.provider.providerId,
      latencyMs: Date.now() - startedAt,
      rawEventCount: parsed.eventCount,
      changedPaths,
      ...(loopControl ? { loopControl } : {})
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

function claudeToolsForAgent(agent: AgentContract): string[] {
  const tools = [
    "Read",
    "Glob",
    "Grep",
    "mcp__btp_workspace__write_artifact",
    "mcp__btp_workspace__append_document",
    "mcp__btp_workspace__list_files",
    "mcp__btp_workspace__report_task_status"
  ];
  if (["coding", "evaluation"].includes(agent.modelProfile.capability) || ["devops", "wechat_platform", "cocos_automation"].includes(agent.agentId)) {
    tools.push("mcp__btp_workspace__run_project_check");
  }
  return tools;
}

function mcpConfig(input: AgentHarnessRunInput, controlPath: string, operationLogPath: string): string {
  return JSON.stringify({
    mcpServers: {
      btp_workspace: {
        type: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./harnessMcpServer.js", import.meta.url))],
        env: {
          BTP_PROJECT_ROOT: input.projectRoot,
          BTP_AGENT_ID: input.agent.agentId,
          BTP_ALLOWED_ROOTS: JSON.stringify(input.allowedRoots ?? [input.agent.workspace.replace(/\/+$/, "")]),
          BTP_EXPECTED_PATHS: JSON.stringify(input.expectedPaths ?? []),
          BTP_CONTROL_PATH: controlPath,
          BTP_OPERATION_LOG_PATH: operationLogPath,
          BTP_ALLOW_PROJECT_CHECKS: String(
            ["coding", "evaluation"].includes(input.agent.modelProfile.capability) || ["devops", "wechat_platform", "cocos_automation"].includes(input.agent.agentId)
          )
        }
      }
    }
  });
}

function readOperationPaths(operationLogPath: string): string[] {
  if (!existsSync(operationLogPath)) {
    return [];
  }
  try {
    const paths = readFileSync(operationLogPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as { path?: unknown };
          return typeof parsed.path === "string" && parsed.path.trim() ? [parsed.path.trim()] : [];
        } catch {
          return [];
        }
      });
    return [...new Set(paths)];
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
  abortSignal?: AbortSignal;
}

function runProcess(command: string, args: string[], options: ProcessOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
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
      terminate();
      finish(() => reject(new Error("Agent Harness 已被暂停或取消。")));
    };
    const timeout = setTimeout(() => {
      terminate();
      finish(() => reject(new Error(`Claude CLI 执行超过 ${Math.round(options.timeoutMs / 60_000)} 分钟，已终止。`)));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
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

function compactProcessError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
