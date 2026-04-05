import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
} from "../../desktop/shared/protocol";
import { getHostClaudeCredentialsJson } from "../../desktop/backend/anthropic";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_OPENAI_MODEL = "gpt-5.4";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.1-codex";
const DEFAULT_THOUGHT_LEVEL =
  process.env.DESKTOP_AGENTOS_THOUGHT_LEVEL?.trim() || "medium";
const HOST_PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim()
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : resolve(homedir(), ".pi", "agent");
const HOST_PI_AUTH_PATH = resolve(HOST_PI_AGENT_DIR, "auth.json");
const OPENROUTER_MODELS = getModels("openrouter");
const OPENROUTER_MODELS_BY_ID = new Map(
  OPENROUTER_MODELS.map((model) => [model.id, model]),
);

type PiAuthCredential = {
  type?: unknown;
  key?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
};

type PiAuthFile = Record<string, PiAuthCredential>;

function getEnvOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

function getEnvAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

function getEnvOpenRouterApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY?.trim() || null;
}

function readHostPiAuthFile(): PiAuthFile | null {
  if (!existsSync(HOST_PI_AUTH_PATH)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(HOST_PI_AUTH_PATH, "utf8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PiAuthFile)
      : null;
  } catch {
    return null;
  }
}

export function readHostPiAuthFileContents(): string | null {
  if (!existsSync(HOST_PI_AUTH_PATH)) {
    return null;
  }

  try {
    const raw = readFileSync(HOST_PI_AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? raw : null;
  } catch {
    return null;
  }
}

function getPiCredential(providerId: string): PiAuthCredential | null {
  const authFile = readHostPiAuthFile();
  const credential = authFile?.[providerId];
  return credential && typeof credential === "object" ? credential : null;
}

function isClaudeModel(model: string | null | undefined): boolean {
  return Boolean(model?.startsWith("claude-"));
}

function isOpenRouterModel(model: string | null | undefined): boolean {
  return Boolean(model && OPENROUTER_MODELS_BY_ID.has(model));
}

function hasOpenRouterAuth(): boolean {
  return hasPiApiKey("openrouter") || Boolean(getEnvOpenRouterApiKey());
}

function getHostClaudeOAuthToken(): string | null {
  const raw = getHostClaudeCredentialsJson();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: unknown;
      };
    };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function getAuthStateForModel(model: string | null | undefined): DesktopAuthState {
  if (isClaudeModel(model)) {
    if (hasPiOAuth("anthropic")) {
      return {
        provider: "agentos",
        available: true,
        source: "provider-account",
        label: "Anthropic OAuth via Pi",
      };
    }

    if (getHostClaudeOAuthToken()) {
      return {
        provider: "agentos",
        available: true,
        source: "provider-account",
        label: "Claude Code OAuth",
      };
    }

    if (hasPiApiKey("anthropic") || getEnvAnthropicApiKey()) {
      return {
        provider: "agentos",
        available: true,
        source: "api-key",
        label: "Anthropic API key via Pi/env",
      };
    }

    return {
      provider: "agentos",
      available: false,
      source: "missing",
      label: "Run `pi /login anthropic` or set ANTHROPIC_API_KEY",
    };
  }

  if (isOpenRouterModel(model)) {
    if (hasOpenRouterAuth()) {
      return {
        provider: "agentos",
        available: true,
        source: "api-key",
        label: "OpenRouter API key via Pi/env",
      };
    }

    return {
      provider: "agentos",
      available: false,
      source: "missing",
      label: "Create an OpenRouter app key and set OPENROUTER_API_KEY",
    };
  }

  if (hasPiOAuth("openai-codex")) {
    return {
      provider: "agentos",
      available: true,
      source: "provider-account",
      label: "OpenAI Codex OAuth via Pi",
    };
  }

  if (hasPiApiKey("openai") || getEnvOpenAiApiKey()) {
    return {
      provider: "agentos",
      available: true,
      source: "api-key",
      label: "OpenAI API key via Pi/env",
    };
  }

  return {
    provider: "agentos",
    available: false,
    source: "missing",
    label: "Run `pi /login openai-codex` or set OPENAI_API_KEY",
  };
}

function hasPiOAuth(providerId: string): boolean {
  const credential = getPiCredential(providerId);
  return (
    credential?.type === "oauth" &&
    typeof credential.access === "string" &&
    credential.access.length > 0
  );
}

function hasPiApiKey(providerId: string): boolean {
  const credential = getPiCredential(providerId);
  return (
    credential?.type === "api_key" &&
    typeof credential.key === "string" &&
    credential.key.length > 0
  );
}

function inferProviderForModel(
  model: string,
): "anthropic" | "openai" | "openai-codex" | "openrouter" {
  if (model.startsWith("claude-")) {
    return "anthropic";
  }

  if (isOpenRouterModel(model)) {
    return "openrouter";
  }

  return hasPiOAuth("openai-codex") ? "openai-codex" : "openai";
}

function getDefaultAgentOsModel(): DesktopModel {
  const explicitModel = process.env.DESKTOP_AGENTOS_MODEL?.trim();
  if (explicitModel) {
    return explicitModel;
  }

  if (
    hasPiOAuth("anthropic") ||
    getHostClaudeOAuthToken() ||
    hasPiApiKey("anthropic") ||
    getEnvAnthropicApiKey()
  ) {
    return DEFAULT_ANTHROPIC_MODEL;
  }

  if (hasPiOAuth("openai-codex") || hasPiApiKey("openai") || getEnvOpenAiApiKey()) {
    return DEFAULT_OPENAI_MODEL;
  }

  if (hasOpenRouterAuth()) {
    return DEFAULT_OPENROUTER_MODEL;
  }

  return DEFAULT_OPENAI_MODEL;
}

function getModelLabel(model: string): string {
  const openRouterModel = OPENROUTER_MODELS_BY_ID.get(model);
  if (openRouterModel) {
    return `OpenRouter · ${openRouterModel.name}`;
  }
  if (model === "gpt-5.4") {
    return "GPT-5.4 via Pi";
  }
  if (model === "gpt-5-codex") {
    return "GPT-5 Codex via Pi";
  }
  if (model === "claude-sonnet-4-20250514") {
    return "Claude Sonnet 4 via Pi";
  }
  return `${model} via Pi`;
}

function getModelCandidates(): DesktopModel[] {
  const models = [DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL];
  if (hasOpenRouterAuth()) {
    models.push(...OPENROUTER_MODELS.map((model) => model.id));
  }
  return models;
}

function getAvailableModels(): DesktopModelOption[] {
  const models = Array.from(new Set(getModelCandidates())).filter((model) =>
    getAuthStateForModel(model).available,
  );

  if (models.length === 0) {
    const fallbackModel = getDefaultAgentOsModel();
    return [
      {
        id: fallbackModel,
        label: getModelLabel(fallbackModel),
        provider: "agentos",
      },
    ];
  }

  return models.map((model) => ({
    id: model,
    label: getModelLabel(model),
    provider: "agentos",
  }));
}

export function normalizeAgentOsModel(
  value: string | null | undefined,
): DesktopModel {
  const normalized = value?.trim();
  const availableModels = getAvailableModels().map((model) => model.id);
  if (normalized && availableModels.includes(normalized)) {
    return normalized;
  }
  return getDefaultAgentOsModel();
}

export function getAgentOsAuthState(model?: DesktopModel): DesktopAuthState {
  return getAuthStateForModel(model ?? getDefaultAgentOsModel());
}

export function buildAgentOsPiSettings(
  model: string,
  thoughtLevel: string,
): Record<string, unknown> {
  return {
    defaultProvider: inferProviderForModel(model),
    defaultModel: model,
    defaultThinkingLevel: thoughtLevel,
    quietStartup: true,
  };
}

export const agentOsProvider: DesktopProviderDefinition = {
  id: "agentos",
  label: "AgentOS",
  transport: "agentos",
  option: {
    id: "agentos",
    label: "AgentOS",
  },
  getDefaultModel() {
    return getDefaultAgentOsModel();
  },
  getAvailableModels: getAvailableModels,
  normalizeModel: normalizeAgentOsModel,
  getAuthState: getAgentOsAuthState,
  buildSessionEnv(model) {
    const env: Record<string, string> = {
      DESKTOP_PROVIDER: "agentos",
      DESKTOP_MODEL: model,
    };

    const openAiApiKey = getEnvOpenAiApiKey();
    if (
      openAiApiKey &&
      !hasPiOAuth("openai-codex") &&
      !isClaudeModel(model) &&
      !isOpenRouterModel(model)
    ) {
      env.OPENAI_API_KEY = openAiApiKey;
    }

    const openRouterApiKey = getEnvOpenRouterApiKey();
    if (openRouterApiKey && !hasPiApiKey("openrouter") && isOpenRouterModel(model)) {
      env.OPENROUTER_API_KEY = openRouterApiKey;
    }

    const anthropicApiKey = getEnvAnthropicApiKey();
    const hostClaudeOAuthToken = isClaudeModel(model)
      ? getHostClaudeOAuthToken()
      : null;
    if (hostClaudeOAuthToken && !hasPiOAuth("anthropic")) {
      env.ANTHROPIC_OAUTH_TOKEN = hostClaudeOAuthToken;
    } else if (anthropicApiKey && !hasPiOAuth("anthropic") && isClaudeModel(model)) {
      env.ANTHROPIC_API_KEY = anthropicApiKey;
    }

    return env;
  },
  getThoughtLevel() {
    return DEFAULT_THOUGHT_LEVEL;
  },
};
