// Synthetic Connection for the SSE chat transport. ChatThreadDO registers one
// shim per open stream and then drives the EXISTING wrapped
// onConnect/onMessage/onClose chains with it, so the chat protocol is never
// re-implemented for HTTP. Modelled on the Agents SDK's own non-WebSocket
// connection factory (`Agent._cf_createSubAgentBridgeConnection`).
//
// Three properties of this shim are load-bearing and easy to break:
//  - `state` must be an OWN accessor. `Agent._ensureConnectionWrapped` only
//    binds a live getter when `getOwnPropertyDescriptor(conn, "state").get`
//    exists; with a plain field it snapshots the value once and the connection
//    flags (readonly / no-protocol) silently stop tracking.
//  - `send` must NEVER throw. `Agent.broadcast` calls it with no try/catch, and
//    the SDK's `sendIfOpen`/`sendRpcResponseIfOpen` only swallow the
//    WebSocket-specific "send() after close" TypeError; anything else aborts a
//    live turn's fan-out or a mid-replay loop.
//  - `serializeAttachment` MERGES. The state slot also carries Agent's internal
//    `_cf_*` connection flags, so a whole-slot write would drop them.

const CF_INTERNAL_KEY_PREFIX = "_cf_";

// A peer can vanish without the runtime rejecting anything (a cancelled reader
// on the far side of a Durable Object stub does not necessarily error the
// writable half), leaving every broadcast to queue in the transform forever.
// Cap the outstanding bytes and treat a runaway queue as a dead peer: the client
// reconnects and replays from chunk 0, which is cheaper than an unbounded buffer
// inside the DO. A reader that is actually draining never approaches this.
export const SSE_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();

export type SseByeReason = "idle" | "retry" | "forbidden" | "shutdown";

/** Sink for one synthetic connection. No method may throw. */
export interface SseConnectionSink {
  /** Returns false once the sink is gone. */
  send(payload: string): boolean;
  comment(text: string): boolean;
  bye(reason: SseByeReason): void;
  close(): void;
  /**
   * Set by the owning connection. Fired once when the sink discovers on its own
   * that the peer is gone (a queued write rejected), so teardown does not have
   * to wait for the next broadcast or heartbeat.
   */
  onDead?: (() => void) | null;
}

/**
 * WS close code → SSE `bye` reason. Mirrors the terminality the browser used to
 * read off the close code: 1008 is an authoritative denial, 1013 is "retry once
 * the authorization DOs recover", a redeploy/going-away is reconnectable.
 */
export function sseByeReasonForCloseCode(code: number | undefined): SseByeReason {
  if (code === 1008) return "forbidden";
  if (code === 1001 || code === 1012) return "shutdown";
  return "retry";
}

export function createSseStreamSink(
  writer: WritableStreamDefaultWriter<Uint8Array>,
): SseConnectionSink {
  let dead = false;
  let queuedBytes = 0;
  const die = () => {
    if (dead) return;
    dead = true;
    sink.onDead?.();
  };
  // Writes are deliberately not awaited: the caller is inside a broadcast loop
  // that must not block on client backpressure, and a rejected write only means
  // the peer is gone (the connection is marked dead and torn down).
  const write = (frame: string): boolean => {
    if (dead) return false;
    const bytes = encoder.encode(frame);
    if (queuedBytes + bytes.byteLength > SSE_MAX_QUEUED_BYTES) {
      die();
      return false;
    }
    queuedBytes += bytes.byteLength;
    const settle = () => {
      queuedBytes -= bytes.byteLength;
    };
    try {
      void writer.write(bytes).then(settle, () => {
        settle();
        die();
      });
    } catch {
      settle();
      die();
      return false;
    }
    return true;
  };
  const sink: SseConnectionSink = {
    onDead: null,
    send(payload) {
      return write(`data: ${payload}\n\n`);
    },
    comment(text) {
      return write(`:${text}\n\n`);
    },
    bye(reason) {
      write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
    },
    close() {
      dead = true;
      try {
        void writer.close().catch(() => {});
      } catch {
        // Already closed or errored — nothing to release.
      }
    },
  };
  return sink;
}

