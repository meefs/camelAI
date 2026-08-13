import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTACH_TIMEOUT_MS,
  SseAgentClient,
  type SseAgentCloseEvent,
} from "@/lib/sse-agent-client";

interface StreamHandle {
  url: string;
  write(text: string): void;
  frame(frame: unknown): void;
  bye(reason: string): void;
  heartbeat(): void;
  end(): void;
  fail(error: unknown): void;
}

/** Scriptable stand-in for the worker's SSE attach + POST /call endpoints. */
class FakeChatTransport {
  attachUrls: string[] = [];
  streams: StreamHandle[] = [];
  posts: Array<{ url: string; frame: Record<string, unknown> }> = [];
  /** Scripted outcomes for upcoming attaches; a missing entry means a 200 stream. */
  attachStatuses: Array<{ status?: number; body?: string; hang?: boolean }> = [];
  postResponder: (
    frame: Record<string, unknown>,
    url: string,
  ) => Response | Promise<Response> = (frame) =>
    frame.type === "rpc"
      ? new Response(
          JSON.stringify({
            type: "rpc",
            id: frame.id,
            success: true,
            result: { status: "accepted" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response(null, { status: 204 });

  fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if ((init?.method ?? "GET") === "GET") {
      this.attachUrls.push(url);
      const scripted = this.attachStatuses.shift();
      if (scripted?.hang) {
        // Only the client's own abort ends this attach, as a dead network does.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      if (scripted?.status) {
        return new Response(scripted.body ?? "denied", {
          status: scripted.status,
        });
      }
      return this.openStream(url);
    }
    const frame = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    this.posts.push({ url, frame });
    return this.postResponder(frame, url);
  };

  get lastStream(): StreamHandle {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no stream has been opened");
    return stream;
  }

  private openStream(url: string): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
    });
    const write = (text: string) => {
      controller.enqueue(encoder.encode(text));
    };
    this.streams.push({
      url,
      write,
      frame: (frame) => write(`data: ${JSON.stringify(frame)}\n\n`),
      bye: (reason) => write(`event: bye\ndata: {"reason":"${reason}"}\n\n`),
      heartbeat: () => write(":hb\n\n"),
      end: () => controller.close(),
      fail: (error) => controller.error(error),
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const THREAD_ID = "11111111-2222-4333-8444-555555555555";
const WORKSPACE_ID = "99999999-8888-4777-8666-555555555555";

describe("SseAgentClient", () => {
  let transport: FakeChatTransport;
  let clients: SseAgentClient[] = [];
  let events: {
    opens: number;
    messages: string[];
    closes: SseAgentCloseEvent[];
    errors: unknown[];
    states: Array<[unknown, string]>;
    stateErrors: unknown[];
    mcp: unknown[];
    identities: Array<[string, string]>;
    connectionErrors: Array<Error & { code: number }>;
  };

  function createClient(): SseAgentClient {
    const client = new SseAgentClient({
      agent: "chat-thread",
      name: THREAD_ID,
      query: { threadId: THREAD_ID, workspaceId: WORKSPACE_ID },
      onOpen: () => {
        events.opens += 1;
      },
      onMessage: (event) => {
        events.messages.push(event.data);
      },
      onClose: (event) => {
        events.closes.push(event);
      },
      onError: (error) => {
        events.errors.push(error);
      },
      onStateUpdate: (state, source) => {
        events.states.push([state, source]);
      },
      onStateUpdateError: (error) => {
        events.stateErrors.push(error);
      },
      onMcpUpdate: (mcp) => {
        events.mcp.push(mcp);
      },
      onIdentity: (name, agent) => {
        events.identities.push([name, agent]);
      },
      onConnectionError: (error) => {
        events.connectionErrors.push(error);
      },
    });
    clients.push(client);
    return client;
  }

  async function openedClient(): Promise<SseAgentClient> {
    const client = createClient();
    client.start();
    await waitUntil(() => events.opens === 1, "the stream to open");
    return client;
  }

  beforeEach(() => {
    transport = new FakeChatTransport();
    vi.stubGlobal("fetch", transport.fetch);
    clients = [];
    events = {
      opens: 0,
      messages: [],
      closes: [],
      errors: [],
      states: [],
      stateErrors: [],
      mcp: [],
      identities: [],
      connectionErrors: [],
    };
  });

  afterEach(() => {
    for (const client of clients) client.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes a stable http base url and attaches with the transport query", async () => {
    const client = createClient();
    expect(client.getHttpUrl()).toBe(
      `http://localhost:3000/agents/chat-thread/${THREAD_ID}`,
    );
    expect(client.getHttpUrl()).not.toContain("?");
    expect(client.readyState).toBe(3);

    client.start();
    expect(client.readyState).toBe(0);
    await waitUntil(() => events.opens === 1, "the stream to open");
    expect(client.readyState).toBe(1);

    const url = new URL(transport.attachUrls[0]);
    expect(url.pathname).toBe(`/agents/chat-thread/${THREAD_ID}/sse`);
    expect(url.searchParams.get("threadId")).toBe(THREAD_ID);
    expect(url.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
    expect(url.searchParams.get("_pk")).toBe(client._pk);
    expect(client.path).toEqual([{ agent: "chat-thread", name: THREAD_ID }]);
    // The base URL feeds the AI SDK chat id, so it must not follow _pk churn.
    expect(client.getHttpUrl()).toBe(
      `http://localhost:3000/agents/chat-thread/${THREAD_ID}`,
    );
  });

  it("fans every frame to listeners but routes the intercepted five to option callbacks", async () => {
    const client = await openedClient();
    const seen: string[] = [];
    client.addEventListener("message", (event) => seen.push(event.data));

    const stream = transport.lastStream;
    stream.heartbeat();
    stream.frame({ type: "cf_agent_chat_messages", messages: [] });
    stream.frame({ type: "cf_agent_state", state: { model: "sonnet" } });
    stream.frame({ type: "cf_agent_identity", name: THREAD_ID, agent: "chat-thread" });
    stream.frame({ type: "cf_agent_state_error", error: "bad state" });
    stream.frame({ type: "cf_agent_mcp_servers", mcp: { servers: [] } });
    // Split a frame across two writes: the reader must buffer partial events.
    stream.write('data: {"type":"chat_group_avatar_upda');
    stream.write(`ted","threadId":"${THREAD_ID}","groupId":"g1"}\n\n`);

    await waitUntil(() => seen.length === 6, "all six frames");
    expect(seen.map((raw) => JSON.parse(raw).type)).toEqual([
      "cf_agent_chat_messages",
      "cf_agent_state",
      "cf_agent_identity",
      "cf_agent_state_error",
      "cf_agent_mcp_servers",
      "chat_group_avatar_updated",
    ]);
    expect(events.messages.map((raw) => JSON.parse(raw).type)).toEqual([
      "cf_agent_chat_messages",
      "chat_group_avatar_updated",
    ]);
    expect(events.states).toEqual([[{ model: "sonnet" }, "server"]]);
    expect(events.stateErrors).toEqual(["bad state"]);
    expect(events.mcp).toEqual([{ servers: [] }]);
    expect(events.identities).toEqual([[THREAD_ID, "chat-thread"]]);
  });

  it("honors {signal} and removeEventListener for listener teardown", async () => {
    const client = await openedClient();
    const controller = new AbortController();
    const signalled: string[] = [];
    const manual: string[] = [];
    const manualListener = (event: { data: string }) => manual.push(event.data);
    client.addEventListener("message", (event) => signalled.push(event.data), {
      signal: controller.signal,
    });
    client.addEventListener("message", manualListener);

    transport.lastStream.frame({ type: "cf_agent_chat_recovering", recovering: true });
    await waitUntil(() => signalled.length === 1, "the first frame");

    controller.abort();
    client.removeEventListener("message", manualListener);
    transport.lastStream.frame({ type: "cf_agent_chat_recovering", recovering: false });
    await waitUntil(() => events.messages.length === 2, "the second frame");

    expect(signalled).toHaveLength(1);
    expect(manual).toHaveLength(1);
  });

  it("queues resume frames until the stream is live and drops other frames loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createClient();
    client.send(
      JSON.stringify({ type: "cf_agent_stream_resume_request", probeId: "p1" }),
    );
    expect(transport.posts).toHaveLength(0);

    client.start();
    await waitUntil(() => transport.posts.length === 1, "the queued resume POST");
    const post = transport.posts[0];
    expect(post.frame).toEqual({
      type: "cf_agent_stream_resume_request",
      probeId: "p1",
    });
    const url = new URL(post.url);
    expect(url.pathname).toBe(`/agents/chat-thread/${THREAD_ID}/call`);
    expect(url.searchParams.get("_pk")).toBe(client._pk);

    client.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "req-1" }));
    await waitUntil(() => transport.posts.length === 2, "the ack POST");

    client.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
    expect(transport.posts).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cf_agent_chat_clear"),
    );
  });

  it("resolves a call from the POST response frame and rejects error frames", async () => {
    const client = await openedClient();

    await expect(
      client.call("sendMessage", ["hello", "client-1"], { timeout: 15_000 }),
    ).resolves.toEqual({ status: "accepted" });
    expect(transport.posts[0].frame).toMatchObject({
      type: "rpc",
      method: "sendMessage",
      args: ["hello", "client-1"],
    });
    expect(typeof transport.posts[0].frame.id).toBe("string");

    transport.postResponder = (frame) =>
      new Response(
        JSON.stringify({
          type: "rpc",
          id: frame.id,
          success: false,
          error: "thread is busy",
        }),
        { status: 200 },
      );
    await expect(client.call("requestStop")).rejects.toThrow("thread is busy");
  });

  it("queues a call issued before the stream opens and flushes it on open", async () => {
    const client = createClient();
    const pending = client.call<{ status: string }>("refreshModel");
    expect(transport.posts).toHaveLength(0);

    client.start();
    await expect(pending).resolves.toEqual({ status: "accepted" });
    expect(transport.posts).toHaveLength(1);
  });

  it("times out a call with the SDK's message", async () => {
    const client = await openedClient();
    transport.postResponder = () => new Promise<Response>(() => {});
    vi.useFakeTimers();

    const pending = client.call("requestStop", [], { timeout: 5_000 });
    const assertion = expect(pending).rejects.toThrow(
      "RPC call to requestStop timed out after 5000ms",
    );
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it("parks the stream as dormant on bye idle and reattaches on visibilitychange", async () => {
    const client = await openedClient();
    transport.lastStream.bye("idle");
    await waitUntil(() => events.closes.length === 1, "the idle close");

    expect(events.closes[0].byeReason).toBe("idle");
    expect(events.closes[0].wasClean).toBe(true);
    // Dormant by design still counts as OPEN: sends are POSTs.
    expect(client.readyState).toBe(1);
    expect(client.connectionError).toBeNull();

    document.dispatchEvent(new Event("visibilitychange"));
    await waitUntil(() => events.opens === 2, "the reattach after wake");
    expect(transport.attachUrls).toHaveLength(2);
  });

  it("reattaches a dormant stream when a call is dispatched", async () => {
    const client = await openedClient();
    transport.lastStream.bye("idle");
    await waitUntil(() => events.closes.length === 1, "the idle close");

    await expect(client.call("refreshModel")).resolves.toEqual({
      status: "accepted",
    });
    await waitUntil(() => events.opens === 2, "the reattach after the call");
  });

  it("reattaches with backoff after an EOF with no bye", async () => {
    const client = await openedClient();
    vi.useFakeTimers();
    transport.lastStream.end();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.closes).toHaveLength(1);
    expect(events.closes[0].status).toBeNull();
    expect(events.closes[0].byeReason).toBeNull();
    expect(events.closes[0].aborted).toBe(false);
    expect(client.readyState).toBe(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.attachUrls).toHaveLength(2);
    expect(events.opens).toBe(2);
  });

  it("latches a terminal connectionError on a 403 attach and stops reconnecting", async () => {
    transport.attachStatuses.push({ status: 403, body: "forbidden" });
    const client = createClient();
    client.start();
    await waitUntil(
      () => events.connectionErrors.length === 1,
      "the terminal connection error",
    );

    const error = events.connectionErrors[0];
    expect(error.code).toBe(4403);
    expect(error.name).toBe("AgentConnectionError");
    expect(client.connectionError?.code).toBe(4403);
    expect(client.readyState).toBe(3);
    expect(events.closes[0].status).toBe(403);
    expect(events.closes[0].code).toBe(4403);
    expect(events.closes[0].wasClean).toBe(false);

    await expect(client.call("requestStop")).rejects.toThrow("Connection closed");

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.attachUrls).toHaveLength(1);
  });

  it("retries a 503 attach without latching a connection error", async () => {
    transport.attachStatuses.push({ status: 503, body: "unavailable" });
    const client = createClient();
    vi.useFakeTimers();
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.connectionErrors).toHaveLength(0);
    expect(events.closes[0].status).toBe(503);
    expect(events.errors).toHaveLength(1);
    expect(client.readyState).toBe(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.attachUrls).toHaveLength(2);
    expect(events.opens).toBe(1);
  });

