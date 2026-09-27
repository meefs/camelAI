import { describe, expect, it } from "vitest";

import { runtimeModelRoute } from "../src/agent-runtime/model-routes";
import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CODEX_TOKEN = `${b64url({})}.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })}.sig`;

function config(overrides: { model: Record<string, unknown>; billingSource?: "hosted" | "byok"; usageProvider: string; apiKey?: string }): PiResolvedModelConfig {
  return {
    apiKey: overrides.apiKey ?? "key",
    billingSource: overrides.billingSource ?? "byok",
    creditChargeable: overrides.billingSource === "hosted",
    usageProvider: overrides.usageProvider,
    provider: "anthropic",
    modelId: "m",
    model: overrides.model,
  } as unknown as PiResolvedModelConfig;
}

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/acct/gw";
const org = { orgId: "org1" };

describe("runtimeModelRoute", () => {
  it("runs hosted models with the hosted key scope and their OpenRouter id", () => {
    expect(runtimeModelRoute(config({
      billingSource: "hosted", usageProvider: "openrouter",
      model: { provider: "cloudflare-ai-gateway", id: "anthropic/claude-sonnet-5:nitro", baseUrl: `${GATEWAY}/openrouter` },
    }), org)).toEqual({ kind: "scope", model: "openrouter/anthropic/claude-sonnet-5:nitro", keyScope: "hosted" });
  });

  it("runs the free tier as GPT-6 Luna, and no other dynamic route", () => {
    const free = config({ billingSource: "hosted", usageProvider: "compat", model: { provider: "cloudflare-ai-gateway", id: "dynamic/luna-muse-fallback", baseUrl: `${GATEWAY}/compat` } });
    expect(runtimeModelRoute(free, { ...org, freeTier: true })).toEqual({ kind: "scope", model: "openrouter/openai/gpt-6-luna", keyScope: "hosted" });
    expect(runtimeModelRoute(free, org)).toBeNull();
  });

  it("runs BYOK models with the org's key scope", () => {
    const scope = "org_org1";
    expect(runtimeModelRoute(config({ usageProvider: "anthropic", model: { provider: "anthropic", id: "claude-opus-5", baseUrl: "https://api.anthropic.com" } }), org))
      .toEqual({ kind: "scope", model: "anthropic/claude-opus-5", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "openai", model: { provider: "openai", id: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" } }), org))
      .toEqual({ kind: "scope", model: "openai/gpt-5.6-sol", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "openrouter", model: { provider: "anthropic", id: "anthropic/claude-sonnet-5:nitro", baseUrl: "https://openrouter.ai/api" } }), org))
      .toEqual({ kind: "scope", model: "openrouter/anthropic/claude-sonnet-5:nitro", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "anthropic-messages", id: "anthropic.claude-sonnet-5", baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/anthropic" } }), org))
      .toEqual({ kind: "scope", model: "amazon-bedrock/eu.anthropic.claude-sonnet-5", keyScope: scope });
  });

  it("sends the ChatGPT subscription through chiridion's Codex forwarder", () => {
    expect(runtimeModelRoute(config({ usageProvider: "openai", apiKey: CODEX_TOKEN, model: { provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api/codex" } }), org))
      .toEqual({ kind: "codex", model: "chiridion/openai-codex/gpt-5.6-sol" });
  });

  it("has no route for custom endpoints or Bedrock OpenAI models", () => {
    expect(runtimeModelRoute(config({ usageProvider: "custom", model: { provider: "custom", id: "x", baseUrl: "https://llm.example" } }), org)).toBeNull();
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "openai-responses", id: "openai.gpt", baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1" } }), org)).toBeNull();
  });
});
