import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAgentContracts } from "@game-pipeline/agent-runtime";

export type ModelProviderId = "openai" | "anthropic" | "google" | "deepseek" | "custom";

export interface ModelProviderConfig {
  providerId: ModelProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
  updatedAt?: string;
}

export interface PublicModelProviderConfig {
  providerId: ModelProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
  keyFingerprint?: string;
  updatedAt?: string;
}

export interface SaveModelProviderInput {
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
}

export interface AgentModelAssignment {
  agentId: string;
  displayName: string;
  roleScope: string;
  capability: string;
  providerId: ModelProviderId;
  model: string;
  updatedAt?: string;
}

export interface SaveAgentModelAssignmentInput {
  providerId?: ModelProviderId;
  model?: string;
}

export interface ModelProviderTestResult {
  ok: boolean;
  providerId: ModelProviderId;
  label: string;
  model?: string;
  latencyMs: number;
  testedAt: string;
  message: string;
}

interface ModelSettingsDocument {
  providers: ModelProviderConfig[];
  agentAssignments: AgentModelAssignment[];
}

const defaultProviders: ModelProviderConfig[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: ""
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: ""
  },
  {
    providerId: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: ""
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: ""
  },
  {
    providerId: "custom",
    label: "Custom OpenAI-compatible",
    baseUrl: "",
    defaultModel: ""
  }
];

export class ModelSettingsStore {
  private readonly configPath: string;

  constructor(secretRoot = defaultSecretRoot()) {
    this.configPath = join(secretRoot, "model-providers.json");
  }

  listPublic(): PublicModelProviderConfig[] {
    return this.load().providers.map((provider) => toPublicProvider(provider));
  }

  listAgentAssignments(): AgentModelAssignment[] {
    return this.load().agentAssignments;
  }

  getProviderConfig(providerId: string): ModelProviderConfig {
    const provider = this.load().providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`Unsupported model provider: ${providerId}`);
    }
    return { ...provider };
  }

  getAgentAssignment(agentId: string): AgentModelAssignment {
    const assignment = this.load().agentAssignments.find((candidate) => candidate.agentId === agentId);
    if (!assignment) {
      throw new Error(`Unsupported agent: ${agentId}`);
    }
    return { ...assignment };
  }

  saveProvider(providerId: string, input: SaveModelProviderInput): PublicModelProviderConfig {
    const document = this.load();
    const provider = document.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`Unsupported model provider: ${providerId}`);
    }

    if (input.baseUrl !== undefined) {
      provider.baseUrl = input.baseUrl.trim();
    }
    if (input.defaultModel !== undefined) {
      provider.defaultModel = input.defaultModel.trim();
    }
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      provider.apiKey = input.apiKey.trim();
    }
    provider.updatedAt = new Date().toISOString();
    this.write(document);
    return toPublicProvider(provider);
  }

  clearProviderKey(providerId: string): PublicModelProviderConfig {
    const document = this.load();
    const provider = document.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`Unsupported model provider: ${providerId}`);
    }

    delete provider.apiKey;
    provider.updatedAt = new Date().toISOString();
    this.write(document);
    return toPublicProvider(provider);
  }

  async testProvider(providerId: string): Promise<ModelProviderTestResult> {
    const provider = this.load().providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`Unsupported model provider: ${providerId}`);
    }

    return testProviderConnection(provider);
  }

  saveAgentAssignment(agentId: string, input: SaveAgentModelAssignmentInput): AgentModelAssignment {
    const document = this.load();
    const assignment = document.agentAssignments.find((candidate) => candidate.agentId === agentId);
    if (!assignment) {
      throw new Error(`Unsupported agent: ${agentId}`);
    }

    if (input.providerId !== undefined) {
      if (!document.providers.some((provider) => provider.providerId === input.providerId)) {
        throw new Error(`Unsupported model provider: ${input.providerId}`);
      }
      assignment.providerId = input.providerId;
    }
    if (input.model !== undefined) {
      assignment.model = input.model.trim();
    }
    assignment.updatedAt = new Date().toISOString();
    this.write(document);
    return assignment;
  }

  private load(): ModelSettingsDocument {
    if (!existsSync(this.configPath)) {
      return {
        providers: structuredClone(defaultProviders),
        agentAssignments: defaultAgentAssignments()
      };
    }

    const saved = JSON.parse(readFileSync(this.configPath, "utf8")) as ModelProviderConfig[] | Partial<ModelSettingsDocument>;
    const savedProviders = Array.isArray(saved) ? saved : (saved.providers ?? []);
    const savedAssignments = Array.isArray(saved) ? [] : (saved.agentAssignments ?? []);
    return {
      providers: mergeProviders(savedProviders),
      agentAssignments: mergeAgentAssignments(savedAssignments)
    };
  }

  private write(document: ModelSettingsDocument): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.configPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
}