  it("rejects in-flight calls with Connection closed on bye forbidden", async () => {
    const client = await openedClient();
    transport.postResponder = () => new Promise<Response>(() => {});
    const pending = client.call("sendMessage", ["hi", "client-2"], { timeout: 0 });
    await waitUntil(() => transport.posts.length === 1, "the send POST");

    transport.lastStream.bye("forbidden");
    await expect(pending).rejects.toThrow("Connection closed");
    expect(client.connectionError?.code).toBe(4403);
    expect(events.closes[0].byeReason).toBe("forbidden");
    expect(client.readyState).toBe(3);
  });

  it("reports an intentional teardown on close() and does not reconnect", async () => {
    const client = await openedClient();
    vi.useFakeTimers();
    client.close();

    expect(events.closes).toHaveLength(1);
    expect(events.closes[0].aborted).toBe(true);
    expect(events.closes[0].wasClean).toBe(true);
    expect(client.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.attachUrls).toHaveLength(1);
  });

  it("reconnect() forces a fresh generation with a new connection id", async () => {
    const client = await openedClient();
    const firstPk = client._pk;
    client.reconnect();
    await waitUntil(() => events.opens === 2, "the forced reattach");

    expect(transport.attachUrls).toHaveLength(2);
    expect(client._pk).not.toBe(firstPk);
    expect(new URL(transport.attachUrls[1]).searchParams.get("_pk")).toBe(
      client._pk,
    );
  });

