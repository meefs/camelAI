import { describe, expect, it } from "vitest";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  buildPublicLlmProviderConfig,
  DEFAULT_LLM_MODEL,
  getDefaultLlmModel,
  getDefaultThreadProvider,
  getAffectedChatHarnessesForLlmProviderChange,
  getAllowedChatHarnessesForNewThread,
  getChatHarnessesForLlmProvider,
  getLlmModelOptions,
  getProviderForModel,
  getVisibleLlmModelOptions,
  isLlmModel,
  isLlmModelAllowedForNewThread,
  parseOrganizationExperimentalSettings,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
} from "../../../src/lib/llm-provider-config";

const CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "grok-4.3",
] as const;

const CLAUDE_MODELS = [
  "opus-4.7",
  "opus",
  "sonnet",
  "haiku",
] as const;

const OPENROUTER_ONLY_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "grok-4.3",
] as const;

describe("llm provider config helpers", () => {
  it("defaults missing thread model to sonnet", () => {
    expect(normalizeLlmModel(undefined)).toBe(DEFAULT_LLM_MODEL);
    expect(normalizeLlmModel(undefined, "codex")).toBe(DEFAULT_CODEX_MODEL);
    expect(normalizeLlmModel(undefined, "codex", "openrouter")).toBe(
      DEFAULT_OPENROUTER_MODEL,
    );
    expect(getDefaultLlmModel("claude")).toBe(DEFAULT_LLM_MODEL);
    expect(getDefaultLlmModel("codex")).toBe(DEFAULT_CODEX_MODEL);
    expect(getDefaultLlmModel("codex", "openrouter")).toBe(
      DEFAULT_OPENROUTER_MODEL,
    );
    expect(parseStoredLlmProviderConfig("{}")).toEqual({});
  });

  it("returns provider-specific model options", () => {
    expect(getLlmModelOptions("claude").map((option) => option.value)).toEqual([
      ...CLAUDE_MODELS,
    ]);
    expect(getLlmModelOptions("codex").map((option) => option.value)).toEqual(
      CODEX_MODELS,
    );
    for (const model of CODEX_MODELS) {
      expect(isLlmModel(model, "codex")).toBe(true);
    }
  });

  it("keeps BYOK provider-scoped and defaults proxy orgs to Claude", () => {
    expect(parseOrganizationExperimentalSettings(null)).toEqual({
      claude_proxy_models: false,
    });
    expect(
      getDefaultThreadProvider("openai", { claude_proxy_models: false }),
    ).toBe("codex");
    expect(
      getDefaultThreadProvider("openrouter", { claude_proxy_models: false }),
    ).toBe("codex");
    expect(getDefaultThreadProvider(null, { claude_proxy_models: false })).toBe(
      "claude",
    );
    expect(
      getDefaultThreadProvider("anthropic", { claude_proxy_models: false }),
    ).toBe("claude");
    expect(
      getDefaultThreadProvider("bedrock", { claude_proxy_models: false }),
    ).toBe("claude");
    expect(
      getVisibleLlmModelOptions("codex", { claude_proxy_models: false }).map(
        (option) => option.value,
      ),
    ).toEqual(CODEX_MODELS);
  });

  it("shows only policy-allowed model families for new chats", () => {
    expect(
      getVisibleLlmModelOptions(
        "codex",
        { claude_proxy_models: true },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: null },
      ).map((option) => option.value),
    ).toEqual([
      ...CLAUDE_MODELS,
      ...CODEX_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions(
        "codex",
        { claude_proxy_models: true },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: "openai" },
      ).map((option) => option.value),
    ).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(
      getVisibleLlmModelOptions(
        "codex",
        { claude_proxy_models: true },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: "openrouter" },
      ).map((option) => option.value),
    ).toEqual([
      ...CODEX_MODELS,
      ...CLAUDE_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions(
        "claude",
        { claude_proxy_models: false },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: "anthropic" },
      ).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS]);
  });

  it("keeps the current model visible for existing locked threads regardless of new-chat policy", () => {
    expect(
      getVisibleLlmModelOptions(
        "codex",
        { claude_proxy_models: false },
        "gpt-5.4-mini",
      ).map((option) => option.value),
    ).toEqual(CODEX_MODELS);
    expect(
      getVisibleLlmModelOptions(
        "claude",
        { claude_proxy_models: false },
        "sonnet",
      ).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS]);
  });

  it("validates new thread models against BYOK and proxy policy", () => {
    expect(
      getAllowedChatHarnessesForNewThread(null, { claude_proxy_models: false }),
    ).toEqual(["claude", "codex"]);
    expect(
      getAllowedChatHarnessesForNewThread(null, { claude_proxy_models: true }),
    ).toEqual(["claude", "codex"]);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4", null, {
        claude_proxy_models: false,
      }),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("sonnet", null, {
        claude_proxy_models: false,
      }),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("sonnet", "anthropic", {
        claude_proxy_models: false,
      }),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4", "anthropic", {
        claude_proxy_models: false,
      }),
    ).toBe(false);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4", "openai", {
        claude_proxy_models: true,
      }),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("sonnet", "openai", {
        claude_proxy_models: true,
      }),
    ).toBe(false);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4-mini", "openrouter", {
        claude_proxy_models: true,
      }),
    ).toBe(true);
    for (const model of OPENROUTER_ONLY_MODELS) {
      expect(
        isLlmModelAllowedForNewThread(model, "openrouter", {
          claude_proxy_models: true,
        }),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, null, {
          claude_proxy_models: false,
        }),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, "openai", {
          claude_proxy_models: true,
        }),
      ).toBe(false);
    }
    expect(
      isLlmModelAllowedForNewThread("haiku", "openrouter", {
        claude_proxy_models: true,
      }),
    ).toBe(true);
  });

  it("infers the thread provider from the selected model", () => {
    expect(getProviderForModel("gpt-5.4", "claude")).toBe("codex");
    expect(getProviderForModel("gpt-5.5", "claude")).toBe("codex");
    expect(getProviderForModel("gpt-5.4-mini", "claude")).toBe("codex");
    expect(getProviderForModel("kimi-k2.6", "claude")).toBe("codex");
    expect(getProviderForModel("grok-4.3", "claude")).toBe("codex");
    expect(getProviderForModel("gemini-3-flash-preview", "claude")).toBe(
      "codex",
    );
    expect(getProviderForModel("gemini-3.1-pro-preview", "claude")).toBe(
      "codex",
    );
    expect(getProviderForModel("deepseek-v4-pro", "claude")).toBe("codex");
    expect(getProviderForModel("deepseek-v4-flash", "claude")).toBe("codex");
    expect(getProviderForModel("haiku", "codex")).toBe("claude");
    expect(getProviderForModel("sonnet", "codex")).toBe("claude");
    expect(getProviderForModel("opus-4.7", "codex")).toBe("claude");
    expect(getProviderForModel(undefined, "claude")).toBe("claude");
  });

  it("maps org BYOK providers to the affected chat harnesses", () => {
    expect(getChatHarnessesForLlmProvider("anthropic")).toEqual(["claude"]);
    expect(getChatHarnessesForLlmProvider("bedrock")).toEqual(["claude"]);
    expect(getChatHarnessesForLlmProvider("openai")).toEqual(["codex"]);
    expect(getChatHarnessesForLlmProvider("openrouter")).toEqual([
      "codex",
      "claude",
    ]);
    expect(getChatHarnessesForLlmProvider(null)).toEqual([]);

    expect(
      getAffectedChatHarnessesForLlmProviderChange("openai", "anthropic"),
    ).toEqual(["codex", "claude"]);
    expect(
      getAffectedChatHarnessesForLlmProviderChange("anthropic", "bedrock"),
    ).toEqual(["claude"]);
    expect(
      getAffectedChatHarnessesForLlmProviderChange("openai", null),
    ).toEqual(["codex"]);
  });

  it("round-trips explicit region values", () => {
    const serialized = stringifyStoredLlmProviderConfig({
      aws_region: "us-west-2",
    });

    expect(parseStoredLlmProviderConfig(serialized)).toEqual({
      aws_region: "us-west-2",
    });
  });

  it("builds a public config with a redacted key hint", async () => {
    const encrypted = await encryptCredentials(
      { api_key: "sk-ant-test-secret-1234" },
      "test-secret-key",
    );

    const config = await buildPublicLlmProviderConfig(
      {
        provider: "anthropic",
        credentials_encrypted: encrypted,
        config: "{}",
        created_by: "user_123",
        created_at: 100,
        updated_at: 200,
      },
      "test-secret-key",
    );

    expect(config).toEqual({
      provider: "anthropic",
      config: {},
      key_hint: "sk-ant-t...",
      created_by: "user_123",
      created_at: 100,
      updated_at: 200,
    });
  });
});
