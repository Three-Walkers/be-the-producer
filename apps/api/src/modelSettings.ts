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
