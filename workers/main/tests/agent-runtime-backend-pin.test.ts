import { describe, expect, it, vi } from "vitest";

import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";
import { runtimeConfigured } from "../src/chat-thread/runtime-agent";
import { ChatThreadDO } from "../src/chat-thread-do";

const CONFIGURED = { AGENT_RUNTIME_API_TOKEN: "art_x", AGENT_RUNTIME_TENANT: "chiridion", AGENT_RUNTIME_DEFINITION: "def_1" };
const hosted = { usageProvider: "openrouter", model: { id: "anthropic/claude-sonnet-5:nitro" } } as unknown as PiResolvedModelConfig;

type Resolve = (this: unknown, config: PiResolvedModelConfig) => "runtime" | "pi";
const resolve = (ChatThreadDO.prototype as unknown as { resolveAgentBackend: Resolve }).resolveAgentBackend;

function fakeThread(options: { env?: Record<string, string>; pinned?: string; transcript?: boolean; route?: boolean } = {}) {
  const kv = new Map<string, unknown>(options.pinned ? [["agentBackend", options.pinned]] : []);
  return {
    kv,
    env: options.env ?? CONFIGURED,
    ctx: { storage: { kv: { get: (key: string) => kv.get(key), put: (key: string, value: unknown) => { kv.set(key, value); } } } },
    hasNoModelTranscript: () => !options.transcript,
    runtimeRouteFor: () => (options.route === false ? null : { kind: "scope", model: "openrouter/x", keyScope: "hosted" }),
    recordChatThreadObservabilityEvent: vi.fn(),
  };
}

describe("runtime backend pin", () => {
  it("is on only with the tenant's token, id and definition", () => {
    expect(runtimeConfigured(CONFIGURED)).toBe(true);
    expect(runtimeConfigured({ ...CONFIGURED, AGENT_RUNTIME_DEFINITION: "" })).toBe(false);
    expect(runtimeConfigured({ AGENT_RUNTIME_API_TOKEN: "art_x", AGENT_RUNTIME_DEFINITION: "def_1" })).toBe(false);
  });

  it("pins a new thread with a runtime route to the runtime, and says so", () => {
    const thread = fakeThread();
    expect(resolve.call(thread, hosted)).toBe("runtime");
    expect(thread.kv.get("agentBackend")).toBe("runtime");
    expect(thread.recordChatThreadObservabilityEvent).toHaveBeenCalledWith("agent_backend_pinned", expect.objectContaining({
      status: "runtime", provider: "openrouter", model: "anthropic/claude-sonnet-5:nitro",
    }));
  });

  it("keeps existing conversations and routes the runtime cannot call on the in-DO loop, with the reason", () => {
    const existing = fakeThread({ transcript: true });
    expect(resolve.call(existing, hosted)).toBe("pi");
    expect(existing.recordChatThreadObservabilityEvent).toHaveBeenCalledWith("agent_backend_pinned", expect.objectContaining({ status: "pi_existing_transcript" }));
    const custom = fakeThread({ route: false });
    expect(resolve.call(custom, hosted)).toBe("pi");
    expect(custom.kv.get("agentBackend")).toBe("pi");
    expect(custom.recordChatThreadObservabilityEvent).toHaveBeenCalledWith("agent_backend_pinned", expect.objectContaining({ status: "pi_no_runtime_route" }));
  });

  it("writes nothing where the runtime is not configured, and never moves a pinned thread", () => {
    const unconfigured = fakeThread({ env: {} });
    expect(resolve.call(unconfigured, hosted)).toBe("pi");
    expect(unconfigured.kv.size).toBe(0);
    expect(unconfigured.recordChatThreadObservabilityEvent).not.toHaveBeenCalled();
    // A runtime thread stays one after the config is removed (its agent needs only the token).
    const pinned = fakeThread({ env: {}, pinned: "runtime" });
    expect(resolve.call(pinned, hosted)).toBe("runtime");
    expect(resolve.call(fakeThread({ pinned: "pi" }), hosted)).toBe("pi");
  });
});