  it("closes the retiring generation before reconnect() opens the next one", async () => {
    const client = await openedClient();
    const order: string[] = [];
    client.addEventListener("close", () => order.push("close"));
    client.addEventListener("open", () => order.push("open"));

    client.reconnect();
    // `useAgentChat` only re-arms its resume probe on close→open; without this
    // close the replacement stream stays excluded from the live turn.
    expect(order).toEqual(["close"]);
    expect(events.closes).toHaveLength(1);
    expect(events.closes[0].aborted).toBe(true);
    expect(events.closes[0].wasClean).toBe(true);
    expect(events.closes[0].reason).toBe("reconnect");
    expect(events.closes[0].byeReason).toBeNull();
    expect(client.readyState).toBe(0);

    await waitUntil(() => events.opens === 2, "the forced reattach");
    expect(order).toEqual(["close", "open"]);
    expect(client.connectionError).toBeNull();
  });

  it("does not double-close a dormant stream on reconnect()", async () => {
    const client = await openedClient();
    transport.lastStream.bye("idle");
    await waitUntil(() => events.closes.length === 1, "the idle close");

    client.reconnect();
    await waitUntil(() => events.opens === 2, "the reattach");
    expect(events.closes).toHaveLength(1);
    expect(events.closes[0].byeReason).toBe("idle");
  });

