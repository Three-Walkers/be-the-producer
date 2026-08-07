import { randomUUID } from "node:crypto";
import type { ModelProviderConfig, ModelProviderProtocol } from "./modelSettings.js";

export type ModelThinkingMode = "enabled" | "disabled" | "adaptive";
export type ModelRequestFailureKind =
  | "timeout_overall"
  | "timeout_idle"
  | "cancelled"
  | "http"
  | "network"
  | "invalid_response";

export type ModelRequestActivityType =
  | "request_started"
  | "response_headers"
  | "first_output"
  | "response_completed"
  | "request_failed";

export interface ModelRequestActivity {
  type: ModelRequestActivityType;
  operationId: string;
  providerId: string;
  model: string;
  createdAt: string;
  providerRequestId?: string;
  failureKind?: ModelRequestFailureKind;
}

export interface ModelChatInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  queueWaitTimeoutMs?: number;
  stream?: boolean;
  thinkingMode?: ModelThinkingMode;
  thinkingBudgetTokens?: number;
  requestPurpose?: string;
  abortSignal?: AbortSignal;
  onActivity?: (activity: ModelRequestActivity) => void;
}

export interface ModelRequestTrace {
  operationId: string;
  providerId: string;
  protocol: ModelProviderProtocol;
  model: string;
  requestPurpose?: string | undefined;
  streaming: boolean;
  thinkingMode?: ModelThinkingMode | undefined;
  inputChars: number;
  startedAt: string;
  completedAt?: string | undefined;
  headersMs?: number | undefined;
  firstChunkMs?: number | undefined;
  totalMs?: number | undefined;
  providerRequestId?: string | undefined;
  responseId?: string | undefined;
  httpStatus?: number | undefined;
  finishReason?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  failureKind?: ModelRequestFailureKind | undefined;
}

export interface ModelChatResult {
  content: string;
  providerId: string;
  model: string;
  latencyMs: number;
  trace: ModelRequestTrace;
}

export class ModelRequestError extends Error {
  readonly kind: ModelRequestFailureKind;
  readonly trace: ModelRequestTrace;

  constructor(kind: ModelRequestFailureKind, message: string, trace: ModelRequestTrace, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelRequestError";
    this.kind = kind;
    this.trace = trace;
  }
}

interface ParsedModelResponse {
  content: string;
  responseId?: string | undefined;
  finishReason?: string | undefined;
  usage?: Record<string, unknown> | undefined;
}

interface StreamAccumulator {
  textParts: string[];
  responseId?: string | undefined;
  finishReason?: string | undefined;
  usage?: Record<string, unknown> | undefined;
}

