import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildGenerateImageMessages,
  generateImage,
  parseGenerateImageResponse,
} from "../src/generate-image.js";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  appendNitro,
  executeVirtualAiRun,
  extractModelFromInput,
  normalizeLegacyModel,
  resolveGatewaySettings,
  resolveRouting,
  runViaGatewayHTTP,
} from "../src/ai-virtual-binding.js";
import {
  chatCompletionToPiCall,
  piMessageToChatCompletion,
} from "../src/bedrock-pi-adapter.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

describe("resolveGatewaySettings", () => {
  it("returns gateway settings from required env vars", () => {
    const settings = resolveGatewaySettings({
      CF_ACCOUNT_ID: "acct",
      CF_GATEWAY_NAME: "chiridion",
      CF_GATEWAY_TOKEN: "token",
    });

    expect(settings).toEqual({
      accountID: "acct",
      gatewayID: "chiridion",
      authToken: "token",
      origin: "https://gateway.ai.cloudflare.com",
    });
  });

  it("uses AI_GATEWAY_AUTH_TOKEN when set", () => {
    const settings = resolveGatewaySettings({
      CF_ACCOUNT_ID: "acct",
      CF_GATEWAY_NAME: "chiridion",
      CF_GATEWAY_TOKEN: "token",
      AI_GATEWAY_AUTH_TOKEN: "override-token",
    });

    expect(settings?.authToken).toBe("override-token");
  });

  it("returns undefined when required gateway config is missing", () => {
    expect(
      resolveGatewaySettings({
        CF_ACCOUNT_ID: "acct",
        CF_GATEWAY_NAME: "chiridion",
        CF_GATEWAY_TOKEN: "",
      }),
    ).toBeUndefined();
  });
});

