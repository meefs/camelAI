import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error self-host worker module has no types
import makeBinding from "../../../infra/selfhost/ai-binding.worker.js";
import { AUXILIARY_AI_MODEL } from "../../../src/lib/auxiliary-ai.server";

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

    const result = await binding.run("@cf/meta/llama-3.2-3b-instruct", {
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
      model: "meta.llama3-2-3b-instruct",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 32,
    });
  });

  it("maps the auxiliary utility model to Bedrock Mantle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "🧠" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "bedrock-test-key",
      awsRegion: "us-west-2",
    });

    await binding.run(AUXILIARY_AI_MODEL, {
      messages: [{ role: "user", content: "Architecture planning" }],
      max_tokens: 32,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // A raw "@cf/..." id passed through to Bedrock means a missing alias.
    expect(JSON.parse(String(init.body)).model).toBe("meta.llama3-3-70b-instruct");
  });

  it("rejects unsupported providers", async () => {
    const binding = makeBinding({
      provider: "openrouter",
      apiKey: "sk-test",
      awsRegion: "us-east-1",
    });

    await expect(
      binding.run("@cf/meta/llama-3.2-3b-instruct", {
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/only supports bedrock/i);
  });
});
