import { afterEach, describe, expect, it, vi } from "vitest";

import bedrockProvider from "../../bedrock-provider/src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bedrock provider Opus routing", () => {
  it("advertises Opus 5 with Mantle-compatible model metadata", async () => {
    const response = await bedrockProvider.fetch(
      new Request("https://bedrock-provider.test/v1/models"),
      {},
    );
    const body = await response.json() as {
      data: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toContainEqual(expect.objectContaining({
      id: "claude-opus-5",
      bedrockModelId: "anthropic.claude-opus-5",
      name: "Claude Opus 5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsEagerToolInputStreaming: false,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    }));
    expect(body.data).not.toContainEqual(expect.objectContaining({
      id: "claude-opus-4-8",
    }));
  });

  it("migrates legacy Opus request bodies before forwarding to Mantle", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "msg_test", content: [] }),
    );

    const response = await bedrockProvider.fetch(
      new Request("https://bedrock-provider.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer bedrock-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "global.anthropic.claude-opus-4-8",
          max_tokens: 1024,
          thinking: {
            type: "enabled",
            budget_tokens: 768,
            display: "summarized",
          },
          temperature: 0.2,
          top_p: 0.8,
          top_k: 20,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      { BEDROCK_REGION: "us-west-2" },
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [url, init] = upstreamFetch.mock.calls[0];
    expect(url).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages",
    );
    const forwardedBody = JSON.parse(String(init?.body));
    expect(forwardedBody).toMatchObject({
      model: "anthropic.claude-opus-5",
      thinking: { type: "adaptive", display: "summarized" },
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(forwardedBody).not.toHaveProperty("thinking.budget_tokens");
    expect(forwardedBody).not.toHaveProperty("temperature");
    expect(forwardedBody).not.toHaveProperty("top_p");
    expect(forwardedBody).not.toHaveProperty("top_k");
  });

  it("re-enables adaptive thinking for legacy aliases at xhigh or max effort", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "msg_test", content: [] }),
    );

    const response = await bedrockProvider.fetch(
      new Request("https://bedrock-provider.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer bedrock-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-opus-4.8",
          max_tokens: 1024,
          thinking: { type: "disabled" },
          output_config: { effort: "max" },
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      {},
    );

    expect(response.status).toBe(200);
    const [, init] = upstreamFetch.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "anthropic.claude-opus-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
  });

  it("preserves valid disabled thinking at high effort", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "msg_test", content: [] }),
    );

    await bedrockProvider.fetch(
      new Request("https://bedrock-provider.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer bedrock-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "opus-4.7",
          max_tokens: 1024,
          thinking: { type: "disabled" },
          output_config: { effort: "high" },
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      {},
    );

    const [, init] = upstreamFetch.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "anthropic.claude-opus-5",
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
    });
  });
});
