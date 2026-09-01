import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ModelRequestError,
  type ModelChatInput,
  type ModelChatResult,
  type ModelRequestFailureKind,
  type ModelRequestTrace
} from "./modelClient.js";
import type { ModelProviderConfig } from "./modelSettings.js";
import { isModelWorkerEvent, type ModelWorkerRequest } from "./modelWorkerProtocol.js";

const maxWorkerOutputBytes = 16 * 1024 * 1024;
const workerShutdownGraceMs = 2_000;

export interface IsolatedModelWorkerOptions {
  maxOldSpaceMb?: number;
}

export function runIsolatedModelChat(
  provider: ModelProviderConfig,
  input: ModelChatInput,
  options: IsolatedModelWorkerOptions = {}
): Promise<ModelChatResult> {
  const requestId = `worker_${randomUUID()}`;
  const request: ModelWorkerRequest = {
    protocolVersion: 1,
    requestId,
    provider,
    input: stripNonSerializableInput(input)
  };
  const workerPath = fileURLToPath(new URL("./modelWorkerChild.js", import.meta.url));
  const maxOldSpaceMb = Math.max(128, Math.min(1024, Math.round(options.maxOldSpaceMb ?? workerMemoryLimitMb())));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${maxOldSpaceMb}`, workerPath], {
      cwd: process.cwd(),
      env: workerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const safetyTimeoutMs = Math.max(5_000, (input.timeoutMs ?? 180_000) + 10_000);
    const safetyTimer = setTimeout(() => {
      stopWorker();
      finishReject(syntheticModelError(provider, input, "timeout_overall", "模型 Worker 超过执行期限，已终止。"));
    }, safetyTimeoutMs);

    const stopWorker = (): void => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, workerShutdownGraceMs);
      forceKillTimer.unref();
    };
    const cleanup = (): void => {
      clearTimeout(safetyTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.abortSignal?.removeEventListener("abort", abort);
    };
    const finishResolve = (result: ModelChatResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      stopWorker();
      finishReject(syntheticModelError(provider, input, "cancelled", "模型 Worker 因项目暂停、项目切换或任务取消而终止。"));
    };

    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) {
      abort();
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxWorkerOutputBytes) {
        stopWorker();
        finishReject(new Error("模型 Worker 输出超过 16MB 限制，已终止。"));
        return;
      }
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) consumeWorkerLine(line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.on("error", (error) => finishReject(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.replace(/\s+/g, " ").trim();
      finishReject(new Error(
        `模型 Worker 未返回结果（exit=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）${detail ? `：${detail}` : ""}`
      ));
    });

    child.stdin.end(JSON.stringify(request));

    function consumeWorkerLine(line: string): void {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        stopWorker();
        finishReject(new Error("模型 Worker 返回了无法解析的协议事件。"));
        return;
      }
      if (!isModelWorkerEvent(event) || event.requestId !== requestId) {
        stopWorker();
        finishReject(new Error("模型 Worker 返回了不匹配的协议事件。"));
        return;
      }
      if (event.type === "activity") {
        input.onActivity?.(event.activity);
        return;
      }
      if (event.type === "result") {
        finishResolve(event.result);
        return;
      }
      if (event.error.kind && event.error.trace) {
        finishReject(new ModelRequestError(event.error.kind, event.error.message, event.error.trace));
      } else {
        const error = new Error(event.error.message);
        error.name = event.error.name;
        finishReject(error);
      }
    }
  });
}

function stripNonSerializableInput(input: ModelChatInput): ModelWorkerRequest["input"] {
  const { abortSignal: _abortSignal, onActivity: _onActivity, ...serializable } = input;
  return serializable;
}

function workerMemoryLimitMb(): number {
  const parsed = Number(process.env.BTP_MODEL_WORKER_MEMORY_MB);
  return Number.isFinite(parsed) ? parsed : 256;
}

function workerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    NO_PROXY: process.env.NO_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY
  };
}

function syntheticModelError(
  provider: ModelProviderConfig,
  input: ModelChatInput,
  kind: ModelRequestFailureKind,
  message: string
): ModelRequestError {
  const now = new Date().toISOString();
  const trace: ModelRequestTrace = {
    operationId: `modelop_worker_${randomUUID()}`,
    providerId: provider.providerId,
    protocol: provider.protocol,
    model: input.model,
    ...(input.requestPurpose ? { requestPurpose: input.requestPurpose } : {}),
    streaming: input.stream === true,
    ...(input.thinkingMode ? { thinkingMode: input.thinkingMode } : {}),
    inputChars: input.systemPrompt.length + input.userPrompt.length,
    startedAt: now,
    completedAt: now,
    failureKind: kind
  };
  return new ModelRequestError(kind, message, trace);
}
