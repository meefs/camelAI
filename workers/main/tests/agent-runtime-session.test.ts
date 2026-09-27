import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  RuntimeAgentSession,
  type RuntimeAgentRecord,
  type RuntimeRunRecord,
} from "../src/chat-thread/runtime-agent";

const MODEL = { id: "sonnet", api: "anthropic-messages", provider: "anthropic" } as never;

/** A runtime that answers each run with the frames `script` returns for it. */
function fakeRuntime(script: (requestId: string, method: string) => Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; path: string; body?: unknown; headers: Headers }> = [];
  let frames: string[] = [];
  let nextId = 6;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, body, headers });
    if (method === "POST" && url.pathname === "/v1/agents") return Response.json({ id: "client_1", token: "agent-token" }, { status: 201 });
    if (method === "PATCH") return Response.json({ id: "configure" }, { status: 202 });
    if (url.pathname === "/clients/client_1/state") return Response.json({ cursor: 5, requests: [] });
    if (method === "POST" && url.pathname === "/clients/client_1/requests") {
      const params = body as { id: string; method: string };
      if (params.method === "prompt" || params.method === "continue") {
        for (const frame of script(params.id, params.method)) {
          frames.push(`id: ${nextId++}\ndata: ${JSON.stringify(frame)}\n\n`);
        }
      }
      return Response.json({ id: params.id });
    }
    if (url.pathname.startsWith("/clients/client_1/requests/")) return Response.json({ id: "r" });
    if (method === "POST" && url.pathname.startsWith("/v1/agents/client_1/inputs/")) {
      for (const frame of script("resume_1", "resume")) frames.push(`id: ${nextId++}\ndata: ${JSON.stringify(frame)}\n\n`);
      return Response.json({ input: { id: url.pathname.split("/").pop() }, request: { id: "resume_1" } }, { status: 202 });
    }
    if (url.pathname === "/clients/client_1/events") {
      const after = Number(headers.get("Last-Event-ID") ?? 0);
      const pending = frames.filter((frame) => Number(/^id: (\d+)/.exec(frame)![1]) > after);
      return new Response(`event: ready\ndata: {}\n\n: heartbeat\n\n${pending.join("")}`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, reset: () => { frames = []; } };
}

function memoryStore() {
  const data: { agent: RuntimeAgentRecord | null; cursor: number | null; run: RuntimeRunRecord | null } = { agent: null, cursor: null, run: null };
  return {
    data,
    store: {
      agent: () => data.agent,
      saveAgent: (agent: RuntimeAgentRecord) => { data.agent = agent; },
      cursor: () => data.cursor,
      saveCursor: (cursor: number) => { data.cursor = cursor; },
      run: () => data.run,
      saveRun: (run: RuntimeRunRecord | null) => { data.run = run; },
    },
  };
}

let routeModel: string | null = "chiridion/openrouter/anthropic/claude-sonnet-5";

function session(runtime: ReturnType<typeof fakeRuntime>, store = memoryStore()) {
  let activity = 0;
  const agent = new RuntimeAgentSession({
    env: { AGENT_RUNTIME_URL: "https://runtime.test", AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_DEFINITION: "def_1", APP_KV: {} as KVNamespace },
    store: store.store,
    identity: { orgId: "org1", workspaceId: "ws1", threadId: "thread1", subject: "user1" },
    actor: () => "user2",
    initialState: { systemPrompt: "", model: MODEL, tools: [], messages: [], thinkingLevel: "medium" },
    configuration: async () => ({ systemPromptAppend: "camel prompt" }),
    runtimeModel: async () => routeModel,
    onActivity: () => { activity += 1; },
    fetch: runtime.fetch,
  });
  const events: Array<Record<string, unknown>> = [];
  agent.subscribe((event) => { events.push(event as never); });
  return { agent, events, store, activity: () => activity };
}

const userMessage = { role: "user", content: "hello", timestamp: 1, metadata: { renderMessageId: "u1" } } as unknown as AgentMessage;

