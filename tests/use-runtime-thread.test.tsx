import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeState = {
  messages: unknown[];
  indexes: number[];
  partial: unknown;
  progress: Map<string, unknown>;
  running: boolean;
  pendingInputs: unknown[];
  lastOutcome: unknown;
  hasOlder: boolean;
  transport: null;
  connected: boolean;
};

const watchers: Array<{ options: any; state: FakeState; emit(patch: Partial<FakeState>): void; closed: boolean; loadOlder: ReturnType<typeof vi.fn> }> = [];

vi.mock("@/lib/vendor/agent-runtime-watch", () => ({
  watchAgent: (options: any) => {
    const state: FakeState = { messages: [], indexes: [], partial: null, progress: new Map(), running: false, pendingInputs: [], lastOutcome: null, hasOlder: false, transport: null, connected: true };
    const watcher = {
      options,
      state,
      closed: false,
      loadOlder: vi.fn(async () => true),
      emit(patch: Partial<FakeState>) {
        Object.assign(state, patch);
        options.onChange?.(state);
      },
    };
    watchers.push(watcher);
    return { state, loadOlder: watcher.loadOlder, close: () => { watcher.closed = true; } };
  },
}));

import { useRuntimeThread, type RuntimeThreadSeed } from "@/lib/use-runtime-thread";

const fetchCalls: Array<{ url: string; method: string; body: any }> = [];
let responses: Record<string, unknown> = {};

beforeEach(() => {
  watchers.length = 0;
  fetchCalls.length = 0;
  responses = {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    fetchCalls.push(call);
    const path = url.split("?")[0];
    const body = responses[path] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const seed: RuntimeThreadSeed = {
  agentId: "agt_1",
  token: "abt_seed",
  expiresAt: Date.now() + 900_000,
  url: "https://agents.test",
  page: {
    entries: [
      { index: 0, message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
      { index: 1, message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 2 } },
    ],
    next: null,
  },
  previewTabs: [],
  activeTabId: null,
};

function mount(initialSeed: RuntimeThreadSeed | null = seed) {
  const callbacks = { current: { onOpen: vi.fn(), onStateUpdate: vi.fn() } };
  const hook = renderHook(() => useRuntimeThread({ threadId: "t1", workspaceId: "w1", seed: initialSeed, enabled: true, callbacks }));
  return { ...hook, callbacks };
}

describe("useRuntimeThread", () => {
  it("paints the loader's page, then watches the agent with the loader's token", async () => {
    const { result, callbacks } = mount();
    expect(result.current.chat.messages.map((message) => message.id)).toEqual(["rt:0", "rt:1"]);
    expect(result.current.hasOlder).toBe(false);
    await waitFor(() => expect(callbacks.current.onOpen).toHaveBeenCalled());
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(watchers[0].options).toMatchObject({ url: "https://agents.test", agentId: "agt_1", token: "abt_seed" });
    expect(fetchCalls).toHaveLength(0);

    act(() => watchers[0].emit({
      messages: seed.page!.entries.map((entry) => entry.message),
      indexes: [0, 1],
      running: true,
      partial: { role: "assistant", content: [{ type: "text", text: "more" }], stopReason: "stop", timestamp: 3 },
    }));
    await waitFor(() => expect(result.current.chat.isStreaming).toBe(true));
    // The response streams into the turn its user message opened.
    expect(result.current.chat.streamingMessageId).toBe("rt:1");
  });

  it("sends through the route, and matches the message that comes back to the client's id", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_1", agentId: "agt_1", fallback: null };
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    let sent: any;
    await act(async () => {
      sent = await result.current.client.call("sendMessage", ["Deploy it", "cm_1"]);
    });
    expect(sent).toMatchObject({ status: "accepted" });
    expect(fetchCalls[0]).toMatchObject({ url: "/api/threads/t1/messages?workspaceId=w1", method: "POST", body: { text: "Deploy it", clientMessageId: "cm_1" } });
    expect(result.current.chat.status).toBe("submitted");

    act(() => watchers[0].emit({
      messages: [...seed.page!.entries.map((entry) => entry.message), { role: "user", content: [{ type: "text", text: "Deploy it" }], timestamp: 5 }],
      indexes: [0, 1, 2],
      running: true,
    }));
    await waitFor(() => expect(result.current.chat.messages.find((message) => message.id === "rt:2")?.clientMessageId).toBe("cm_1"));
    expect(result.current.chat.status).toBe("streaming");
  });

  it("starts watching once the first send creates the agent", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_1", agentId: "agt_new", fallback: null };
    responses["/api/threads/t1/token"] = { token: "abt_new", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_new" };
    const { result } = mount({ ...seed, agentId: null, token: null, url: null, expiresAt: null, page: null });
    expect(watchers).toHaveLength(0);
    await act(async () => {
      await result.current.client.call("sendMessage", ["first", "cm_1"]);
    });
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(watchers[0].options).toMatchObject({ agentId: "agt_new", token: "abt_new" });
  });

  it("asks a pending input as the chat's question card and answers it through the route", async () => {
    const { result, callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const input = { id: "in_1", kind: "question", message: "", detail: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } };
    act(() => watchers[0].emit({ messages: seed.page!.entries.map((entry) => entry.message), indexes: [0, 1], pendingInputs: [input] }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      pendingQuestion: expect.objectContaining({ questionId: "in_1" }),
    })));
    await act(async () => {
      await result.current.client.call("answerQuestion", ["in_1", { "Which?": "B" }]);
    });
    expect(fetchCalls.at(-1)).toMatchObject({
      url: "/api/threads/t1/inputs/in_1?workspaceId=w1",
      body: { action: "accept", content: { answers: { "Which?": "B" } } },
    });
    await act(async () => {
      await result.current.client.call("requestStop");
    });
    expect(fetchCalls.at(-1)).toMatchObject({ url: "/api/threads/t1/stop?workspaceId=w1", method: "POST" });
  });

  it("opens the preview a set_preview result names while the page watches", async () => {
    const { callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const base = seed.page!.entries.map((entry) => entry.message);
    act(() => watchers[0].emit({ messages: base, indexes: [0, 1] }));
    const target = { kind: "app", scriptName: "shop", isPublic: false };
    act(() => watchers[0].emit({
      messages: [...base, { role: "toolResult", toolCallId: "c1", toolName: "camel__set_preview", content: [], details: { success: true, target }, isError: false, timestamp: 9 }],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      previewTabs: [target],
      previewActiveTabId: expect.any(String),
    })));
  });
});
