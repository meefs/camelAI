import { afterEach, describe, expect, it, vi } from "vitest";

import {
  foldUsage,
  forwardedRequestHeaders,
  passthroughRoute,
  readUsage,
  runtimeModelFor,
} from "../src/agent-runtime/passthrough";
import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";
import { ChatThreadDO } from "../src/chat-thread-do";

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter";

function config(overrides: {
  model: Record<string, unknown>;
  apiKey?: string;
  billingSource?: "hosted" | "byok";
  usageProvider?: string;
  creditChargeable?: boolean;
}): PiResolvedModelConfig {
  return {
    apiKey: overrides.apiKey ?? "key",
    billingSource: overrides.billingSource ?? "byok",
    creditChargeable: overrides.creditChargeable ?? false,
    usageProvider: overrides.usageProvider ?? "openrouter",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    model: overrides.model,
  } as unknown as PiResolvedModelConfig;
}

const hosted = config({
  apiKey: "gateway-token",
  billingSource: "hosted",
  creditChargeable: true,
  usageProvider: "openrouter",
  model: {
    provider: "cloudflare-ai-gateway",
    api: "openai-completions",
    id: "anthropic/claude-sonnet-5:nitro",
    baseUrl: GATEWAY,
    headers: { "cf-aig-metadata": "{\"uid\":\"o:w:t\"}", "HTTP-Referer": "https://camelai.com", Authorization: null },
  },
});

describe("passthroughRoute", () => {
  it("sends hosted calls through the gateway with its token and metadata", () => {
    expect(passthroughRoute(hosted)).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5:nitro",
      upstreamBase: GATEWAY,
      headers: {
        "cf-aig-metadata": "{\"uid\":\"o:w:t\"}",
        "HTTP-Referer": "https://camelai.com",
        "cf-aig-authorization": "Bearer gateway-token",
      },
    });
    expect(runtimeModelFor("chiridion", passthroughRoute(hosted)!)).toBe("chiridion/openrouter/anthropic/claude-sonnet-5:nitro");
  });

  it("sends BYOK keys to the provider itself", () => {
    const openrouter = passthroughRoute(config({
      model: { provider: "anthropic", api: "anthropic-messages", id: "anthropic/claude-sonnet-5:nitro", baseUrl: "https://openrouter.ai/api", headers: { Authorization: "Bearer or-key" } },
      apiKey: "or-key",
    }));
    expect(openrouter).toMatchObject({ provider: "openrouter", upstreamBase: "https://openrouter.ai/api/v1", headers: { Authorization: "Bearer or-key" } });
    const anthropic = passthroughRoute(config({
      usageProvider: "anthropic",
      apiKey: "sk-ant",
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com" },
    }));
    expect(anthropic).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5", upstreamBase: "https://api.anthropic.com", headers: { "x-api-key": "sk-ant" } });
    const openai = passthroughRoute(config({
      usageProvider: "openai",
      apiKey: "sk-oa",
      model: { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" },
    }));
    expect(openai).toMatchObject({ provider: "openai", upstreamBase: "https://api.openai.com/v1", headers: { Authorization: "Bearer sk-oa" } });
  });

  it("has no route for Bedrock, Codex, custom endpoints or the gateway's dynamic routes", () => {
    expect(passthroughRoute(config({ usageProvider: "bedrock", model: { provider: "custom", id: "x", baseUrl: "https://bedrock-mantle.us-east-1.api.aws" } }))).toBeNull();
    expect(passthroughRoute(config({ usageProvider: "openai", model: { provider: "openai-codex", id: "gpt-5.6", baseUrl: "https://chatgpt.com/backend-api" } }))).toBeNull();
    expect(passthroughRoute(config({ usageProvider: "custom", model: { provider: "custom", id: "x", baseUrl: "https://llm.example" } }))).toBeNull();
    expect(passthroughRoute(config({ billingSource: "hosted", usageProvider: "compat", model: { provider: "cloudflare-ai-gateway", id: "dynamic/x", baseUrl: GATEWAY } }))).toBeNull();
  });
});

describe("forwardedRequestHeaders", () => {
  it("drops the runtime's credentials and adds the route's", () => {
    const headers = forwardedRequestHeaders([
      ["content-type", "application/json"],
      ["authorization", "Bearer runtime-jwt"],
      ["x-api-key", "runtime-jwt"],
      ["x-agent-runtime-identity", "runtime-jwt"],
      ["anthropic-version", "2023-06-01"],
      ["cookie", "a=b"],
    ], { provider: "anthropic", modelId: "m", upstreamBase: "https://api.anthropic.com", headers: { "x-api-key": "sk-ant" } });
    expect(Object.fromEntries(headers)).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant" });
  });
});

