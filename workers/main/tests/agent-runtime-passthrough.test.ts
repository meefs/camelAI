import { afterEach, describe, expect, it, vi } from "vitest";

import {
  eventStreamPayloads,
  foldUsage,
  passthroughRoute,
  readUsage,
  runtimeModelFor,
  upstreamCall,
  type PassthroughRoute,
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

const bedrock = config({
  usageProvider: "bedrock",
  apiKey: "bedrock-api-key",
  model: { provider: "custom", api: "anthropic-messages", id: "anthropic.claude-sonnet-5", baseUrl: "https://bedrock-mantle.us-west-2.api.aws/anthropic" },
});

describe("passthroughRoute", () => {
  it("sends hosted calls through the gateway with its token and metadata", () => {
    expect(passthroughRoute(hosted)).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5:nitro",
      kind: "gateway",
      upstreamBase: GATEWAY,
      credential: "gateway-token",
      headers: { "cf-aig-metadata": "{\"uid\":\"o:w:t\"}", "HTTP-Referer": "https://camelai.com" },
    });
    expect(runtimeModelFor("chiridion", passthroughRoute(hosted)!)).toBe("chiridion/openrouter/anthropic/claude-sonnet-5:nitro");
  });

  it("sends BYOK keys to the provider itself, and Bedrock keys to bedrock-runtime in the org's region", () => {
    expect(passthroughRoute(config({
      model: { provider: "anthropic", api: "anthropic-messages", id: "anthropic/claude-sonnet-5:nitro", baseUrl: "https://openrouter.ai/api", headers: { Authorization: "Bearer or-key" } },
      apiKey: "or-key",
    }))).toMatchObject({ provider: "openrouter", kind: "direct", upstreamBase: "https://openrouter.ai/api", credential: "or-key", headers: {} });
    expect(passthroughRoute(config({
      usageProvider: "anthropic",
      apiKey: "sk-ant",
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com" },
    }))).toMatchObject({ provider: "anthropic", upstreamBase: "https://api.anthropic.com", credential: "sk-ant" });
    expect(passthroughRoute(config({
      usageProvider: "openai",
      apiKey: "sk-oa",
      model: { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" },
    }))).toMatchObject({ provider: "openai", upstreamBase: "https://api.openai.com/v1" });
    expect(passthroughRoute(bedrock)).toEqual({
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-5",
      kind: "bedrock",
      upstreamBase: "https://bedrock-runtime.us-west-2.amazonaws.com",
      credential: "bedrock-api-key",
      headers: {},
      region: "us-west-2",
    });
  });

  it("has no route for Codex, custom endpoints, Bedrock OpenAI models or the gateway's dynamic routes", () => {
    expect(passthroughRoute(config({ usageProvider: "openai", model: { provider: "openai-codex", id: "gpt-5.6", baseUrl: "https://chatgpt.com/backend-api" } }))).toBeNull();
    expect(passthroughRoute(config({ usageProvider: "custom", model: { provider: "custom", id: "x", baseUrl: "https://llm.example" } }))).toBeNull();
    expect(passthroughRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "openai-responses", id: "openai.gpt", baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1" } }))).toBeNull();
    expect(passthroughRoute(config({ billingSource: "hosted", usageProvider: "compat", model: { provider: "cloudflare-ai-gateway", id: "dynamic/x", baseUrl: GATEWAY } }))).toBeNull();
  });
});

describe("upstreamCall", () => {
  const runtimeHeaders = (key: "authorization" | "x-api-key"): [string, string][] => [
    ["content-type", "application/json"],
    [key, key === "authorization" ? "Bearer runtime-jwt" : "runtime-jwt"],
    ["x-agent-runtime-identity", "runtime-jwt"],
    ["anthropic-version", "2023-06-01"],
    ["cookie", "a=b"],
  ];
  const direct: PassthroughRoute = { provider: "openrouter", modelId: "anthropic/claude-sonnet-5", kind: "direct", upstreamBase: "https://openrouter.ai/api", credential: "or-key", headers: {} };
  const body = JSON.stringify({ model: "anthropic/claude-sonnet-5" });

  it("puts the real key in the header slot the runtime's client used", () => {
    const messages = upstreamCall(direct, "v1/messages", "", runtimeHeaders("x-api-key"), body);
    expect(messages).toMatchObject({ url: "https://openrouter.ai/api/v1/messages" });
    expect(Object.fromEntries((messages as { headers: Headers }).headers)).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "or-key" });
    const responses = upstreamCall(direct, "v1/responses", "", runtimeHeaders("authorization"), body) as { url: string; headers: Headers };
    expect(responses.url).toBe("https://openrouter.ai/api/v1/responses");
    expect(responses.headers.get("authorization")).toBe("Bearer or-key");
    expect(responses.headers.get("x-agent-runtime-identity")).toBeNull();
  });

  it("maps OpenRouter paths onto the gateway's /api/v1 prefix with the gateway token only", () => {
    const call = upstreamCall(passthroughRoute(hosted)!, "v1/responses", "", runtimeHeaders("authorization"), JSON.stringify({ model: "anthropic/claude-sonnet-5:nitro" })) as { url: string; headers: Headers };
    expect(call.url).toBe(`${GATEWAY}/responses`);
    expect(call.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("cf-aig-metadata")).toBe("{\"uid\":\"o:w:t\"}");
    // Anthropic models stay on OpenRouter's Messages API (prompt caching): /api/v1/messages.
    const messages = upstreamCall(passthroughRoute(hosted)!, "v1/messages", "", runtimeHeaders("x-api-key"), JSON.stringify({ model: "anthropic/claude-sonnet-5:nitro" })) as { url: string; headers: Headers };
    expect(messages.url).toBe(`${GATEWAY}/messages`);
    expect(messages.headers.get("x-api-key")).toBeNull();
    // The gateway's Anthropic prefix is api.anthropic.com itself: v1/messages stays.
    const anthropicGateway = { ...passthroughRoute(hosted)!, provider: "anthropic" as const, upstreamBase: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic", modelId: "claude-sonnet-5" };
    expect(upstreamCall(anthropicGateway, "v1/messages", "", [], JSON.stringify({ model: "claude-sonnet-5" })))
      .toMatchObject({ url: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages" });
  });

  it("refuses another model", () => {
    expect(upstreamCall(direct, "v1/responses", "", [], JSON.stringify({ model: "openai/gpt-6" }))).toEqual({ error: expect.stringMatching(/not openai\/gpt-6/) });
  });

  it("sends Bedrock calls to the region's bedrock-runtime with the org's Bedrock API key, checking region and model", () => {
    const route = passthroughRoute(bedrock)!;
    const call = upstreamCall(route, "us-west-2/model/anthropic.claude-sonnet-5/converse-stream", "", runtimeHeaders("authorization"), "{\"messages\":[]}") as { url: string; headers: Headers };
    expect(call.url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-5/converse-stream");
    expect(call.headers.get("authorization")).toBe("Bearer bedrock-api-key");
    expect(upstreamCall(route, "us-east-1/model/anthropic.claude-sonnet-5/converse-stream", "", [], "{}")).toEqual({ error: expect.stringMatching(/region/) });
    expect(upstreamCall(route, "us-west-2/model/anthropic.claude-opus-5/converse", "", [], "{}")).toEqual({ error: expect.stringMatching(/model/) });
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

  it("reads Bedrock Converse usage from its event stream", async () => {
    const frame = (eventType: string, payload: unknown) => {
      const name = new TextEncoder().encode(":event-type");
      const value = new TextEncoder().encode(eventType);
      const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length);
      headers[0] = name.length; headers.set(name, 1); headers[1 + name.length] = 7;
      new DataView(headers.buffer).setUint16(2 + name.length, value.length); headers.set(value, 4 + name.length);
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const total = 12 + headers.length + body.length + 4;
      const bytes = new Uint8Array(total);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, total); view.setUint32(4, headers.length);
      bytes.set(headers, 12); bytes.set(body, 12 + headers.length);
      return bytes;
    };
    const whole = new Uint8Array([
      ...frame("contentBlockDelta", { delta: { text: "hi" } }),
      ...frame("metadata", { usage: { inputTokens: 30, outputTokens: 4, cacheReadInputTokens: 900, cacheWriteInputTokens: 12 }, metrics: { latencyMs: 5 } }),
    ]);
    expect(eventStreamPayloads(whole).payloads).toHaveLength(2);
    // Split mid-frame, as a network stream would.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(whole.slice(0, 50));
        controller.enqueue(whole.slice(50));
        controller.close();
      },
    });
    expect(await readUsage(body, "application/vnd.amazon.eventstream")).toEqual({ input: 30, output: 4, cacheRead: 900, cacheWrite: 12, reasoning: 0 });
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
    path: "v1/responses",
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

  it("forwards a Bedrock Converse stream with the org's Bedrock API key and meters its metadata usage", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ usage: { inputTokens: 11, outputTokens: 2 } }));
    const total = 12 + payload.length + 4;
    const frame = new Uint8Array(total);
    new DataView(frame.buffer).setUint32(0, total);
    frame.set(payload, 12);
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(frame, { headers: { "content-type": "application/vnd.amazon.eventstream" } }));
    const route = passthroughRoute(bedrock);
    const { fake, recordPiAssistantUsage, waits } = fakeThread(route);
    fake.currentRuntimeRoute = async () => ({ route, config: bedrock });
    const response = await forward.call(fake, request({
      provider: "amazon-bedrock",
      path: "us-west-2/model/anthropic.claude-sonnet-5/converse-stream",
      body: "{\"messages\":[]}",
    }), caller);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-5/converse-stream");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer bedrock-api-key");
    expect(init.body).toBe("{\"messages\":[]}");
    await Promise.all(waits);
    expect(recordPiAssistantUsage).toHaveBeenCalledWith(
      expect.objectContaining({ usage: expect.objectContaining({ input: 11, output: 2 }) }),
      expect.any(Number), "byok", false, "bedrock", expect.anything(),
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