export const modelSettingsStore = new ModelSettingsStore();

function defaultSecretRoot(): string {
  return process.env.GAME_PIPELINE_SECRET_ROOT ?? join(process.env.INIT_CWD ?? process.cwd(), ".local", "secrets");
}

function toPublicProvider(provider: ModelProviderConfig): PublicModelProviderConfig {
  return {
    providerId: provider.providerId,
    label: provider.label,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    hasApiKey: Boolean(provider.apiKey),
    ...(provider.apiKey ? { keyFingerprint: fingerprint(provider.apiKey) } : {}),
    ...(provider.updatedAt ? { updatedAt: provider.updatedAt } : {})
  };
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

function mergeProviders(savedProviders: ModelProviderConfig[]): ModelProviderConfig[] {
  return defaultProviders.map((defaultProvider) => {
    const existing = savedProviders.find((provider) => provider.providerId === defaultProvider.providerId);
    return {
      ...defaultProvider,
      ...existing
    };
  });
}

function mergeAgentAssignments(savedAssignments: AgentModelAssignment[]): AgentModelAssignment[] {
  return defaultAgentAssignments().map((defaultAssignment) => {
    const existing = savedAssignments.find((assignment) => assignment.agentId === defaultAssignment.agentId);
    return {
      ...defaultAssignment,
      ...existing,
      displayName: defaultAssignment.displayName,
      roleScope: defaultAssignment.roleScope,
      capability: defaultAssignment.capability
    };
  });
}

function defaultAgentAssignments(): AgentModelAssignment[] {
  return defaultAgentContracts.map((agent) => ({
    agentId: agent.agentId,
    displayName: agent.displayName,
    roleScope: agent.roleScope,
    capability: agent.modelProfile.capability,
    providerId: defaultProviderForCapability(agent.modelProfile.capability),
    model: ""
  }));
}

function defaultProviderForCapability(capability: string): ModelProviderId {
  if (capability === "image_generation" || capability === "vision") {
    return "openai";
  }
  return "openai";
}

async function testProviderConnection(provider: ModelProviderConfig): Promise<ModelProviderTestResult> {
  const startedAt = Date.now();
  const testedAt = new Date().toISOString();
  const model = provider.defaultModel.trim() || fallbackTestModel(provider.providerId);
  try {
    if (!provider.apiKey) {
      throw new Error("API key 未配置，请先保存 API key。");
    }
    if (!provider.baseUrl.trim()) {
      throw new Error("Base URL 未配置。");
    }
    if (!model) {
      throw new Error("默认模型未配置，请先填写一个可用模型名。");
    }

    const response = await sendProviderProbe(provider, model);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${summarizeProviderError(body)}`);
    }

    await response.json().catch(() => undefined);
    return {
      ok: true,
      providerId: provider.providerId,
      label: provider.label,
      model,
      latencyMs,
      testedAt,
      message: `${provider.label} 连通性正常，模型 ${model} 可访问。`
    };
  } catch (error) {
    return {
      ok: false,
      providerId: provider.providerId,
      label: provider.label,
      ...(model ? { model } : {}),
      latencyMs: Date.now() - startedAt,
      testedAt,
      message: `${provider.label} 连通性测试失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function sendProviderProbe(provider: ModelProviderConfig, model: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    switch (provider.providerId) {
      case "anthropic":
        return await fetch(joinProviderUrl(provider.baseUrl, provider.baseUrl.endsWith("/v1") ? "messages" : "v1/messages"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": provider.apiKey ?? "",
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }]
          }),
          signal: controller.signal
        });
      case "google":
        return await fetch(
          `${joinProviderUrl(provider.baseUrl, provider.baseUrl.endsWith("/v1beta") ? `models/${encodeURIComponent(model)}:generateContent` : `v1beta/models/${encodeURIComponent(model)}:generateContent`)}?key=${encodeURIComponent(provider.apiKey ?? "")}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "ping" }] }],
              generationConfig: { maxOutputTokens: 1 }
            }),
            signal: controller.signal
          }
        );
      case "openai":
      case "deepseek":
      case "custom":
      default:
        return await fetch(joinProviderUrl(provider.baseUrl, "chat/completions"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey ?? ""}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0
          }),
          signal: controller.signal
        });
    }
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackTestModel(providerId: ModelProviderId): string {
  switch (providerId) {
    case "deepseek":
      return "deepseek-chat";
    default:
      return "";
  }
}

function joinProviderUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function summarizeProviderError(body: string): string {
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