describe("usage", () => {
  it("reads Responses, Anthropic and Chat Completions usage", () => {
    expect(foldUsage(null, {
      type: "response.completed",
      response: { id: "resp_1", model: "anthropic/claude-sonnet-5", usage: { input_tokens: 1200, output_tokens: 80, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 20 }, cost: 0.0042 } },
    })).toEqual({ input: 200, output: 80, cacheRead: 1000, cacheWrite: 0, reasoning: 20, costUsd: 0.0042, responseId: "resp_1", responseModel: "anthropic/claude-sonnet-5" });
    let anthropic = foldUsage(null, { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 30, output_tokens: 1 } } });
    anthropic = foldUsage(anthropic, { type: "message_delta", usage: { output_tokens: 42 } });
    expect(anthropic).toEqual({ input: 10, output: 42, cacheRead: 500, cacheWrite: 30, reasoning: 0, responseId: "msg_1", responseModel: "claude-sonnet-5" });
    expect(foldUsage(null, { id: "c", choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } }))
      .toMatchObject({ input: 40, output: 5, cacheRead: 60 });
  });

  it("reads usage from an SSE body split across chunks", async () => {
    const sse = [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_",
      "tokens\":7,\"output_tokens\":3}}}\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of sse) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    expect(await readUsage(body, "text/event-stream")).toMatchObject({ input: 7, output: 3, responseId: "r" });
  });
});

describe("ChatThreadDO.runtimeProviderRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  type Forward = (this: unknown, request: Record<string, unknown>, caller: Record<string, string>) => Promise<Response>;
  const forward = (ChatThreadDO.prototype as unknown as { runtimeProviderRequest: Forward }).runtimeProviderRequest;
  const caller = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "user2" };
  const body = JSON.stringify({ model: "anthropic/claude-sonnet-5:nitro", input: [], stream: true });

  function fakeThread(route = passthroughRoute(hosted)) {
    const recordPiAssistantUsage = vi.fn(async () => {});
    const waits: Promise<unknown>[] = [];
    const fake = {
      chatContext: { orgId: "org1", workspaceId: "ws1", threadId: "t1" },
      isRuntimeAgentThread: () => true,
      currentRuntimeRoute: async () => ({ route, config: hosted }),
      assertPiUserLlmUsageAccess: vi.fn(async () => {}),
      recordPiAssistantUsage,
      piRuntimeThreadId: () => "t1",
      ctx: { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } },
    };
    return { fake, recordPiAssistantUsage, waits };
  }

  const request = (overrides: Record<string, unknown> = {}) => ({
    provider: "openrouter",
    path: "responses",
    search: "",
    method: "POST",
    headers: [["content-type", "application/json"], ["authorization", "Bearer runtime-jwt"], ["x-agent-runtime-identity", "runtime-jwt"]],
    body,
    ...overrides,
  });

  it("forwards the body untouched with the route's credential, streams the answer back and meters it", async () => {
    const answer = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"usage\":{\"input_tokens\":100,\"output_tokens\":9,\"input_tokens_details\":{\"cached_tokens\":60},\"cost\":0.001}}}\n\n";
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(answer, { headers: { "content-type": "text/event-stream" } }));
    const { fake, recordPiAssistantUsage, waits } = fakeThread();
    const response = await forward.call(fake, request(), caller);
    expect(await response.text()).toBe(answer);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/responses`);
    expect(init.body).toBe(body);
    const sent = Object.fromEntries(init.headers as Headers);
    expect(sent["cf-aig-authorization"]).toBe("Bearer gateway-token");
    expect(sent.authorization).toBeUndefined();
    expect(sent["x-agent-runtime-identity"]).toBeUndefined();
    expect(fake.assertPiUserLlmUsageAccess).toHaveBeenCalledWith(fake.chatContext, hosted, "user2");
    await Promise.all(waits);
    expect(recordPiAssistantUsage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", responseId: "r1", usage: expect.objectContaining({ input: 40, output: 9, cacheRead: 60, cost: { total: 0.001 } }) }),
      expect.any(Number), "hosted", true, "openrouter",
      expect.objectContaining({ userId: "user2", usageSurface: "agent" }),
    );
  });

  it("refuses calls for another provider or model than the thread's route, and routes it cannot take", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const { fake } = fakeThread();
    expect((await forward.call(fake, request({ provider: "anthropic" }), caller)).status).toBe(409);
    expect((await forward.call(fake, request({ body: JSON.stringify({ model: "openai/gpt-6" }) }), caller)).status).toBe(409);
    expect((await forward.call(fakeThread(null).fake, request(), caller)).status).toBe(409);
    expect((await forward.call(fake, request(), { ...caller, threadId: "other" })).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
