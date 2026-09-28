/**
 * Sends to threads that run directly on the hosted agent runtime
 * (plans/runtime-threads-direct.md §4.2), against a real OrgDO and a fake
 * runtime tenant API.
 *
 * Run with: bun run test:workers
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import { stringifyStoredLlmProviderConfig } from "../../../src/lib/llm-provider-config";
import type { ChatEnv } from "../src/chat-thread/types";
import {
  abortRuntimeThread,
  answerRuntimeInput,
  mintRuntimeBrowserToken,
  pinNewThreadToRuntime,
  startRuntimeTurn,
} from "../src/agent-runtime/thread-runtime";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const RUNTIME = "https://runtime.test";
const runtimeEnv = {
  ...(env as unknown as ChatEnv),
  AGENT_RUNTIME_URL: RUNTIME,
  AGENT_RUNTIME_API_TOKEN: "operator-token",
  AGENT_RUNTIME_TENANT: "chiridion-test",
  AGENT_RUNTIME_DEFINITION: "def_test",
} as ChatEnv;

type Call = { method: string; path: string; body: any; headers: Headers };

function fakeRuntime(responses: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== RUNTIME) return original(input, init);
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    if (responses[key]) return responses[key](call);
    if (key === "POST /v1/agents") return Response.json({ id: "agt_1", token: "agent-token" }, { status: 201 });
    if (key.endsWith("/prompt")) return Response.json({ id: call.body.requestId, method: "prompt", state: "running", fingerprint: "f" }, { status: 202 });
    if (key.endsWith("/configuration")) return Response.json({ id: call.body.requestId, method: "configure", state: "running", fingerprint: "f" }, { status: 202 });
    if (key.endsWith("/browser-tokens")) return Response.json({ token: "abt_1", expiresAt: 1_900_000_000_000, agentId: "agt_1", url: "https://agents.test" }, { status: 201 });
    if (key.endsWith("/abort")) return Response.json({ aborted: true });
    return Response.json({}, { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const testEmail = () => `rt-turn-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

/** A BYOK (Anthropic) org with one runtime thread. */
async function runtimeThread() {
  const { userId } = await createUser(testEnv, testEmail(), "password123", "Runtime Sender");
  const { org, defaultWorkspaceId } = await createOrg(testEnv, "Runtime Org", userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const encrypted = await encryptCredentials({ api_key: "sk-ant-test" }, testEnv.INTEGRATION_SECRET_KEY ?? "test-secret");
  await orgStub.setLlmProviderConfig("anthropic", encrypted, stringifyStoredLlmProviderConfig({}), userId);
  const thread = await orgStub.createThread(defaultWorkspaceId as string, "Runtime thread", userId);
  await orgStub.pinThreadRuntime(thread.id);
  const context = {
    orgId: org.id,
    workspaceId: defaultWorkspaceId as string,
    threadId: thread.id,
    userId,
    userName: "Runtime Sender",
    userEmail: null,
  };
  return { orgStub, context, sender: { userId, userName: "Runtime Sender", userEmail: null }, threadId: thread.id };
}

async function send(setup: Awaited<ReturnType<typeof runtimeThread>>, text: string, clientMessageId: string) {
  const pending: Promise<unknown>[] = [];
  const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
  const result = await startRuntimeTurn(runtimeEnv, {
    context: setup.context,
    row,
    sender: setup.sender,
    text,
    clientMessageId,
    waitUntil: (promise) => { pending.push(promise); },
  });
  await Promise.allSettled(pending);
  return result;
}

describe("startRuntimeTurn", () => {
  it("creates the thread's agent on the first send and prompts it as the sender", async () => {
    const setup = await runtimeThread();
    const calls = fakeRuntime();
    const result = await send(setup, "Hello runtime", "cm_1");
    expect(result).toMatchObject({ status: "accepted", requestId: "cm_1", agentId: "agt_1" });

    const create = calls.find((call) => call.method === "POST" && call.path === "/v1/agents")!;
    expect(create.headers.get("idempotency-key")).toBe(`thread_${setup.threadId}`);
    expect(create.headers.get("authorization")).toBe("Bearer operator-token");
    expect(create.body).toMatchObject({
      definition: "def_test",
      keyScope: `org_${setup.context.orgId}`,
      subject: setup.sender.userId,
      context: { org: setup.context.orgId, workspace: setup.context.workspaceId, thread: setup.threadId },
    });
    expect(create.body.model).toMatch(/^anthropic\//);
    expect(create.body.systemPromptAppend).toContain("camelAI tools on this runtime");

    const prompt = calls.find((call) => call.path === "/v1/agents/agt_1/prompt")!;
    expect(prompt.body).toEqual({
      text: "Hello runtime",
      from: { id: setup.sender.userId, name: "Runtime Sender" },
      actor: setup.sender.userId,
      requestId: "cm_1",
    });
    // The org's key scope was synced before the run.
    expect(calls.some((call) => call.path.startsWith(`/v1/key-scopes/org_${setup.context.orgId}/providers/anthropic`))).toBe(true);

    expect(await setup.orgStub.getThreadRuntime(setup.threadId)).toMatchObject({
      agentId: "agt_1",
      model: create.body.model,
      keyScope: `org_${setup.context.orgId}`,
    });
    const thread = await setup.orgStub.getThread(setup.threadId);
    expect(thread?.last_user_message).toBe("Hello runtime");
  });

  it("reuses the agent, and configures it only when the model changes", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_a");
    let calls = fakeRuntime();
    expect(await send(setup, "second", "cm_b")).toMatchObject({ status: "accepted" });
    expect(calls.some((call) => call.path === "/v1/agents")).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/configuration"))).toBe(false);

    await setup.orgStub.updateThreadModel(setup.threadId, "opus");
    calls = fakeRuntime();
    await send(setup, "third", "cm_c");
    const configure = calls.find((call) => call.path === "/v1/agents/agt_1/configuration")!;
    expect(configure.body).toMatchObject({ spendLimit: null, thinkingLevel: expect.any(String) });
    expect(configure.body.model).toMatch(/^anthropic\//);
    expect(configure.body).not.toHaveProperty("keyScope");
    const order = calls.map((call) => call.path);
    expect(order.indexOf("/v1/agents/agt_1/configuration")).toBeLessThan(order.indexOf("/v1/agents/agt_1/prompt"));
  });

  it("refuses an empty message without calling the runtime", async () => {
    const setup = await runtimeThread();
    const calls = fakeRuntime();
    expect(await send(setup, "   ", "cm_x")).toMatchObject({ status: "error", error: "Empty message" });
    expect(calls).toHaveLength(0);
  });

  it("answers busy when the runtime has too many queued", async () => {
    const setup = await runtimeThread();
    fakeRuntime({ "POST /v1/agents/agt_1/prompt": () => Response.json({ error: "Too many requests queued for this agent" }, { status: 429 }) });
    expect(await send(setup, "hi", "cm_busy")).toMatchObject({ status: "busy" });
  });
});

describe("runtime thread reads and writes", () => {
  it("mints a read-only browser token for one agent, showing costs to BYOK threads", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "hi", "cm_t");
    const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    const calls = fakeRuntime();
    const token = await mintRuntimeBrowserToken(runtimeEnv, { ...row, agentId: row.agentId! }, setup.sender.userId);
    expect(token).toEqual({ token: "abt_1", expiresAt: 1_900_000_000_000, agentId: "agt_1", url: "https://agents.test" });
    expect(calls[0].body).toMatchObject({
      ttlSeconds: 900,
      scopes: ["events", "state", "history", "inputs"],
      subject: setup.sender.userId,
    });
    expect(calls[0].body.events).toContain("message_update");
    expect(calls[0].body).not.toHaveProperty("redact");

    const hosted = fakeRuntime();
    await mintRuntimeBrowserToken(runtimeEnv, { ...row, agentId: row.agentId!, keyScope: "hosted" }, setup.sender.userId);
    expect(hosted[0].body.redact).toEqual(["usage.cost"]);
  });

  it("answers an input as the user, passes the runtime's refusals through, and aborts", async () => {
    const setup = await runtimeThread();
    let calls = fakeRuntime({
      "POST /v1/agents/agt_1/inputs/in_1": () => Response.json({ input: { id: "in_1" }, request: null }, { status: 202 }),
      "POST /v1/agents/agt_1/inputs/in_2": () => Response.json({ error: "The input had already settled" }, { status: 409 }),
    });
    expect(await answerRuntimeInput(runtimeEnv, "agt_1", "in_1", { action: "accept", content: { answers: { Q: "A" } } }, setup.sender))
      .toMatchObject({ status: 200 });
    expect(calls[0].body).toEqual({ action: "accept", content: { answers: { Q: "A" } }, from: { id: setup.sender.userId, name: "Runtime Sender" } });
    expect(await answerRuntimeInput(runtimeEnv, "agt_1", "in_2", { action: "decline" }, setup.sender)).toMatchObject({ status: 409 });

    calls = fakeRuntime();
    await abortRuntimeThread(runtimeEnv, "agt_1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/agents/agt_1/abort" });
  });
});