describe("extractModelFromInput", () => {
  it("extracts model field from object input", () => {
    const result = extractModelFromInput({
      model: "smart",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.model).toBe("smart");
    expect(result.input).toEqual({
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("returns undefined model when no model field exists", () => {
    const input = { messages: [{ role: "user", content: "hello" }] };
    const result = extractModelFromInput(input);
    expect(result.model).toBeUndefined();
    expect(result.input).toBe(input);
  });

  it("returns undefined model for non-string model values", () => {
    const result = extractModelFromInput({ model: 42, messages: [] });
    expect(result.model).toBeUndefined();
  });

  it("passes through non-object input unchanged", () => {
    expect(extractModelFromInput(null)).toEqual({
      model: undefined,
      input: null,
    });
    expect(extractModelFromInput("hello")).toEqual({
      model: undefined,
      input: "hello",
    });
    expect(extractModelFromInput([1, 2])).toEqual({
      model: undefined,
      input: [1, 2],
    });
  });
});

describe("normalizeLegacyModel (back-compat shim)", () => {
  it("maps old auto-family routes to the auto tier", () => {
    expect(normalizeLegacyModel("dynamic/auto")).toBe("auto");
    expect(normalizeLegacyModel("auto_search")).toBe("auto");
    expect(normalizeLegacyModel("dynamic/auto_search")).toBe("auto");
  });

  it("maps dynamic/auto_image to the private auto_image route", () => {
    expect(normalizeLegacyModel("dynamic/auto_image")).toBe("auto_image");
  });

  it("maps old friendly model names to their OpenRouter ids", () => {
    expect(normalizeLegacyModel("gpt-5.5")).toBe("openai/gpt-5.5");
    expect(normalizeLegacyModel("kimi-k2.6")).toBe("moonshotai/kimi-k2.7-code");
    expect(normalizeLegacyModel("kimi-latest")).toBe("moonshotai/kimi-k2.7-code");
    expect(normalizeLegacyModel("opus")).toBe("anthropic/claude-opus-4.8");
    expect(normalizeLegacyModel("opus-4.7")).toBe("anthropic/claude-opus-4.8");
    expect(normalizeLegacyModel("opus-4.8")).toBe("anthropic/claude-opus-4.8");
    expect(normalizeLegacyModel("grok-4.3")).toBe("x-ai/grok-4.3");
    expect(normalizeLegacyModel("grok-latest")).toBe("x-ai/grok-4.3");
    expect(normalizeLegacyModel("glm-5.2")).toBe("z-ai/glm-5.2");
    expect(normalizeLegacyModel("glm-latest")).toBe("z-ai/glm-5.2");
    expect(normalizeLegacyModel("gemini-3.5-flash")).toBe("google/gemini-3.5-flash");
  });

  it("passes current tier names, friendly ids, and OpenRouter ids through unchanged", () => {
    expect(normalizeLegacyModel("auto")).toBe("auto");
    expect(normalizeLegacyModel("smart")).toBe("smart");
    expect(normalizeLegacyModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeLegacyModel("deepseek-v4-auto")).toBe("deepseek-v4-auto");
    expect(normalizeLegacyModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeLegacyModel("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(normalizeLegacyModel(normalizeLegacyModel("gpt-5.5"))).toBe("openai/gpt-5.5");
  });

  it("trims whitespace before matching", () => {
    expect(normalizeLegacyModel("  gpt-5.5  ")).toBe("openai/gpt-5.5");
  });
});

describe("resolveRouting", () => {
  it("routes hosted DeepSeek V4 Auto through the AI Gateway compat dynamic route", async () => {
    const routing = await resolveRouting(
      {
        env: {
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => null),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-auto",
    );

    expect(routing.provider).toBe("openrouter");
    expect(routing.gatewayProvider).toBe("compat");
    expect(routing.usageProvider).toBe("compat");
    expect(routing.model).toBe("dynamic/deepseek-v4-auto");
    expect(routing.byokKey).toBeUndefined();
  });

  it("routes hosted DeepSeek V4 Pro through the pro fallback dynamic route", async () => {
    const routing = await resolveRouting(
      {
        env: {
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => null),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-pro",
    );

    expect(routing.gatewayProvider).toBe("compat");
    expect(routing.usageProvider).toBe("compat");
    expect(routing.model).toBe("dynamic/deepseek-v4-pro-fallback");
    expect(routing.byokKey).toBeUndefined();
  });

  it("does not route DeepSeek V4 Auto through OpenRouter BYOK", async () => {
    const encrypted = await encryptCredentials({ api_key: "openrouter-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "openrouter",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-auto",
    );

    expect(routing.provider).toBe("openrouter");
    expect(routing.gatewayProvider).toBe("compat");
    expect(routing.usageProvider).toBe("compat");
    expect(routing.model).toBe("dynamic/deepseek-v4-auto");
    expect(routing.byokKey).toBeUndefined();
  });

  it("defaults Bedrock BYOK routing to us-east-1 when no region is stored", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "bedrock",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "auto",
    );

    expect(routing.provider).toBe("bedrock");
    expect(routing.awsRegion).toBe("us-east-1");
  });

  it("routes Anthropic BYOK smart tier to Opus 4.8", async () => {
    const encrypted = await encryptCredentials({ api_key: "anthropic-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "anthropic",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "smart",
    );

    expect(routing.provider).toBe("anthropic");
    expect(routing.model).toBe("anthropic/claude-opus-4-8");
  });

  it("routes Bedrock BYOK smart tier to Opus 4.8", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "bedrock",
                config: JSON.stringify({ aws_region: "us-east-1" }),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "smart",
    );

    expect(routing.provider).toBe("bedrock");
    expect(routing.model).toBe("anthropic.claude-opus-4-8");
    expect(routing.awsRegion).toBe("us-east-1");
  });
});

describe("executeVirtualAiRun", () => {
  it("posts hosted DeepSeek V4 Auto to the compat dynamic route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_deepseek_auto" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      await executeVirtualAiRun(
        {
          env: {
            CF_ACCOUNT_ID: "acct_1",
            CF_GATEWAY_NAME: "gw_1",
            CF_GATEWAY_TOKEN: "tok_1",
            ORG: {
              idFromName: vi.fn((id: string) => id),
              get: vi.fn(() => ({
                getLlmProviderConfig: vi.fn(async () => null),
                getInfo: vi.fn(async () => ({
                  billing_status: "active",
                  billing_plan: "payg",
                  billing_credit_purchase_total_cents: 1000,
                  billing_credit_grant_total_cents: 0,
                })),
                getUsageLogSum: vi.fn(async () => ({ total_cost_usd: 0 })),
                recordUsage: vi.fn(async () => undefined),
              })),
            } as never,
          },
          props: { orgId: "org1", workspaceId: "ws1" },
          waitUntil: vi.fn(),
        },
        "deepseek-v4-auto",
        { messages: [{ role: "user", content: "hello" }] },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/compat/chat/completions",
      );
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer tok_1");
      expect(headers.get("cf-aig-authorization")).toBeNull();
      const body = JSON.parse(String(init.body)) as { model: string };
      expect(body.model).toBe("dynamic/deepseek-v4-auto");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not require AI Gateway settings before Bedrock BYOK routing", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "ok" }),
    );

    try {
      await expect(
        executeVirtualAiRun(
          {
            env: {
              INTEGRATION_SECRET_KEY: "secret",
              ORG: {
                idFromName: vi.fn((id: string) => id),
                get: vi.fn(() => ({
                  getLlmProviderConfig: vi.fn(async () => ({
                    provider: "bedrock",
                    config: JSON.stringify({ aws_region: "us-east-1" }),
                    credentials_encrypted: encrypted,
                  })),
                  recordUsage: vi.fn(async () => undefined),
                })),
              } as never,
            },
            props: { orgId: "org1", workspaceId: "ws1" },
            waitUntil: vi.fn(),
          },
          "auto",
          { messages: [{ role: "user", content: "hello" }] },
        ),
      ).resolves.toBeDefined();
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("appendNitro", () => {
  it("appends :nitro to plain OpenRouter ids", () => {
    expect(appendNitro("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash:nitro",
    );
    expect(appendNitro("moonshotai/kimi-k2.7-code")).toBe(
      "moonshotai/kimi-k2.7-code:nitro",
    );
  });

  it("does not double-suffix when a :variant is already present", () => {
    expect(appendNitro("anthropic/claude-sonnet-4.6:nitro")).toBe(
      "anthropic/claude-sonnet-4.6:nitro",
    );
    expect(appendNitro("openai/gpt-5.5:online")).toBe("openai/gpt-5.5:online");
  });

  it("returns empty string for empty input", () => {
    expect(appendNitro("")).toBe("");
    expect(appendNitro("   ")).toBe("");
  });
});

describe("runViaGatewayHTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes to /compat/ with hosted gateway token when no BYOK key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1", userId: "user_1" },
      { messages: [{ role: "user", content: "hello" }] },
      "anthropic/claude-sonnet-4-6",
      "compat",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/compat/chat/completions",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok_1");
    expect(headers.get("cf-aig-authorization")).toBeNull();

    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("sends BYOK key as Authorization and gateway token as cf-aig-authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "gateway-tok" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "hi" }] },
      "openai/gpt-5.5",
      "compat",
      "sk-user-byok",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-user-byok");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer gateway-tok");
  });

  it("routes OpenRouter models to /openrouter/", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_or" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "hello" }] },
      "deepseek/deepseek-v4-flash:nitro",
      "openrouter",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openrouter/chat/completions",
    );
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("deepseek/deepseek-v4-flash:nitro");
  });

  it("throws the gateway error message for non-2xx responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "gateway rejected request" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      runViaGatewayHTTP(
        { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
        { orgId: "org_1", workspaceId: "ws_1" },
        { messages: [{ role: "user", content: "hello" }] },
        "openai/gpt-5.5",
        "compat",
      ),
    ).rejects.toThrow("gateway rejected request");
  });

  it("passes through streaming responses when stream=true", async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"id":"evt_1"}\n\n'),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
    );

    const result = await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { stream: true, messages: [{ role: "user", content: "hello" }] },
      "deepseek/deepseek-v4-flash:nitro",
      "openrouter",
    );

    expect(result).toBeInstanceOf(ReadableStream);

    const reader = (result as ReadableStream<Uint8Array>).getReader();
    let combined = "";
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      combined += decoder.decode(value, { stream: true });
    }
    combined += decoder.decode();

    expect(combined).toContain('data: {"id":"evt_1"}');
    expect(combined).toContain("data: [DONE]");
  });
});

