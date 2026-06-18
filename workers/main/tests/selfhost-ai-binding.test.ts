import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error self-host worker module has no types
import makeBinding from "../../../infra/selfhost/ai-binding.worker.js";

describe("selfhost ai binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps Workers AI auxiliary model ids to Bedrock Mantle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Generated title" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "bedrock-test-key",
      awsRegion: "us-west-2",
    });

    const result = await binding.run("@cf/zai-org/glm-4.7-flash", {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 32,
    });

    expect(result).toEqual({
      choices: [{ message: { content: "Generated title" } }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bedrock-mantle.us-west-2.api.aws/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer bedrock-test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "zai.glm-4.7-flash",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 32,
    });
  });

  it("rejects unsupported providers", async () => {
    const binding = makeBinding({
      provider: "openrouter",
      apiKey: "sk-test",
      awsRegion: "us-east-1",
    });

    await expect(
      binding.run("@cf/zai-org/glm-4.7-flash", {
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/only supports bedrock/i);
  });
});