describe("pinNewThreadToRuntime", () => {
  it("pins a new thread only where direct runtime threads are on", async () => {
    const setup = await runtimeThread();
    const thread = await setup.orgStub.createThread(setup.context.workspaceId, "Fresh", setup.sender.userId);
    const context = { ...setup.context, threadId: thread.id };
    expect(await pinNewThreadToRuntime(runtimeEnv, context)).toBeNull();
    expect(await setup.orgStub.getThreadRuntime(thread.id)).toBeNull();

    const pinned = await pinNewThreadToRuntime({ ...runtimeEnv, AGENT_RUNTIME_DIRECT_THREADS: "1" } as ChatEnv, context);
    expect(pinned).toMatchObject({ threadId: thread.id, agentId: null });
    expect(await setup.orgStub.getThreadRuntime(thread.id)).toMatchObject({ threadId: thread.id });
  });

  it("leaves a thread whose model has no runtime route on ChatThreadDO", async () => {
    const setup = await runtimeThread();
    const encrypted = await encryptCredentials({ api_key: "sk-custom" }, testEnv.INTEGRATION_SECRET_KEY ?? "test-secret");
    await setup.orgStub.setLlmProviderConfig(
      "custom",
      encrypted,
      stringifyStoredLlmProviderConfig({ custom_base_url: "https://llm.example.test/v1", custom_api: "openai-completions", custom_model_id: "house-model" }),
      setup.sender.userId,
    );
    const thread = await setup.orgStub.createThread(setup.context.workspaceId, "Custom", setup.sender.userId);
    const context = { ...setup.context, threadId: thread.id };
    expect(await pinNewThreadToRuntime({ ...runtimeEnv, AGENT_RUNTIME_DIRECT_THREADS: "1" } as ChatEnv, context)).toBeNull();
    expect(await setup.orgStub.getThreadRuntime(thread.id)).toBeNull();
  });
});
