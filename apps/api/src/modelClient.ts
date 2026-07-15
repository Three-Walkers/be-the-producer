import type { ModelProviderConfig, ModelProviderProtocol } from "./modelSettings.js";

export interface ModelChatInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens?: number;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
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
  } finally {
    clearTimeout(timeout);
  }
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