describe("chatCompletionToPiCall (Bedrock adapter — input)", () => {
  it("lifts system messages, flattens text content, threads inference config", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hello!" }],
        },
      ],
      max_tokens: 256,
      temperature: 0.4,
      top_p: 0.95,
    });
    expect(call.stream).toBe(false);
    expect(call.context.systemPrompt).toBe("be helpful");
    expect(call.context.messages.length).toBe(2);
    expect(call.context.messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(call.context.messages[1].role).toBe("assistant");
    expect(call.maxTokens).toBe(256);
    expect(call.temperature).toBe(0.4);
  });

  it("returns stream=true when the input requests streaming", () => {
    const call = chatCompletionToPiCall({
      stream: true,
      messages: [{ role: "user", content: "go" }],
    });
    expect(call.stream).toBe(true);
  });

  it("preserves base64 data-URL image parts as pi-ai ImageContent", () => {
    const call = chatCompletionToPiCall({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAneed" },
            },
          ],
        },
      ],
    });
    expect(call.context.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AAAneed", mimeType: "image/png" },
      ],
    });
  });

  it("keeps an image-only user turn (does not drop it)", () => {
    const call = chatCompletionToPiCall({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,ZZZ" },
            },
          ],
        },
      ],
    });
    expect(call.context.messages.length).toBe(1);
    expect(call.context.messages[0].content).toEqual([
      { type: "image", data: "ZZZ", mimeType: "image/jpeg" },
    ]);
  });

  it("collapses a single text part back to a plain string", () => {
    const call = chatCompletionToPiCall({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(call.context.messages[0].content).toBe("hi");
  });

  it("skips remote (non-data) image URLs rather than fetching them", () => {
    const call = chatCompletionToPiCall({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          ],
        },
      ],
    });
    expect(call.context.messages[0].content).toBe("look");
  });

  it("translates OpenAI tools into pi-ai Tool[] and forwards tool_choice", () => {
    const call = chatCompletionToPiCall({
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Lookup weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(call.context.tools).toEqual([
      {
        name: "get_weather",
        description: "Lookup weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(call.toolChoice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("maps tool_choice variants ('auto', 'required', 'none')", () => {
    expect(chatCompletionToPiCall({ messages: [{ role: "user", content: "x" }], tool_choice: "auto" }).toolChoice).toBe("auto");
    expect(chatCompletionToPiCall({ messages: [{ role: "user", content: "x" }], tool_choice: "required" }).toolChoice).toBe("any");
    expect(chatCompletionToPiCall({ messages: [{ role: "user", content: "x" }], tool_choice: "none" }).toolChoice).toBe("none");
  });

  it("translates assistant tool_calls into pi-ai ToolCall content blocks", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "user", content: "weather in SF" },
        {
          role: "assistant",
          content: "Looking that up.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      ],
    });
    const assistant = call.context.messages[1] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "Looking that up." },
      { type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "SF" } },
    ]);
  });

  it("translates role:tool messages into pi-ai ToolResultMessage and threads toolName from earlier tool_calls", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "user", content: "weather in SF" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    });
    expect(call.context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "get_weather",
      content: [{ type: "text", text: "sunny" }],
      isError: false,
    });
  });

  it("emits one ToolResultMessage per role:tool message", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "user", content: "weather in SF and NYC" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "w", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "w", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
        { role: "tool", tool_call_id: "c2", content: "cloudy" },
      ],
    });
    expect(call.context.messages.length).toBe(4);
    expect(call.context.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
    expect(call.context.messages[3]).toMatchObject({ role: "toolResult", toolCallId: "c2" });
  });
});

