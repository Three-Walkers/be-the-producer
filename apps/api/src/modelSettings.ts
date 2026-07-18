import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAgentContracts } from "@game-pipeline/agent-runtime";
import type { AgentHarnessId } from "@game-pipeline/shared-schemas";

export type ModelProviderId = string;
export type ModelProviderProtocol = "openai-compatible" | "anthropic" | "google";

export interface ModelProviderConfig {
  providerId: ModelProviderId;
  label: string;
  protocol: ModelProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
  isCustom?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PublicModelProviderConfig {
  providerId: ModelProviderId;
  label: string;
  protocol: ModelProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
  isCustom: boolean;
  keyFingerprint?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SaveModelProviderInput {
  label?: string;
  protocol?: ModelProviderProtocol;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
}

export interface AgentModelAssignment {
  agentId: string;
  displayName: string;
  roleScope: string;
  capability: string;
  harnessId: AgentHarnessId;
  providerId: ModelProviderId;
  model: string;
  avatarUrl: string;
  updatedAt?: string;
}

export interface SaveAgentModelAssignmentInput {
  harnessId?: AgentHarnessId;
  providerId?: ModelProviderId;
  model?: string;
  avatarUrl?: string;
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
    label: "OpenAI 官方",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: ""
  },
  {
    providerId: "dashscope",
    label: "阿里云百炼 DashScope",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus"
  },
  {
    providerId: "dashscope-anthropic-qwen",
    label: "百炼 Qwen · Claude CLI",
    protocol: "anthropic",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    defaultModel: "qwen3.7-plus"
  },
  {
    providerId: "dashscope-anthropic-deepseek",
    label: "百炼 DeepSeek · Claude CLI",
    protocol: "anthropic",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    defaultModel: "deepseek-v4-pro"
  },
  {
    providerId: "deepseek",
    label: "DeepSeek 官方",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash"
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: ""
  },
  {
    providerId: "google",
    label: "Google Gemini",
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: ""
  },
  {
    providerId: "custom",
    label: "自定义 OpenAI-compatible",
    protocol: "openai-compatible",
    baseUrl: "",
    defaultModel: "",
    isCustom: true
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

    if (input.label !== undefined) {
      provider.label = normalizeProviderLabel(input.label, provider.label);
    }
    if (input.protocol !== undefined) {
      provider.protocol = normalizeProviderProtocol(input.protocol);
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

  createProvider(input: SaveModelProviderInput): PublicModelProviderConfig {
    const document = this.load();
    const now = new Date().toISOString();
    const label = normalizeProviderLabel(input.label, "自定义模型连接");
    const provider: ModelProviderConfig = {
      providerId: uniqueProviderId(document.providers, label),
      label,
      protocol: normalizeProviderProtocol(input.protocol ?? "openai-compatible"),
      baseUrl: input.baseUrl?.trim() ?? "",
      defaultModel: input.defaultModel?.trim() ?? "",
      isCustom: true,
      createdAt: now,
      updatedAt: now
    };
    if (input.apiKey?.trim()) {
      provider.apiKey = input.apiKey.trim();
    }

    document.providers.push(provider);
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

  removeProvider(providerId: string): void {
    const document = this.load();
    const provider = document.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`Unsupported model provider: ${providerId}`);
    }
    if (!provider.isCustom || provider.providerId === "custom") {
      throw new Error("只能删除新增的自定义模型连接。");
    }

    document.providers = document.providers.filter((candidate) => candidate.providerId !== providerId);
    document.agentAssignments = document.agentAssignments.map((assignment) =>
      assignment.providerId === providerId
        ? {
            ...assignment,
            providerId: defaultProviderForAgent(assignment.agentId, assignment.capability),
            updatedAt: new Date().toISOString()
          }
        : assignment
    );
    this.write(document);
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

    const nextProviderId = input.providerId ?? assignment.providerId;
    const nextHarnessId = normalizeHarnessId(input.harnessId ?? assignment.harnessId);
    const nextProvider = document.providers.find((provider) => provider.providerId === nextProviderId);
    if (!nextProvider) {
      throw new Error(`Unsupported model provider: ${nextProviderId}`);
    }
    if (nextHarnessId === "claude-cli" && nextProvider.protocol !== "anthropic") {
      throw new Error("Claude CLI 只能使用 Anthropic Messages 连接。百炼请选用“百炼 Qwen/DeepSeek · Claude CLI”。");
    }

    if (input.providerId !== undefined) {
      if (!document.providers.some((provider) => provider.providerId === input.providerId)) {
        throw new Error(`Unsupported model provider: ${input.providerId}`);
      }
      assignment.providerId = input.providerId;
    }
    if (input.harnessId !== undefined) {
      assignment.harnessId = nextHarnessId;
    }
    if (input.model !== undefined) {
      assignment.model = input.model.trim();
    }
    if (input.avatarUrl !== undefined) {
      assignment.avatarUrl = normalizeAvatarUrl(input.avatarUrl);
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
    const shouldMigrateOpenAIAssignmentsToDashScope = savedProviders.some(
      (provider) => provider.providerId === "openai" && provider.baseUrl?.includes("dashscope.aliyuncs.com")
    );
    return {
      providers: mergeProviders(savedProviders),
      agentAssignments: mergeAgentAssignments(savedAssignments).map((assignment) =>
        shouldMigrateOpenAIAssignmentsToDashScope && assignment.providerId === "openai"
          ? { ...assignment, providerId: "dashscope" }
          : assignment
      )
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
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    hasApiKey: Boolean(provider.apiKey),
    isCustom: Boolean(provider.isCustom),
    ...(provider.apiKey ? { keyFingerprint: fingerprint(provider.apiKey) } : {}),
    ...(provider.createdAt ? { createdAt: provider.createdAt } : {}),
    ...(provider.updatedAt ? { updatedAt: provider.updatedAt } : {})
  };
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

function mergeProviders(savedProviders: ModelProviderConfig[]): ModelProviderConfig[] {
  const normalizedSavedProviders = savedProviders.map((provider) => normalizeSavedProvider(provider));
  const savedOpenAI = normalizedSavedProviders.find((provider) => provider.providerId === "openai");
  const savedDashScope = normalizedSavedProviders.find((provider) => provider.providerId === "dashscope");
  const openAIWasDashScope = Boolean(savedOpenAI?.baseUrl && savedOpenAI.baseUrl.includes("dashscope.aliyuncs.com"));
  const defaultProviderIds = new Set(defaultProviders.map((provider) => provider.providerId));
  const mergedDefaults = defaultProviders.map((defaultProvider) => {
    const existing = normalizedSavedProviders.find((provider) => provider.providerId === defaultProvider.providerId);
    if (defaultProvider.providerId.startsWith("dashscope-anthropic-") && !existing && savedDashScope?.apiKey) {
      return normalizeSavedProvider({
        ...defaultProvider,
        apiKey: savedDashScope.apiKey,
        ...(savedDashScope.createdAt ? { createdAt: savedDashScope.createdAt } : {}),
        ...(savedDashScope.updatedAt ? { updatedAt: savedDashScope.updatedAt } : {})
      });
    }
    if (defaultProvider.providerId === "openai" && openAIWasDashScope) {
      return structuredClone(defaultProvider);
    }
    if (defaultProvider.providerId === "dashscope" && !existing && savedOpenAI) {
      return normalizeSavedProvider({
        ...defaultProvider,
        ...savedOpenAI,
        providerId: "dashscope",
        label: defaultProvider.label,
        protocol: "openai-compatible"
      });
    }

    const isCustom = existing?.isCustom ?? defaultProvider.isCustom;
    return normalizeSavedProvider({
      ...defaultProvider,
      ...existing,
      providerId: defaultProvider.providerId,
      label: defaultProviderLabel(defaultProvider, existing),
      protocol: existing?.protocol ?? defaultProvider.protocol,
      ...(isCustom !== undefined ? { isCustom } : {})
    });
  });
  const customProviders = normalizedSavedProviders.filter((provider) => !defaultProviderIds.has(provider.providerId));
  return [...mergedDefaults, ...customProviders];
}

function mergeAgentAssignments(savedAssignments: AgentModelAssignment[]): AgentModelAssignment[] {
  return defaultAgentAssignments().map((defaultAssignment) => {
    const existing = savedAssignments.find((assignment) => assignment.agentId === defaultAssignment.agentId);
    const harnessId = normalizeHarnessId(existing?.harnessId ?? "claude-cli");
    return {
      ...defaultAssignment,
      ...existing,
      displayName: defaultAssignment.displayName,
      roleScope: defaultAssignment.roleScope,
      capability: defaultAssignment.capability,
      harnessId,
      providerId:
        harnessId === "claude-cli" && (!existing?.harnessId || existing.providerId === "dashscope" || existing.providerId === "deepseek")
          ? claudeProviderForAgent(defaultAssignment.agentId, defaultAssignment.capability)
          : existing?.providerId ?? defaultAssignment.providerId,
      avatarUrl: existing?.avatarUrl ?? defaultAssignment.avatarUrl ?? ""
    };
  });
}

function defaultAgentAssignments(): AgentModelAssignment[] {
  return defaultAgentContracts.map((agent) => ({
    agentId: agent.agentId,
    displayName: agent.displayName,
    roleScope: agent.roleScope,
    capability: agent.modelProfile.capability,
    harnessId: "claude-cli",
    providerId: claudeProviderForAgent(agent.agentId, agent.modelProfile.capability),
    model: "",
    avatarUrl: ""
  }));
}

function normalizeAvatarUrl(value: string): string {
  const avatarUrl = value.trim();
  if (!avatarUrl) {
    return "";
  }

  if (/^(https?:\/\/|\/|data:image\/)/i.test(avatarUrl)) {
    return avatarUrl;
  }

  throw new Error("头像地址只支持 http(s)、站内 / 路径或 data:image。");
}

function defaultProviderForAgent(agentId: string, capability: string): ModelProviderId {
  if (capability === "coding" || capability === "evaluation" || agentId === "studio_orchestrator") {
    return "deepseek";
  }
  if (capability === "image_generation" || capability === "vision") {
    return "dashscope";
  }
  return "dashscope";
}

function claudeProviderForAgent(agentId: string, capability: string): ModelProviderId {
  if (capability === "coding" || capability === "evaluation" || ["studio_orchestrator", "producer", "devops"].includes(agentId)) {
    return "dashscope-anthropic-deepseek";
  }
  return "dashscope-anthropic-qwen";
}

function normalizeHarnessId(value: string): AgentHarnessId {
  if (value === "direct-api" || value === "claude-cli") {
    return value;
  }
  throw new Error(`Unsupported Agent harness: ${value}`);
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
      case "openai-compatible":
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
      return "deepseek-v4-flash";
    case "dashscope":
      return "qwen-plus";
    default:
      return "";
  }
}

function normalizeSavedProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    ...provider,
    label: normalizeProviderLabel(provider.label, provider.providerId),
    protocol: normalizeProviderProtocol(provider.protocol ?? legacyProtocolForProvider(provider.providerId)),
    baseUrl: provider.baseUrl ?? "",
    defaultModel: provider.defaultModel ?? "",
    isCustom: Boolean(provider.isCustom) || provider.providerId.startsWith("custom_")
  };
}

function defaultProviderLabel(defaultProvider: ModelProviderConfig, existing: ModelProviderConfig | undefined): string {
  const oldDefaultLabels: Record<string, string[]> = {
    openai: ["OpenAI"],
    deepseek: ["DeepSeek"],
    custom: ["Custom OpenAI-compatible"]
  };
  const existingLabel = existing?.label?.trim();
  if (!existingLabel || oldDefaultLabels[defaultProvider.providerId]?.includes(existingLabel)) {
    return defaultProvider.label;
  }
  return existingLabel;
}

function normalizeProviderLabel(value: string | undefined, fallback: string): string {
  const label = value?.trim();
  if (!label) {
    return fallback;
  }
  return label.slice(0, 80);
}

function normalizeProviderProtocol(value: string): ModelProviderProtocol {
  if (value === "anthropic" || value === "google" || value === "openai-compatible") {
    return value;
  }
  throw new Error(`Unsupported model provider protocol: ${value}`);
}

function legacyProtocolForProvider(providerId: string): ModelProviderProtocol {
  if (providerId === "anthropic") {
    return "anthropic";
  }
  if (providerId === "google") {
    return "google";
  }
  return "openai-compatible";
}

function uniqueProviderId(providers: ModelProviderConfig[], label: string): string {
  const base = `custom_${slugProviderLabel(label) || "profile"}`;
  let providerId = base;
  let index = 2;
  while (providers.some((provider) => provider.providerId === providerId)) {
    providerId = `${base}_${index}`;
    index += 1;
  }
  return providerId;
}

function slugProviderLabel(label: string): string {
  const ascii = label
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (ascii) {
    return ascii.slice(0, 32);
  }
  return Date.now().toString(36);
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
