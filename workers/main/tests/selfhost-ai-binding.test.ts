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
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Generated title" }],
            },
          ],
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
      temperature: 0.2,
    });

    expect(result).toEqual({ response: "Generated title" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer bedrock-test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "openai.gpt-5.6-terra",
      input: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_output_tokens: 32,
    });
  });

  it("maps the auxiliary utility model to Bedrock Mantle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
      JSON.stringify({ output_text: "🧠" }),
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
    expect(JSON.parse(String(init.body)).model).toBe("openai.gpt-5.6-terra");
  });

  it("tries the next supported region when Bedrock reports the model missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              type: "not_found_error",
              message: "The model does not exist in this region",
            },
          }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "Fallback title" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "bedrock-test-key",
      awsRegion: "us-east-1",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Fallback" }],
      }),
    ).resolves.toEqual({ response: "Fallback title" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses",
      "https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses",
    ]);
  });

  it("does not change regions for authentication failures", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
        status: 401,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "invalid-key",
      awsRegion: "us-east-1",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "No retry" }],
      }),
    ).rejects.toThrow(/authentication_error/);
    expect(fetchMock).toHaveBeenCalledOnce();
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
