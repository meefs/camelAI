import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadAgentOsModule() {
  vi.resetModules();
  vi.doMock("../desktop/backend/anthropic", () => ({
    getHostClaudeCredentialsJson: () => null,
  }));
  return import("../desktop-agentos/backend/agentos");
}

describe("desktop-agentos openrouter support", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../desktop/backend/anthropic");
    process.env = { ...ORIGINAL_ENV };
  });

  it("surfaces OpenRouter models when OPENROUTER_API_KEY is set", async () => {
    process.env.OPENROUTER_API_KEY = "or-test-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DESKTOP_AGENTOS_MODEL;
    process.env.PI_CODING_AGENT_DIR = "/tmp/desktop-agentos-openrouter-empty-auth";

    const {
      agentOsProvider,
      buildAgentOsPiSettings,
      getAgentOsAuthState,
      normalizeAgentOsModel,
    } = await loadAgentOsModule();

    const availableModels = agentOsProvider.getAvailableModels();
    const openRouterModel = availableModels.find(
      (model) => model.id === "openai/gpt-5.1-codex",
    );

    expect(openRouterModel).toMatchObject({
      id: "openai/gpt-5.1-codex",
      provider: "agentos",
      label: expect.stringContaining("OpenRouter"),
    });

    expect(normalizeAgentOsModel("openai/gpt-5.1-codex")).toBe("openai/gpt-5.1-codex");
    expect(getAgentOsAuthState("openai/gpt-5.1-codex")).toMatchObject({
      available: true,
      source: "api-key",
      label: "OpenRouter API key via Pi/env",
    });
    expect(buildAgentOsPiSettings("openai/gpt-5.1-codex", "medium")).toMatchObject({
      defaultProvider: "openrouter",
      defaultModel: "openai/gpt-5.1-codex",
      defaultThinkingLevel: "medium",
    });
    expect(agentOsProvider.getDefaultModel()).toBe("openai/gpt-5.1-codex");
  });

  it("stages only the OpenRouter key for OpenRouter models", async () => {
    process.env.OPENROUTER_API_KEY = "or-test-key";
    process.env.OPENAI_API_KEY = "sk-test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DESKTOP_AGENTOS_MODEL;
    process.env.PI_CODING_AGENT_DIR = "/tmp/desktop-agentos-openrouter-empty-auth";

    const { agentOsProvider } = await loadAgentOsModule();
    const env = agentOsProvider.buildSessionEnv("openai/gpt-5.1-codex");

    expect(env.OPENROUTER_API_KEY).toBe("or-test-key");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DESKTOP_MODEL).toBe("openai/gpt-5.1-codex");
  });
});
