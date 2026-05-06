import { describe, expect, it, vi, afterEach } from "vitest";
import {
  extractModelFromInput,
  isOpenRouterModel,
  resolveGatewaySettings,
  resolveModel,
  resolveVirtualModel,
  runViaGatewayHTTP,
  runViaSandboxHostVirtualAI,
} from "../src/ai-virtual-binding.js";

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
      model: "auto_search",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.model).toBe("auto_search");
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

describe("resolveModel", () => {
  it("maps auto to the default OpenRouter Gemini model", () => {
    expect(resolveModel("auto")).toBe("google/gemini-3-flash-preview");
  });

  it("maps auto_search to dynamic/auto_search", () => {
    expect(resolveModel("auto_search")).toBe("dynamic/auto_search");
  });

  it("maps auto_image to dynamic/auto_image", () => {
    expect(resolveModel("auto_image")).toBe("dynamic/auto_image");
  });

  it("passes through OpenRouter models as-is", () => {
    expect(resolveModel("anthropic/claude-3.5-sonnet")).toBe(
      "anthropic/claude-3.5-sonnet",
    );
    expect(resolveModel("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(resolveModel("google/gemini-pro")).toBe("google/gemini-pro");
    expect(resolveModel("meta-llama/llama-3-70b-instruct")).toBe(
      "meta-llama/llama-3-70b-instruct",
    );
  });

  it("maps Kimi aliases to the OpenRouter route model", () => {
    expect(resolveModel("kimi-k2.6")).toBe("~moonshotai/kimi-latest");
    expect(resolveModel("kimi-latest")).toBe("~moonshotai/kimi-latest");
  });

  it("maps Grok aliases to the OpenRouter route model", () => {
    expect(resolveModel("grok-4.3")).toBe("x-ai/grok-4.3");
    expect(resolveModel("grok-latest")).toBe("x-ai/grok-4.3");
  });

  it("passes through models with dynamic/ prefix unchanged", () => {
    expect(resolveModel("dynamic/auto")).toBe("dynamic/auto");
    expect(resolveModel("dynamic/auto_search")).toBe("dynamic/auto_search");
  });

  it("falls back to the default OpenRouter Gemini model for empty string", () => {
    expect(resolveModel("")).toBe("google/gemini-3-flash-preview");
  });

  it("trims whitespace before matching", () => {
    expect(resolveModel("  auto_search  ")).toBe("dynamic/auto_search");
    expect(resolveModel("  anthropic/claude-3.5-sonnet  ")).toBe(
      "anthropic/claude-3.5-sonnet",
    );
  });
});

describe("isOpenRouterModel", () => {
  it("returns false for dynamic/ models", () => {
    expect(isOpenRouterModel("dynamic/auto")).toBe(false);
    expect(isOpenRouterModel("dynamic/auto_search")).toBe(false);
    expect(isOpenRouterModel("dynamic/auto_image")).toBe(false);
  });

  it("returns true for OpenRouter models", () => {
    expect(isOpenRouterModel("anthropic/claude-3.5-sonnet")).toBe(true);
    expect(isOpenRouterModel("openai/gpt-4o")).toBe(true);
    expect(isOpenRouterModel("google/gemini-pro")).toBe(true);
  });
});

describe("resolveVirtualModel", () => {
  it("uses AI_VIRTUAL_MODEL when configured", () => {
    expect(resolveVirtualModel({ AI_VIRTUAL_MODEL: "auto_search" })).toBe(
      "auto_search",
    );
  });

  it("falls back to the default OpenRouter Gemini model when unset", () => {
    expect(resolveVirtualModel({ AI_VIRTUAL_MODEL: "" })).toBe(
      "google/gemini-3-flash-preview",
    );
  });
});

describe("runViaGatewayHTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls compat chat completions endpoint with dynamic/auto model", async () => {
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

    const result = await runViaGatewayHTTP(
      {
        accountID: "acct_1",
        gatewayID: "gw_1",
        authToken: "tok_1",
      },
      { orgId: "org_1", workspaceId: "ws_1", userId: "user_1" },
      {
        messages: [{ role: "user", content: "hello" }],
      },
      "dynamic/auto",
    );

    expect(result).toEqual({
      id: "chatcmpl_1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/compat/chat/completions",
    );
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok_1");
    const metadata = headers.get("cf-aig-metadata");
    expect(metadata).toContain('"uid":"org_1:ws_1:user_1"');
    expect(metadata).toContain('"userId":"user_1"');

    expect(init.body).toBeDefined();
    const body = JSON.parse(String(init.body)) as {
      model?: string;
      messages?: unknown[];
    };
    expect(body.model).toBe("dynamic/auto");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("sends dynamic/auto_search when that model is passed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "search" }] },
      "dynamic/auto_search",
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as { model: string };
    expect(body.model).toBe("dynamic/auto_search");
  });

  it("sends dynamic/auto_image when that model is passed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_3" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "image" }] },
      "dynamic/auto_image",
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as { model: string };
    expect(body.model).toBe("dynamic/auto_image");
  });

  it("routes OpenRouter models to /openrouter/ endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_or_1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "hello" }] },
      "anthropic/claude-3.5-sonnet",
      "openrouter",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openrouter/chat/completions",
    );

    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("anthropic/claude-3.5-sonnet");
  });

  it("throws gateway error message for non-2xx responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "gateway rejected request" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      runViaGatewayHTTP(
        {
          accountID: "acct_1",
          gatewayID: "gw_1",
          authToken: "tok_1",
        },
        { orgId: "org_1", workspaceId: "ws_1" },
        { messages: [{ role: "user", content: "hello" }] },
        "dynamic/auto",
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
      {
        accountID: "acct_1",
        gatewayID: "gw_1",
        authToken: "tok_1",
      },
      { orgId: "org_1", workspaceId: "ws_1" },
      {
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      "dynamic/auto",
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

describe("runViaSandboxHostVirtualAI", () => {
  it("delegates virtual AI calls to sandbox-host with tenant context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_virtual_1",
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
    const sandboxHost = { fetch: fetchMock } as unknown as Fetcher;

    const result = await runViaSandboxHostVirtualAI(
      sandboxHost,
      "sandbox-secret",
      "https://camelai.dev",
      { orgId: "org_1", workspaceId: "ws_1", userId: "user_1" },
      { messages: [{ role: "user", content: "hello" }] },
      "dynamic/auto",
    );

    expect(result).toEqual({
      id: "chatcmpl_virtual_1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sandbox/v1/virtual-ai/chat/completions");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-chiridion-org-id")).toBe("org_1");
    expect(headers.get("x-chiridion-workspace-id")).toBe("ws_1");
    expect(headers.get("x-chiridion-user-id")).toBe("user_1");
    expect(headers.get("x-sandbox-secret")).toBe("sandbox-secret");
    expect(headers.get("x-chiridion-worker-base-url")).toBe(
      "https://camelai.dev",
    );
    const body = JSON.parse(String(init.body)) as { model?: string };
    expect(body.model).toBe("dynamic/auto");
  });

  it("throws sandbox-host billing errors", async () => {
    const sandboxHost = {
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              "Message not sent — top up credits or add an API key to continue.",
          }),
          {
            status: 402,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    } as unknown as Fetcher;

    await expect(
      runViaSandboxHostVirtualAI(
        sandboxHost,
        undefined,
        undefined,
        { orgId: "org_1", workspaceId: "ws_1" },
        { messages: [{ role: "user", content: "hello" }] },
        "dynamic/auto",
      ),
    ).rejects.toThrow("Message not sent");
  });
});
