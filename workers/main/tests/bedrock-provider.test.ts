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

  it("upgrades legacy Opus IDs and forwards the suffix-free ID to Mantle", async () => {
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
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "anthropic.claude-opus-5",
    });
  });
});