describe("RuntimeAgentSession", () => {
  it("creates the thread's agent once, prompts as the actor, and relays the run's events with chiridion tool names", async () => {
    const reply = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "camel__list_apps", arguments: {} }], stopReason: "toolUse" };
    const runtime = fakeRuntime((requestId) => [
      { type: "event", requestId, event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "message_end", message: { role: "user", content: "hello", timestamp: 9 } } },
      { type: "event", requestId, event: { type: "tool_execution_start", toolCallId: "c1", toolName: "camel__list_apps", args: {} } },
      { type: "event", requestId, event: { type: "message_end", message: reply } },
      { type: "event", requestId: "other", event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: { reply: "" } } },
    ]);
    const { agent, events, store, activity } = session(runtime);
    await agent.prompt(userMessage);

    const create = runtime.calls.find((call) => call.path === "/v1/agents")!;
    expect(create.headers.get("Idempotency-Key")).toBe("thread_thread1");
    expect(create.body).toMatchObject({
      definition: "def_1",
      model: "chiridion/openrouter/anthropic/claude-sonnet-5",
      thinkingLevel: "medium",
      systemPromptAppend: "camel prompt",
      fileTools: false,
      ttlSeconds: null,
      subject: "user1",
      context: { org: "org1", workspace: "ws1", thread: "thread1" },
    });
    expect(runtime.calls.some((call) => call.method === "PATCH")).toBe(false);
    const prompt = runtime.calls.find((call) => call.path === "/clients/client_1/requests")!;
    expect(prompt.body).toMatchObject({ method: "prompt", params: { text: "hello", actor: "user2" } });
    expect(prompt.headers.get("Authorization")).toBe("Bearer agent-token");

    expect(events.map((event) => event.type)).toEqual(["agent_start", "message_end", "tool_execution_start", "message_end", "agent_end"]);
    expect(events[2]).toMatchObject({ toolName: "list_apps" });
    // The DO's own copy of the user message keeps its render id.
    expect(agent.state.messages[0]).toBe(userMessage);
    expect(agent.state.messages[1]).toMatchObject({ content: [{ name: "list_apps" }] });
    expect(agent.state.isStreaming).toBe(false);
    expect(store.data.agent).toEqual({ id: "client_1", token: "agent-token", model: "chiridion/openrouter/anthropic/claude-sonnet-5" });
    expect(store.data.cursor).toBe(12);
    expect(store.data.run).toBeNull();
    expect(activity()).toBeGreaterThan(0);

    // A second run reuses the agent; a changed thread model is configured before it.
    routeModel = "chiridion/anthropic/claude-opus-5";
    await agent.prompt(userMessage);
    expect(runtime.calls.filter((call) => call.path === "/v1/agents")).toHaveLength(1);
    expect(runtime.calls.find((call) => call.method === "PATCH")!.body).toMatchObject({ model: "chiridion/anthropic/claude-opus-5" });
    expect(store.data.agent?.model).toBe("chiridion/anthropic/claude-opus-5");
    routeModel = "chiridion/openrouter/anthropic/claude-sonnet-5";
  });

  it("sends run instructions ahead of the message and steers without an actor", async () => {
    const runtime = fakeRuntime((requestId) => [
      { type: "event", requestId, event: { type: "message_end", message: { role: "user", content: "## Outcome\n\nhello", timestamp: 9 } } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: {} } },
    ]);
    const store = memoryStore();
    const agent = new RuntimeAgentSession({
      env: { AGENT_RUNTIME_URL: "https://runtime.test", AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_DEFINITION: "def_1", APP_KV: {} as KVNamespace },
      store: store.store,
      identity: { orgId: "org1", workspaceId: "ws1", threadId: "thread1", subject: "user1" },
      actor: () => "user2",
      runInstructions: () => "## Outcome",
      initialState: { systemPrompt: "", model: MODEL, tools: [], messages: [], thinkingLevel: "medium" },
      configuration: async () => ({ systemPromptAppend: "" }),
      runtimeModel: async () => "chiridion/openrouter/anthropic/claude-sonnet-5",
      fetch: runtime.fetch,
    });
    await agent.prompt(userMessage);
    const prompt = runtime.calls.find((call) => call.path === "/clients/client_1/requests")!;
    expect(prompt.body).toMatchObject({ params: { text: "## Outcome\n\nhello" } });
    expect(agent.state.messages[0]).toBe(userMessage);
    agent.steer(userMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const steer = runtime.calls.filter((call) => call.path === "/clients/client_1/requests").at(-1)!;
    expect(steer.body).toMatchObject({ method: "steer", params: { text: "hello" } });
    expect((steer.body as { params: Record<string, unknown> }).params.actor).toBeUndefined();
  });

  it("keeps the turn open while the user answers a suspended run's input, then relays the resume", async () => {
    const ask = { type: "toolCall", id: "c1", name: "ask_user", arguments: {} };
    const input = { id: "inp_1", kind: "question", message: "Which?", detail: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } };
    const runtime = fakeRuntime((requestId, method) => method === "resume" ? [
      { type: "event", requestId, event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "ask_user", content: [{ type: "text", text: "A" }], isError: false } } },
      { type: "event", requestId, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "You chose A" }] } } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: { reply: "You chose A" } } },
    ] : [
      { type: "event", requestId, event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "message_end", message: { role: "assistant", content: [ask], stopReason: "toolUse" } } },
      { type: "event", requestId, event: { type: "tool_execution_end", toolCallId: "c1", toolName: "ask_user", result: { content: [], details: { inputRequired: true } } } },
      { type: "event", requestId, event: { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "ask_user", content: [], details: { inputRequired: true } } } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: { stopped: "input_required", inputs: [input] } } },
    ]);
    const store = memoryStore();
    const asked: unknown[] = [];
    const agent = new RuntimeAgentSession({
      env: { AGENT_RUNTIME_URL: "https://runtime.test", AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_DEFINITION: "def_1", APP_KV: {} as KVNamespace },
      store: store.store,
      identity: { orgId: "org1", workspaceId: "ws1", threadId: "thread1", subject: "user1" },
      actor: () => "user2",
      answerInput: async (value) => { asked.push(value); return { action: "accept", content: { answers: { "Which?": "A" } } }; },
      initialState: { systemPrompt: "", model: MODEL, tools: [], messages: [], thinkingLevel: "medium" },
      configuration: async () => ({ systemPromptAppend: "" }),
      runtimeModel: async () => "chiridion/openrouter/anthropic/claude-sonnet-5",
      fetch: runtime.fetch,
    });
    const events: Array<Record<string, unknown>> = [];
    agent.subscribe((event) => { events.push(event as never); });
    await agent.prompt(userMessage);

    expect(asked).toEqual([input]);
    const answer = runtime.calls.find((call) => call.path === "/v1/agents/client_1/inputs/inp_1")!;
    expect(answer.body).toEqual({ action: "accept", content: { answers: { "Which?": "A" } }, actor: "user2" });
    expect(answer.headers.get("Authorization")).toBe("Bearer operator");
    // One turn for the UI: the placeholder result and the first agent_end are not shown; the
    // answered call's result arrives as its tool end.
    expect(events.map((event) => event.type)).toEqual([
      "agent_start", "message_end", "tool_execution_end", "message_end", "message_end", "agent_end",
    ]);
    expect(events[2]).toMatchObject({ toolCallId: "c1", result: { content: [{ text: "A" }] } });
    expect(agent.state.messages.filter((message) => (message as { role: string }).role === "toolResult")).toHaveLength(1);
    expect(store.data.run).toBeNull();
  });

  it("ends the turn when a suspended run's input goes unanswered", async () => {
    const input = { id: "inp_1", kind: "approval", message: "Delete?", detail: {} };
    const runtime = fakeRuntime((requestId) => [
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: { stopped: "input_required", inputs: [input] } } },
    ]);
    const store = memoryStore();
    const agent = new RuntimeAgentSession({
      env: { AGENT_RUNTIME_URL: "https://runtime.test", AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_DEFINITION: "def_1", APP_KV: {} as KVNamespace },
      store: store.store,
      identity: { orgId: "org1", workspaceId: "ws1", threadId: "thread1", subject: "user1" },
      actor: () => null,
      answerInput: async () => { throw new Error("question timed out"); },
      initialState: { systemPrompt: "", model: MODEL, tools: [], messages: [], thinkingLevel: "medium" },
      configuration: async () => ({ systemPromptAppend: "" }),
      runtimeModel: async () => "chiridion/openrouter/anthropic/claude-sonnet-5",
      fetch: runtime.fetch,
    });
    const events: Array<Record<string, unknown>> = [];
    agent.subscribe((event) => { events.push(event as never); });
    await agent.prompt(userMessage);
    expect(events.map((event) => event.type)).toEqual(["agent_end"]);
    expect(runtime.calls.some((call) => call.path.includes("/inputs/"))).toBe(false);
  });

  it("refuses to start a run on a route the forwarder cannot take", async () => {
    const runtime = fakeRuntime(() => []);
    routeModel = null;
    try {
      const { agent } = session(runtime);
      await expect(agent.prompt(userMessage)).rejects.toThrow(/cannot run on the agent runtime/);
      expect(runtime.calls.some((call) => call.path === "/v1/agents")).toBe(false);
    } finally {
      routeModel = "chiridion/openrouter/anthropic/claude-sonnet-5";
    }
  });

  it("closes the turn with an error when the runtime refuses the run", async () => {
    const runtime = fakeRuntime((requestId) => [{ type: "response", id: requestId, outcome: { error: "Payment required" } }]);
    const { agent, events } = session(runtime);
    await agent.prompt(userMessage);
    expect(events.map((event) => event.type)).toEqual(["message_start", "message_end", "turn_end", "agent_end"]);
    expect(events[3]).toMatchObject({ messages: [{ stopReason: "error", errorMessage: "Payment required" }] });
  });

  it("resumes a run in flight by replaying it from its start cursor, without prompting again", async () => {
    const runtime = fakeRuntime((requestId) => [
      { type: "event", requestId, event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: {} } },
    ]);
    const first = session(runtime);
    await first.agent.prompt(userMessage);
    const runId = (runtime.calls.find((call) => call.path === "/clients/client_1/requests")!.body as { id: string }).id;
    // The DO restarted mid-run: its store still names the run and where it began.
    const store = memoryStore();
    store.data.agent = first.store.data.agent;
    store.data.run = { requestId: runId, cursor: 5 };
    const second = session(runtime, store);
    const requestsBefore = runtime.calls.filter((call) => call.method === "POST" && call.path === "/clients/client_1/requests").length;
    await second.agent.continue();
    expect(second.events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
    expect(runtime.calls.filter((call) => call.method === "POST" && call.path === "/clients/client_1/requests")).toHaveLength(requestsBefore);
    expect(store.data.run).toBeNull();
  });

  it("closes out a resumed turn whose message never reached the runtime", async () => {
    const runtime = fakeRuntime(() => []);
    const { agent, events } = session(runtime);
    await agent.continue();
    expect(events.at(-1)).toMatchObject({ type: "agent_end", messages: [{ errorMessage: expect.stringContaining("did not reach") }] });
  });
});

