import { describe, expect, it, vi } from "vitest";

// The relay is plain ESM executed by Bun in production. Vite can load it for
// these handler-level tests; `import.meta.main` remains false under Vitest.
import { handleInferenceRequest } from "../infra/codex-egress-proxy/inference-relay.mjs";

describe("Codex inference relay", () => {
  it("allows only the exact inference POST path", async () => {
    const fetchImpl = vi.fn();
    const response = await handleInferenceRequest(
      new Request("https://relay.example/backend-api/codex/other", { method: "POST" }),
      fetchImpl as unknown as typeof fetch,
    );

    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reconstructs allowlisted headers and propagates cancellation", async () => {
    const controller = new AbortController();
    const request = new Request("https://relay.example/backend-api/codex/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: "Bearer subscription-token",
        "chatgpt-account-id": "account-1",
        "content-type": "application/json",
        "x-camelai-proxy-token": "relay-secret",
      },
      body: '{"stream":true}',
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer subscription-token");
      expect(headers.get("chatgpt-account-id")).toBe("account-1");
      expect(headers.get("x-camelai-proxy-token")).toBeNull();
      expect(headers.get("originator")).toBe("camelai");
      expect(headers.get("user-agent")).toBe("camelAI/1.0");
      expect(init.signal).toBe(request.signal);
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"stream":true}');
      return new Response("data: done\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "request-1",
          "set-cookie": "must-not-pass",
        },
      });
    });
    const response = await handleInferenceRequest(
      request,
      fetchImpl as unknown as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("data: done\n\n");
  });

  it("rejects a declared body larger than the server cap", async () => {
    const fetchImpl = vi.fn();
    const response = await handleInferenceRequest(
      new Request("https://relay.example/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-length": String(32 * 1024 * 1024 + 1) },
        body: "small",
      }),
      fetchImpl as unknown as typeof fetch,
    );

    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
