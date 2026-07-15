import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    return this.load().map((provider) => toPublicProvider(provider));
  }

  saveProvider(providerId: string, input: SaveModelProviderInput): PublicModelProviderConfig {
    const providers = this.load();
    const provider = providers.find((candidate) => candidate.providerId === providerId);
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
    this.write(providers);
    return toPublicProvider(provider);
  }

  clearProviderKey(providerId: string): PublicModelProviderConfig {
    const providers = this.load();
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`Unsupported model provider: ${providerId}`);
    }

    delete provider.apiKey;
    provider.updatedAt = new Date().toISOString();
    this.write(providers);
    return toPublicProvider(provider);
  }

  private load(): ModelProviderConfig[] {
    if (!existsSync(this.configPath)) {
      return structuredClone(defaultProviders);
    }

    const saved = JSON.parse(readFileSync(this.configPath, "utf8")) as ModelProviderConfig[];
    return defaultProviders.map((defaultProvider) => {
      const existing = saved.find((provider) => provider.providerId === defaultProvider.providerId);
      return {
        ...defaultProvider,
        ...existing
      };
    });
  }

  private write(providers: ModelProviderConfig[]): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.configPath, `${JSON.stringify(providers, null, 2)}\n`, {
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