describe("runtimeInputQuestions", () => {
  it("asks ask_user questions as they are and answers with their labels", async () => {
    const { runtimeInputQuestions } = await import("../src/chat-thread/runtime-agent");
    const card = runtimeInputQuestions({
      id: "i", kind: "question", message: "",
      detail: { questions: [
        { question: "Color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] },
        { question: "Sizes?", header: "Size", options: [{ label: "S" }, { label: "M" }], multiSelect: true },
      ] },
    })!;
    expect(card.questions[1]).toMatchObject({ question: "Sizes?", multiSelect: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }] });
    expect(card.answer({ "Color?": "Blue", "Sizes?": "S, M" })).toEqual({ action: "accept", content: { answers: { "Color?": "Blue", "Sizes?": ["S", "M"] } } });
  });

  it("asks approvals and tool confirmations as Yes/No and URL steps as Done/Cancel", async () => {
    const { runtimeInputQuestions } = await import("../src/chat-thread/runtime-agent");
    const approval = runtimeInputQuestions({ id: "i", kind: "approval", message: "", detail: { tool: "camel__delete_app" } })!;
    expect(approval.questions[0].question).toBe("Allow delete_app to run?");
    expect(approval.answer({ "Allow delete_app to run?": "Yes" })).toEqual({ action: "accept" });
    expect(approval.answer({ "Allow delete_app to run?": "No" })).toEqual({ action: "decline" });
    const confirm = runtimeInputQuestions({ id: "i", kind: "form", message: "Delete app x?", detail: { requestedSchema: { type: "object", properties: {} } } })!;
    expect(confirm.answer({ "Delete app x?": "Yes" })).toEqual({ action: "accept", content: {} });
    const url = runtimeInputQuestions({ id: "i", kind: "url", message: "Connect Slack", detail: { url: "https://x.test/c" } })!;
    expect(url.questions[0].question).toBe("Connect Slack\n\nhttps://x.test/c");
    expect(url.answer({ [url.questions[0].question]: "Cancel" })).toEqual({ action: "cancel" });
    expect(runtimeInputQuestions({ id: "i", kind: "form", message: "Fill", detail: { requestedSchema: { type: "object", properties: { a: { type: "string" } } } } })).toBeNull();
  });
});

describe("readableProviderError", () => {
  it("reduces a provider error to the message chiridion's forwarder wrote", async () => {
    const { readableProviderError } = await import("../src/chat-thread/runtime-agent");
    expect(readableProviderError('openrouter API error (429): {"message":"LLM usage limit reached.","type":"usage_limit"}')).toBe("LLM usage limit reached.");
    expect(readableProviderError('Unknown: 429: {"message":"Limit hit"}')).toBe("Limit hit");
    expect(readableProviderError('Anthropic API error (402): {"type":"error","error":{"type":"billing_error","message":"Out of credits"}}')).toBe("Out of credits");
    expect(readableProviderError("socket hang up")).toBe("socket hang up");
  });
});