describe("piMessageToChatCompletion (Bedrock adapter — output)", () => {
  const baseUsage = {
    input: 3,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  it("renders a text-only assistant message", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        api: "anthropic-messages",
        provider: "custom",
        model: "haiku",
        usage: baseUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      },
      "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    ) as Record<string, unknown>;
    const choices = completion.choices as Array<Record<string, unknown>>;
    expect((choices[0].message as Record<string, unknown>).content).toBe("Hello!");
    expect(choices[0].finish_reason).toBe("stop");
    expect(completion.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });

  it("emits tool_calls payload (with JSON-stringified arguments) for toolUse stop", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking that up" },
          {
            type: "toolCall",
            id: "tu_1",
            name: "get_weather",
            arguments: { city: "SF" },
          },
        ],
        api: "anthropic-messages",
        provider: "custom",
        model: "haiku",
        usage: baseUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      "model",
    ) as Record<string, unknown>;
    const choices = completion.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe("Looking that up");
    expect(msg.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) },
      },
    ]);
  });

  it("falls back to finish_reason:stop when toolUse stop has no tool_calls", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "custom",
        model: "m",
        usage: baseUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      "model",
    ) as Record<string, unknown>;
    const choices = completion.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
    expect((choices[0].message as Record<string, unknown>).tool_calls).toBeUndefined();
  });

  it("propagates cache read + write tokens into prompt_tokens_details", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "custom",
        model: "m",
        usage: {
          input: 100,
          output: 5,
          cacheRead: 80,
          cacheWrite: 12,
          totalTokens: 105,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
      "model",
    ) as Record<string, unknown>;
    const usage = completion.usage as Record<string, unknown>;
    expect(usage.prompt_tokens_details).toEqual({
      cached_tokens: 80,
      cache_write_tokens: 12,
      cache_creation_input_tokens: 12,
    });
  });

  it("throws if pi-ai reports stopReason: error", () => {
    expect(() =>
      piMessageToChatCompletion(
        {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "custom",
          model: "m",
          usage: baseUsage,
          stopReason: "error",
          errorMessage: "boom",
          timestamp: Date.now(),
        },
        "model",
      ),
    ).toThrow("boom");
  });
});