/** Sink for a one-shot HTTP-delivered frame: the reply is captured, not streamed. */
export function createSseCaptureSink(): SseConnectionSink & { frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    send(payload) {
      frames.push(payload);
      return true;
    },
    comment() {
      return true;
    },
    bye() {},
    close() {},
  };
}

export interface SseConnectionOptions {
  id: string;
  /** Absolute attach URL, or null. Parsed by the SDK's sub-agent routing on every frame. */
  uri: string | null;
  server: string;
  sink: SseConnectionSink;
  onTeardown: (connection: SseConnection, code: number, reason: string) => void;
}

export class SseConnection {
  readonly id: string;
  uri: string | null;
  tags: string[];
  server: string;
  binaryType = "arraybuffer";
  // Installed as own properties in the constructor (see the header note).
  declare state: unknown;
  declare setState: (next: unknown) => unknown;

  private rawState: unknown = null;
  private readonly sink: SseConnectionSink;
  private readonly onTeardown: SseConnectionOptions["onTeardown"];
  private done = false;

  constructor(options: SseConnectionOptions) {
    this.id = options.id;
    this.uri = options.uri;
    this.tags = [options.id];
    this.server = options.server;
    this.sink = options.sink;
    this.onTeardown = options.onTeardown;
    this.sink.onDead = () => this.abort(1006, "stream_write_failed");

    Object.defineProperty(this, "state", {
      configurable: true,
      enumerable: true,
      get: () => this.rawState,
    });
    Object.defineProperty(this, "setState", {
      configurable: true,
      writable: true,
      value: (next: unknown): unknown => {
        this.rawState =
          typeof next === "function"
            ? (next as (previous: unknown) => unknown)(this.rawState)
            : next;
        return this.rawState;
      },
    });
  }

  get readyState(): number {
    return this.done ? 3 : 1;
  }

  get isOpen(): boolean {
    return !this.done;
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.done) return;
    // Nothing in the chat protocol sends binary frames; there is no SSE
    // encoding for them, so drop rather than corrupt the stream.
    if (typeof message !== "string") return;
    if (!this.sink.send(message)) this.finish(1006, "stream_write_failed");
  }

  /** Comment keepalive. Returns false once the stream is gone. */
  heartbeat(): boolean {
    if (this.done) return false;
    if (this.sink.comment("hb")) return true;
    this.finish(1006, "heartbeat_write_failed");
    return false;
  }

  close(code = 1000, reason = ""): void {
    this.closeWithBye(sseByeReasonForCloseCode(code), code, reason);
  }

  closeWithBye(bye: SseByeReason, code = 1000, reason: string = bye): void {
    if (this.done) return;
    this.sink.bye(bye);
    this.finish(code, reason);
  }

  /** Stream ended without a `bye` (client abort, writer error, eviction). */
  abort(code = 1006, reason = "stream_closed"): void {
    if (this.done) return;
    this.finish(code, reason);
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  serializeAttachment(value: unknown): void {
    const current = this.rawState;
    const flags: Record<string, unknown> = {};
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        if (key.startsWith(CF_INTERNAL_KEY_PREFIX)) flags[key] = entry;
      }
    }
    if (value && typeof value === "object") {
      this.rawState = { ...(value as Record<string, unknown>), ...flags };
      return;
    }
    this.rawState = Object.keys(flags).length > 0 ? flags : value;
  }

  deserializeAttachment(): unknown {
    return this.rawState;
  }

  private finish(code: number, reason: string): void {
    this.done = true;
    this.sink.close();
    this.onTeardown(this, code, reason);
  }
}

/**
 * One-shot connection for an HTTP-delivered frame whose reply must come back in
 * the POST body. Shares the SSE stream's connection id so a callable that reads
 * `getCurrentAgent().connection.id` sees the same client.
 */
export function createSseCaptureConnection(options: {
  id: string;
  uri: string | null;
  server: string;
}): { connection: SseConnection; frames: string[] } {
  const sink = createSseCaptureSink();
  const connection = new SseConnection({
    id: options.id,
    uri: options.uri,
    server: options.server,
    sink,
    onTeardown: () => {},
  });
  return { connection, frames: sink.frames };
}