export async function generateModelChat(provider: ModelProviderConfig, input: ModelChatInput): Promise<ModelChatResult> {
  const model = input.model.trim() || fallbackModel(provider.providerId);
  if (!provider.apiKey) {
    throw new Error(`${provider.label} API key 未配置。请在设置中保存 key 并测试连通性。`);
  }
  if (!provider.baseUrl.trim()) {
    throw new Error(`${provider.label} Base URL 未配置。`);
  }
  if (!model) {
    throw new Error(`${provider.label} 默认模型未配置。`);
  }
  if (input.abortSignal?.aborted) {
    throw new Error("模型请求在发起前已被项目暂停、项目切换或任务取消。");
  }

  const startedAtMs = Date.now();
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const idleTimeoutMs = input.stream === true ? normalizeIdleTimeoutMs(input.idleTimeoutMs, timeoutMs) : undefined;
  const trace: ModelRequestTrace = {
    operationId: `modelop_${randomUUID()}`,
    providerId: provider.providerId,
    protocol: provider.protocol,
    model,
    ...(input.requestPurpose ? { requestPurpose: input.requestPurpose } : {}),
    streaming: input.stream === true,
    ...(input.thinkingMode ? { thinkingMode: input.thinkingMode } : {}),
    inputChars: input.systemPrompt.length + input.userPrompt.length,
    startedAt: new Date(startedAtMs).toISOString()
  };
  emitModelActivity(input, trace, "request_started");
  const controller = new AbortController();
  let abortReason: "external" | "overall" | "idle" | undefined;
  let overallTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const abort = (reason: NonNullable<typeof abortReason>): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const resetIdleTimer = (): void => {
    if (!idleTimeoutMs || controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort("idle"), idleTimeoutMs);
  };
  const externalAbort = (): void => abort("external");
  input.abortSignal?.addEventListener("abort", externalAbort, { once: true });
  overallTimer = setTimeout(() => abort("overall"), timeoutMs);
  resetIdleTimer();

  try {
    const response = await sendChatRequest(provider, { ...input, model }, controller.signal, trace.operationId);
    trace.headersMs = Date.now() - startedAtMs;
    trace.httpStatus = response.status;
    trace.providerRequestId = readProviderRequestId(response);
    emitModelActivity(input, trace, "response_headers");
    resetIdleTimer();

    if (!response.ok) {
      const body = await response.text();
      throw new ModelRequestError("http", `HTTP ${response.status}: ${summarizeModelError(body)}`, finishTrace(trace, startedAtMs, "http"));
    }

    let parsed: ParsedModelResponse;
    if (input.stream === true && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      parsed = await readStreamingResponse(response, provider.protocol, () => {
        if (trace.firstChunkMs === undefined) {
          trace.firstChunkMs = Date.now() - startedAtMs;
          emitModelActivity(input, trace, "first_output");
        }
        resetIdleTimer();
      });
    } else {
      const body = await response.text();
      trace.firstChunkMs ??= Date.now() - startedAtMs;
      emitModelActivity(input, trace, "first_output");
      parsed = parseModelResponse(provider.protocol, body);
    }
    trace.responseId = parsed.responseId;
    trace.finishReason = parsed.finishReason;
    trace.usage = parsed.usage;
    finishTrace(trace, startedAtMs);
    emitModelActivity(input, trace, "response_completed");
    return {
      content: parsed.content,
      providerId: provider.providerId,
      model,
      latencyMs: trace.totalMs ?? Date.now() - startedAtMs,
      trace
    };
  } catch (error) {
    if (error instanceof ModelRequestError) {
      emitModelActivity(input, error.trace, "request_failed", error.kind);
      throw error;
    }
    if (abortReason === "overall") {
      const requestError = new ModelRequestError(
        "timeout_overall",
        `模型请求总耗时超过 ${formatSeconds(timeoutMs)}，已终止。`,
        finishTrace(trace, startedAtMs, "timeout_overall"),
        { cause: error }
      );
      emitModelActivity(input, requestError.trace, "request_failed", requestError.kind);
      throw requestError;
    }
    if (abortReason === "idle") {
      const requestError = new ModelRequestError(
        "timeout_idle",
        `模型请求连续 ${formatSeconds(idleTimeoutMs ?? timeoutMs)} 未收到输出，已终止。`,
        finishTrace(trace, startedAtMs, "timeout_idle"),
        { cause: error }
      );
      emitModelActivity(input, requestError.trace, "request_failed", requestError.kind);
      throw requestError;
    }
    if (abortReason === "external") {
      const requestError = new ModelRequestError(
        "cancelled",
        "模型请求因项目暂停、项目切换或任务取消而终止。",
        finishTrace(trace, startedAtMs, "cancelled"),
        { cause: error }
      );
      emitModelActivity(input, requestError.trace, "request_failed", requestError.kind);
      throw requestError;
    }
    if (error instanceof SyntaxError || /没有可读取的文本内容|流式响应正文为空/.test(error instanceof Error ? error.message : String(error))) {
      const requestError = new ModelRequestError(
        "invalid_response",
        error instanceof Error ? error.message : String(error),
        finishTrace(trace, startedAtMs, "invalid_response"),
        { cause: error }
      );
      emitModelActivity(input, requestError.trace, "request_failed", requestError.kind);
      throw requestError;
    }
    const requestError = new ModelRequestError(
      "network",
      error instanceof Error ? error.message : String(error),
      finishTrace(trace, startedAtMs, "network"),
      { cause: error }
    );
    emitModelActivity(input, requestError.trace, "request_failed", requestError.kind);
    throw requestError;
  } finally {
    if (overallTimer) clearTimeout(overallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    input.abortSignal?.removeEventListener("abort", externalAbort);
  }
}

function emitModelActivity(
  input: ModelChatInput,
  trace: ModelRequestTrace,
  type: ModelRequestActivityType,
  failureKind?: ModelRequestFailureKind
): void {
  try {
    input.onActivity?.({
      type,
      operationId: trace.operationId,
      providerId: trace.providerId,
      model: trace.model,
      createdAt: new Date().toISOString(),
      ...(trace.providerRequestId ? { providerRequestId: trace.providerRequestId } : {}),
      ...(failureKind ? { failureKind } : {})
    });
  } catch {
    // UI telemetry must never fail the model request.
  }
}

async function sendChatRequest(
  provider: ModelProviderConfig,
  input: Required<Pick<ModelChatInput, "systemPrompt" | "userPrompt" | "model">> & ModelChatInput,
  signal: AbortSignal,
  operationId: string
): Promise<Response> {
  const headers = providerHeaders(provider, input, operationId);
  switch (provider.protocol) {
    case "anthropic":
      return fetch(joinProviderUrl(provider.baseUrl, provider.baseUrl.endsWith("/v1") ? "messages" : "v1/messages"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxTokens ?? 600,
          system: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt }],
          ...(input.stream === true ? { stream: true } : {}),
          ...anthropicThinking(input)
        }),
        signal
      });
    case "google":
      return fetch(
        `${joinProviderUrl(provider.baseUrl, provider.baseUrl.endsWith("/v1beta") ? `models/${encodeURIComponent(input.model)}:generateContent` : `v1beta/models/${encodeURIComponent(input.model)}:generateContent`)}?key=${encodeURIComponent(provider.apiKey ?? "")}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.systemPrompt }] },
            contents: [{ parts: [{ text: input.userPrompt }] }],
            generationConfig: { maxOutputTokens: input.maxTokens ?? 600 }
          }),
          signal
        }
      );
    case "openai-compatible":
    default:
      return fetch(joinProviderUrl(provider.baseUrl, "chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt }
          ],
          max_tokens: input.maxTokens ?? 600,
          temperature: 0.4,
          ...(input.stream === true
            ? {
                stream: true,
                ...(isDashScopeProvider(provider) ? { stream_options: { include_usage: true } } : {})
              }
            : {}),
          ...openAIThinking(provider, input)
        }),
        signal
      });
  }
}

function providerHeaders(provider: ModelProviderConfig, input: ModelChatInput, operationId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-btp-operation-id": operationId
  };
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = provider.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider.protocol === "openai-compatible") {
    headers.authorization = `Bearer ${provider.apiKey ?? ""}`;
  }
  if (isDashScopeProvider(provider) && input.queueWaitTimeoutMs && input.queueWaitTimeoutMs > 0) {
    headers["x-dashscope-wait-timeout"] = String(Math.min(120, Math.max(1, Math.round(input.queueWaitTimeoutMs / 1_000))));
  }
  return headers;
}

function anthropicThinking(input: ModelChatInput): Record<string, unknown> {
  if (!input.thinkingMode) return {};
  if (input.thinkingMode === "disabled") return { thinking: { type: "disabled" } };
  if (input.thinkingMode === "enabled") {
    return {
      thinking: {
        type: "enabled",
        ...(input.thinkingBudgetTokens ? { budget_tokens: Math.max(1, Math.round(input.thinkingBudgetTokens)) } : {})
      }
    };
  }
  return { thinking: { type: "adaptive" } };
}

function openAIThinking(provider: ModelProviderConfig, input: ModelChatInput): Record<string, unknown> {
  if (!input.thinkingMode || !isDashScopeProvider(provider) || !/^qwen/i.test(input.model)) return {};
  return {
    enable_thinking: input.thinkingMode !== "disabled",
    ...(input.thinkingBudgetTokens ? { thinking_budget: Math.max(1, Math.round(input.thinkingBudgetTokens)) } : {})
  };
}

async function readStreamingResponse(
  response: Response,
  protocol: ModelProviderProtocol,
  onChunk: () => void
): Promise<ParsedModelResponse> {
  if (!response.body) {
    throw new Error("模型流式响应正文为空。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: StreamAccumulator = { textParts: [] };
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    onChunk();
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSseBuffer(buffer, protocol, state, false);
  }
  buffer += decoder.decode();
  consumeSseBuffer(buffer, protocol, state, true);
  const content = state.textParts.join("").trim();
  if (!content) {
    throw new Error("模型响应中没有可读取的文本内容。");
  }
  return {
    content,
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.finishReason ? { finishReason: state.finishReason } : {}),
    ...(state.usage ? { usage: state.usage } : {})
  };
}

function consumeSseBuffer(buffer: string, protocol: ModelProviderProtocol, state: StreamAccumulator, flush: boolean): string {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  for (const block of parts) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    consumeStreamPayload(protocol, JSON.parse(data) as Record<string, unknown>, state);
  }
  if (flush && remainder.trim()) {
    const data = remainder.startsWith("data:") ? remainder.slice(5).trim() : remainder.trim();
    if (data && data !== "[DONE]") consumeStreamPayload(protocol, JSON.parse(data) as Record<string, unknown>, state);
  }
  return flush ? "" : remainder;
}

function consumeStreamPayload(protocol: ModelProviderProtocol, payload: Record<string, unknown>, state: StreamAccumulator): void {
  if (payload.type === "error") {
    const error = isRecord(payload.error) ? payload.error : payload;
    throw new Error(String(error.message ?? "模型流式响应返回错误。"));
  }
  if (protocol === "anthropic") {
    if (payload.type === "message_start" && isRecord(payload.message)) {
      state.responseId = stringValue(payload.message.id) ?? state.responseId;
      state.usage = recordValue(payload.message.usage) ?? state.usage;
    }
    if (payload.type === "content_block_start" && isRecord(payload.content_block) && payload.content_block.type === "text") {
      const text = stringValue(payload.content_block.text);
      if (text) state.textParts.push(text);
    }
    if (payload.type === "content_block_delta" && isRecord(payload.delta)) {
      const text = stringValue(payload.delta.text);
      if (text) state.textParts.push(text);
    }
    if (payload.type === "message_delta") {
      if (isRecord(payload.delta)) state.finishReason = stringValue(payload.delta.stop_reason) ?? state.finishReason;
      state.usage = mergeUsage(state.usage, recordValue(payload.usage));
    }
    return;
  }
  if (protocol === "google") return;
  state.responseId = stringValue(payload.id) ?? state.responseId;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    if (isRecord(choice.delta)) {
      const content = stringValue(choice.delta.content);
      if (content) state.textParts.push(content);
    }
    state.finishReason = stringValue(choice.finish_reason) ?? state.finishReason;
  }
  state.usage = mergeUsage(state.usage, recordValue(payload.usage));
}

function parseModelResponse(protocol: ModelProviderProtocol, body: string): ParsedModelResponse {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (protocol === "anthropic") {
    const content = Array.isArray(parsed.content)
      ? parsed.content.filter(isRecord).filter((part) => part.type === "text").map((part) => stringValue(part.text)).filter(Boolean).join("\n").trim()
      : "";
    if (content) {
      return {
        content,
        ...(stringValue(parsed.id) ? { responseId: stringValue(parsed.id) } : {}),
        ...(stringValue(parsed.stop_reason) ? { finishReason: stringValue(parsed.stop_reason) } : {}),
        ...(recordValue(parsed.usage) ? { usage: recordValue(parsed.usage) } : {})
      };
    }
  }
  if (protocol === "google") {
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const first = isRecord(candidates[0]) ? candidates[0] : undefined;
    const contentRecord = first && isRecord(first.content) ? first.content : undefined;
    const parts = contentRecord && Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
    const content = parts.filter(isRecord).map((part) => stringValue(part.text)).filter(Boolean).join("\n").trim();
    if (content) return { content, ...(recordValue(parsed.usageMetadata) ? { usage: recordValue(parsed.usageMetadata) } : {}) };
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const message = first && isRecord(first.message) ? first.message : undefined;
  const content = message ? stringValue(message.content)?.trim() : undefined;
  if (content) {
    return {
      content,
      ...(stringValue(parsed.id) ? { responseId: stringValue(parsed.id) } : {}),
      ...(first && stringValue(first.finish_reason) ? { finishReason: stringValue(first.finish_reason) } : {}),
      ...(recordValue(parsed.usage) ? { usage: recordValue(parsed.usage) } : {})
    };
  }
  throw new Error("模型响应中没有可读取的文本内容。");
}

function readProviderRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id")
    ?? response.headers.get("x-dashscope-request-id")
    ?? response.headers.get("request-id")
    ?? undefined;
}

function finishTrace(trace: ModelRequestTrace, startedAtMs: number, failureKind?: ModelRequestFailureKind): ModelRequestTrace {
  const now = Date.now();
  trace.completedAt = new Date(now).toISOString();
  trace.totalMs = now - startedAtMs;
  if (failureKind) trace.failureKind = failureKind;
  return trace;
}

function normalizeTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return 120_000;
  return Math.max(1_000, Math.round(timeoutMs));
}

function normalizeIdleTimeoutMs(idleTimeoutMs: number | undefined, overallTimeoutMs: number): number {
  if (idleTimeoutMs === undefined || !Number.isFinite(idleTimeoutMs)) return Math.min(45_000, overallTimeoutMs);
  return Math.min(overallTimeoutMs, Math.max(1_000, Math.round(idleTimeoutMs)));
}

function fallbackModel(providerId: string): string {
  if (providerId === "deepseek") return "deepseek-v4-flash";
  if (providerId === "dashscope") return "qwen-plus";
  return "";
}

function joinProviderUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function summarizeModelError(body: string): string {
  if (!body.trim()) return "无响应正文";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error === "object" && "message" in parsed.error) {
      return String((parsed.error as { message?: unknown }).message);
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall back to compact text below.
  }
  return body.replace(/\s+/g, " ").slice(0, 220);
}

function isDashScopeProvider(provider: ModelProviderConfig): boolean {
  return /dashscope|\.maas\.aliyuncs\.com/i.test(`${provider.providerId} ${provider.baseUrl}`);
}

function mergeUsage(current: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!current) return next;
  if (!next) return current;
  return { ...current, ...next };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSeconds(timeoutMs: number): string {
  return `${Math.max(1, Math.round(timeoutMs / 1_000))} 秒`;
}