  it("reattaches and replays a resume frame when the shim is gone (409)", async () => {
    const client = await openedClient();
    let responded = false;
    transport.postResponder = () => {
      if (responded) return new Response(null, { status: 204 });
      responded = true;
      return new Response("no shim", { status: 409 });
    };

    client.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "req-9" }));
    await waitUntil(() => transport.posts.length === 2, "the replayed resume POST");

    expect(transport.attachUrls).toHaveLength(2);
    expect(transport.posts[1].frame).toEqual({
      type: "cf_agent_stream_resume_ack",
      id: "req-9",
    });
    expect(client.connectionError).toBeNull();
  });

  it("does not strand a requeued resume frame on a still-open stream", async () => {
    for (const failOnce of [
      () => new Response("unavailable", { status: 503 }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]) {
      transport = new FakeChatTransport();
      vi.stubGlobal("fetch", transport.fetch);
      events.opens = 0;
      const client = await openedClient();
      let failed = false;
      transport.postResponder = () => {
        if (failed) return new Response(null, { status: 204 });
        failed = true;
        return failOnce();
      };

      // The stream itself stays live, so nothing else would ever re-drive the
      // queue: the reattach is the only thing that flushes it.
      client.send(
        JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "req-503" }),
      );
      await waitUntil(
        () => transport.posts.length === 2,
        "the replayed resume POST",
      );

      expect(transport.attachUrls).toHaveLength(2);
      expect(transport.posts[1].frame).toEqual({
        type: "cf_agent_stream_resume_ack",
        id: "req-503",
      });
      expect(new URL(transport.posts[1].url).searchParams.get("_pk")).toBe(
        client._pk,
      );
      expect(client.connectionError).toBeNull();
      client.close();
    }
  });

  it("drops a resume frame that fails again after its reattach", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = await openedClient();
    transport.postResponder = () => new Response("unavailable", { status: 503 });

    client.send(
      JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "req-dead" }),
    );
    await waitUntil(
      () =>
        warn.mock.calls.some((call) =>
          String(call[0]).includes("Dropped a resume frame"),
        ),
      "the drop warning",
    );

    expect(transport.posts).toHaveLength(2);
    expect(transport.attachUrls).toHaveLength(2);
    expect(client.connectionError).toBeNull();
    expect(client.readyState).toBe(1);
  });

  it("rejects one call on a 400 without latching a terminal error", async () => {
    const client = await openedClient();
    transport.postResponder = () => new Response("blocked frame", { status: 400 });

    await expect(client.call("requestStop")).rejects.toThrow(
      "failed with status 400",
    );
    expect(client.connectionError).toBeNull();
    expect(events.connectionErrors).toHaveLength(0);
    expect(client.readyState).toBe(1);
  });

  it("retries the attach after the attach timeout budget", async () => {
    transport.attachStatuses.push({ hang: true });
    const client = createClient();
    vi.useFakeTimers();
    client.start();
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);

    expect(events.opens).toBe(0);
    expect(events.errors).toHaveLength(1);
    expect(String((events.errors[0] as Error).message)).toContain("TIMEOUT");
    expect(events.closes[0].reason).toBe("attach timeout");
    expect(client.readyState).toBe(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.attachUrls).toHaveLength(2);
    expect(events.opens).toBe(1);
  });

  it("reports a mid-stream reader error and reconnects", async () => {
    const client = await openedClient();
    vi.useFakeTimers();
    transport.lastStream.fail(new Error("network gone"));
    await vi.advanceTimersByTimeAsync(0);

    expect(events.errors).toHaveLength(1);
    expect(events.closes[0].reason).toBe("network gone");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.attachUrls).toHaveLength(2);
    expect(client.readyState).toBe(1);
  });
});