describe("buildGenerateImageMessages", () => {
  it("builds a text-only user message from a prompt string", () => {
    expect(buildGenerateImageMessages("A watercolor mountain")).toEqual([
      { role: "user", content: "A watercolor mountain" },
    ]);
  });

  it("builds multimodal content when a reference image is provided", () => {
    expect(
      buildGenerateImageMessages({
        prompt: "Same style, new subject",
        referenceImageUrl: "data:image/png;base64,abc",
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
          { type: "text", text: "Same style, new subject" },
        ],
      },
    ]);
  });

  it("throws when the prompt is empty", () => {
    expect(() => buildGenerateImageMessages("   ")).toThrow(
      "generateImage requires a non-empty prompt",
    );
  });
});

describe("generateImage", () => {
  it("calls auto_image via run and parses the response", async () => {
    const ai = {
      run: async (model: string, input: unknown) => {
        expect(model).toBe("auto_image");
        expect(input).toEqual({
          messages: [{ role: "user", content: "a star" }],
        });
        return {
          choices: [
            {
              message: {
                content: "done",
                images: [
                  {
                    index: 0,
                    image_url: { url: "data:image/png;base64,star" },
                  },
                ],
              },
            },
          ],
        };
      },
    };

    const result = await generateImage(ai, "a star");
    expect(result.imageDataUrl).toBe("data:image/png;base64,star");
  });
});

describe("parseGenerateImageResponse", () => {
  it("extracts text and image data URLs from gateway payloads", () => {
    const result = parseGenerateImageResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Here is your image.",
            images: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAA" },
                index: 1,
              },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,BBB" },
                index: 0,
              },
            ],
          },
        },
      ],
    });

    expect(result).toEqual({
      text: "Here is your image.",
      imageDataUrl: "data:image/png;base64,BBB",
      images: [
        { dataUrl: "data:image/png;base64,BBB", index: 0 },
        { dataUrl: "data:image/png;base64,AAA", index: 1 },
      ],
    });
  });

  it("returns empty image fields when the model returns text only", () => {
    expect(
      parseGenerateImageResponse({
        choices: [{ message: { role: "assistant", content: "No image." } }],
      }),
    ).toEqual({
      text: "No image.",
      imageDataUrl: null,
      images: [],
    });
  });
});
