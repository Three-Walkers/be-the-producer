import type { ModelProviderConfig, ModelProviderProtocol } from "./modelSettings.js";

export interface ModelChatInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface ModelChatResult {
  content: string;
  providerId: string;
  model: string;
  latencyMs: number;
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

  const startedAt = Date.now();
  const response = await sendChatRequest(provider, {
    ...input,
    model
  });
  const latencyMs = Date.now() - startedAt;
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${summarizeModelError(body)}`);
  }

  return {
    content: extractContent(provider.protocol, body),
    providerId: provider.providerId,
    model,
    latencyMs
  };
}

async function sendChatRequest(provider: ModelProviderConfig, input: Required<Pick<ModelChatInput, "systemPrompt" | "userPrompt" | "model">> & ModelChatInput): Promise<Response> {
  if (input.abortSignal?.aborted) {
    throw new Error("模型请求在发起前已被项目暂停、项目切换或任务取消。");
  }

  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const controller = new AbortController();
  let abortReason: "external" | "timeout" | undefined;
  const abort = (): void => {
    abortReason = "external";
    controller.abort();
  };
  input.abortSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, timeoutMs);
  try {
    switch (provider.protocol) {
      case "anthropic":
        return await fetch(joinProviderUrl(provider.baseUrl, provider.baseUrl.endsWith("/v1") ? "messages" : "v1/messages"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": provider.apiKey ?? "",
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: input.model,
            max_tokens: input.maxTokens ?? 600,
            system: input.systemPrompt,
            messages: [{ role: "user", content: input.userPrompt }]
          }),
          signal: controller.signal
        });
      case "google":
        return await fetch(
          `${joinProviderUrl(provider.baseUrl, provider.baseUrl.endsWith("/v1beta") ? `models/${encodeURIComponent(input.model)}:generateContent` : `v1beta/models/${encodeURIComponent(input.model)}:generateContent`)}?key=${encodeURIComponent(provider.apiKey ?? "")}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: input.systemPrompt }] },
              contents: [{ parts: [{ text: input.userPrompt }] }],
              generationConfig: { maxOutputTokens: input.maxTokens ?? 600 }
            }),
            signal: controller.signal
          }
        );
      case "openai-compatible":
      default:
        return await fetch(joinProviderUrl(provider.baseUrl, "chat/completions"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey ?? ""}`
          },
          body: JSON.stringify({
            model: input.model,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPrompt }
            ],
            max_tokens: input.maxTokens ?? 600,
            temperature: 0.4
          }),
          signal: controller.signal
        });
    }
  } catch (error) {
    if (abortReason === "timeout") {
      throw new Error(`模型请求超过 ${Math.round(timeoutMs / 1_000)} 秒，已超时终止。Provider 连接可能正常，但本次生成没有在时限内完成。`);
    }
    if (abortReason === "external") {
      throw new Error("模型请求因项目暂停、项目切换或任务取消而终止。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener("abort", abort);
  }
}

function normalizeTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return 120_000;
  }
  return Math.max(1_000, Math.round(timeoutMs));
}

function extractContent(protocol: ModelProviderProtocol, body: string): string {
  const parsed = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ text?: string }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (protocol === "anthropic") {
    const content = parsed.content?.map((part) => part.text).filter(Boolean).join("\n").trim();
    if (content) {
      return content;
    }
  }

  if (protocol === "google") {
    const content = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n").trim();
    if (content) {
      return content;
    }
  }

  const content = parsed.choices?.[0]?.message?.content?.trim();
  if (content) {
    return content;
  }

  throw new Error("模型响应中没有可读取的文本内容。");
}

function fallbackModel(providerId: string): string {
  if (providerId === "deepseek") {
    return "deepseek-v4-flash";
  }
  if (providerId === "dashscope") {
    return "qwen-plus";
  }
  return "";
}

function joinProviderUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function summarizeModelError(body: string): string {
  if (!body.trim()) {
    return "无响应正文";
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (parsed.error && typeof parsed.error === "object" && "message" in parsed.error) {
      return String((parsed.error as { message?: unknown }).message);
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Fall back to compact text below.
  }

  return body.replace(/\s+/g, " ").slice(0, 220);
}
