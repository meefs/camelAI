import { describe, expect, it } from "vitest";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  buildPublicLlmProviderConfig,
  DEFAULT_LLM_MODEL,
  getDefaultLlmModel,
  getLlmModelOptions,
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
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-auto",
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
] as const;

const CLAUDE_MODELS = [
  "opus-4.8",
  "fable-5",
  "sonnet",
  "haiku",
] as const;

const OPENROUTER_ONLY_MODELS = [
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
] as const;

const OPENROUTER_BYOK_CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
] as const;

const CAMELAI_HOSTED_ONLY_MODELS = ["deepseek-v4-auto"] as const;

const BEDROCK_OPENAI_MODELS = ["gpt-5.5", "gpt-5.4"] as const;

describe("llm provider config helpers", () => {
  it("defaults missing thread model to sonnet", () => {
    expect(normalizeLlmModel(undefined)).toBe(DEFAULT_LLM_MODEL);
    expect(normalizeLlmModel(undefined, "openai")).toBe(DEFAULT_CODEX_MODEL);
    expect(normalizeLlmModel(undefined, "openrouter")).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(getDefaultLlmModel("anthropic")).toBe(DEFAULT_LLM_MODEL);
    expect(getDefaultLlmModel("openai")).toBe(DEFAULT_CODEX_MODEL);
    expect(getDefaultLlmModel("openrouter")).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(
      getDefaultLlmModel("custom", { customApi: "openai-responses" }),
    ).toBe(DEFAULT_CODEX_MODEL);
    expect(
      getDefaultLlmModel("custom", { customApi: "anthropic-messages" }),
    ).toBe(DEFAULT_LLM_MODEL);
    expect(
      getDefaultLlmModel("custom", {
        customApi: "openai-responses",
        customModelId: "pi-custom-model",
      }),
    ).toBe("custom");
    expect(parseStoredLlmProviderConfig("{}")).toEqual({});
  });

  it("returns provider-specific model options", () => {
    expect(getLlmModelOptions("anthropic").map((option) => option.value)).toEqual([
      ...CLAUDE_MODELS,
    ]);
    expect(getLlmModelOptions("openai").map((option) => option.value)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(getLlmModelOptions("openrouter").map((option) => option.value)).toEqual([
      ...CLAUDE_MODELS,
      ...OPENROUTER_BYOK_CODEX_MODELS,
    ]);
    expect(getLlmModelOptions(null).map((option) => option.value)).toEqual([
      ...CLAUDE_MODELS,
      ...CODEX_MODELS,
    ]);
    expect(
      getLlmModelOptions("custom", { customApi: "openai-responses" }).map(
        (option) => option.value,
      ),
    ).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(
      getLlmModelOptions("custom", { customApi: "anthropic-messages" }).map(
        (option) => option.value,
      ),
    ).toEqual([...CLAUDE_MODELS]);
    expect(
      getLlmModelOptions("custom", {
        customApi: "openai-responses",
        customModelId: "pi-custom-model",
      }).map((option) => option.value),
    ).toEqual(["custom"]);
    for (const model of CODEX_MODELS) {
      expect(isLlmModel(model)).toBe(true);
    }
    expect(isLlmModel("gemini-3.1-pro-preview")).toBe(false);
    expect(isLlmModel("fable-5")).toBe(true);
    expect(normalizeLlmModel("gemini-3.1-pro-preview")).toBe(
      "gemini-3.5-flash",
    );
    expect(normalizeLlmModel("fable-5")).toBe("fable-5");
    expect(normalizeLlmModel("kimi-k2.6")).toBe("kimi-k2.7-code");
    expect(normalizeLlmModel("kimi-latest")).toBe("kimi-k2.7-code");
    expect(normalizeLlmModel("opus")).toBe("opus-4.8");
    expect(normalizeLlmModel("opus-4.7")).toBe("opus-4.8");
    expect(normalizeLlmModel("deepseek-v4-auto")).toBe("deepseek-v4-auto");
    expect(normalizeLlmModel("deepseek-v4-auto", "openrouter")).toBe(
      DEFAULT_OPENROUTER_MODEL,
    );
    expect(
      normalizeLlmModel("sonnet", "custom", { customApi: "openai-completions" }),
    ).toBe(DEFAULT_CODEX_MODEL);
    expect(
      normalizeLlmModel("gpt-5.4", "custom", { customApi: "anthropic-messages" }),
    ).toBe(DEFAULT_LLM_MODEL);
    expect(
      normalizeLlmModel(undefined, "custom", {
        customApi: "openai-completions",
        customModelId: "pi-custom-model",
      }),
    ).toBe("custom");
  });

  it("keeps BYOK provider-scoped and defaults hosted orgs to Claude", () => {
    expect(parseOrganizationExperimentalSettings(null)).toEqual({
      claude_proxy_models: false,
    });
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: "openai",
      }).map((option) => option.value),
    ).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }).map(
        (option) => option.value,
      ),
    ).toEqual([...CLAUDE_MODELS, ...CODEX_MODELS]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: "openrouter",
      }).map((option) => option.value),
    ).toEqual([
      ...CLAUDE_MODELS,
      ...OPENROUTER_BYOK_CODEX_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: "anthropic",
      }).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: "bedrock",
      }).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS, ...BEDROCK_OPENAI_MODELS]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: "bedrock",
        awsRegion: "us-west-2",
      }).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS, "gpt-5.4"]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: "bedrock",
        awsRegion: "eu-west-1",
      }).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS]);
    expect(
      getVisibleLlmModelOptions({ claude_proxy_models: false }, null, {
        orgProvider: null,
      }).map((option) => option.value),
    ).toEqual([
      ...CLAUDE_MODELS,
      ...CODEX_MODELS,
    ]);
  });

  it("shows only policy-allowed model families for new chats", () => {
    expect(
      getVisibleLlmModelOptions(
        { claude_proxy_models: true },
        null,
        { orgProvider: null },
      ).map((option) => option.value),
    ).toEqual([
      ...CLAUDE_MODELS,
      ...CODEX_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions(
        { claude_proxy_models: true },
        null,
        { orgProvider: "openai" },
      ).map((option) => option.value),
    ).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(
      getVisibleLlmModelOptions(
        { claude_proxy_models: true },
        null,
        { orgProvider: "openrouter" },
      ).map((option) => option.value),
    ).toEqual([
      ...CLAUDE_MODELS,
      ...OPENROUTER_BYOK_CODEX_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions(
        { claude_proxy_models: false },
        null,
        { orgProvider: "anthropic" },
      ).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS]);
  });

  it("keeps the current model visible for existing locked threads regardless of new-chat policy", () => {
    expect(
      getVisibleLlmModelOptions(
        { claude_proxy_models: false },
        "gpt-5.4-mini",
      ).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS, ...CODEX_MODELS]);
    expect(
      getVisibleLlmModelOptions(
        { claude_proxy_models: false },
        "sonnet",
      ).map((option) => option.value),
    ).toEqual([...CLAUDE_MODELS, ...CODEX_MODELS]);
  });

  it("validates new thread models against BYOK and proxy policy", () => {
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
    for (const model of CAMELAI_HOSTED_ONLY_MODELS) {
      expect(
        isLlmModelAllowedForNewThread(model, null, {
          claude_proxy_models: false,
        }),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, "openrouter", {
          claude_proxy_models: true,
        }),
      ).toBe(false);
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

  it("round-trips explicit region values", () => {
    const serialized = stringifyStoredLlmProviderConfig({
      aws_region: "us-west-2",
    });

    expect(parseStoredLlmProviderConfig(serialized)).toEqual({
      aws_region: "us-west-2",
    });
  });

  it("round-trips custom provider settings", () => {
    const serialized = stringifyStoredLlmProviderConfig({
      custom_name: "  Acme AI  ",
      custom_base_url: "https://api.example.com/v1/",
      custom_auth_type: "x-api-key",
      custom_api: "anthropic-messages",
      custom_model_id: "claude-custom",
    });

    expect(parseStoredLlmProviderConfig(serialized)).toEqual({
      custom_name: "Acme AI",
      custom_base_url: "https://api.example.com/v1",
      custom_auth_type: "x-api-key",
      custom_api: "anthropic-messages",
      custom_model_id: "claude-custom",
    });
    expect(getLlmModelOptions("custom").map((option) => option.value)).toEqual([
      ...CLAUDE_MODELS,
      ...OPENROUTER_BYOK_CODEX_MODELS,
    ]);
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
