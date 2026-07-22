/**
 * Chat WebSocket close-code helpers shared by the Worker upgrade path and the
 * browser telemetry/lifecycle handlers.
 *
 * Application close codes in the 4400–4499 range are treated as terminal by
 * the Agents SDK (`isTerminalCloseEvent`: 1008 or 4000–4999), so the client
 * stops infinite reconnect loops on hard auth failures.
 */

export const CHAT_WS_CLOSE_UNAUTHORIZED = 4401;
export const CHAT_WS_CLOSE_FORBIDDEN = 4403;
export const CHAT_WS_CLOSE_NOT_FOUND = 4404;
export const CHAT_WS_CLOSE_BAD_REQUEST = 4400;
/** Non-terminal: client should retry (try again later). */
export const CHAT_WS_CLOSE_TRY_AGAIN = 1013;

const MAX_CLOSE_REASON_BYTES = 123;

export function truncateWebSocketCloseReason(reason: string): string {
  const trimmed = reason.trim() || "closed";
  const encoder = new TextEncoder();
  if (encoder.encode(trimmed).byteLength <= MAX_CLOSE_REASON_BYTES) return trimmed;
  // Walk code points until we fit in the WebSocket 123-byte reason limit.
  let out = "";
  for (const char of trimmed) {
    const next = out + char;
    if (encoder.encode(next).byteLength > MAX_CLOSE_REASON_BYTES) break;
    out = next;
  }
  return out || "closed";
}

export function chatWebSocketCloseCodeForHttpStatus(status: number): number {
  if (status === 401) return CHAT_WS_CLOSE_UNAUTHORIZED;
  if (status === 404) return CHAT_WS_CLOSE_NOT_FOUND;
  if (status === 400) return CHAT_WS_CLOSE_BAD_REQUEST;
  // Any 5xx / rate-limit is "try again", never a terminal access denial.
  if (status >= 500 || status === 429) {
    return CHAT_WS_CLOSE_TRY_AGAIN;
  }
  return CHAT_WS_CLOSE_FORBIDDEN;
}

export function isTerminalChatWebSocketCloseCode(code: number | null | undefined): boolean {
  if (typeof code !== "number" || !Number.isFinite(code)) return false;
  return code === 1008 || (code >= 4000 && code <= 4999);
}

export function terminalChatWebSocketUserMessage(code: number | null | undefined, reason?: string): string {
  const normalizedReason = (reason || "").toLowerCase();
  if (code === CHAT_WS_CLOSE_UNAUTHORIZED || normalizedReason.includes("unauthorized")) {
    return "Your session expired or is no longer valid. Refresh the page and sign in again.";
  }
  if (code === CHAT_WS_CLOSE_NOT_FOUND || normalizedReason.includes("not found")) {
    return "This chat is no longer available.";
  }
  if (code === CHAT_WS_CLOSE_BAD_REQUEST) {
    return "Chat could not connect (missing workspace). Pick a workspace and try again.";
  }
  if (code === CHAT_WS_CLOSE_FORBIDDEN || code === 1008) {
    return "You no longer have access to this chat.";
  }
  return "Chat disconnected and will not reconnect automatically. Refresh the page.";
}

/**
 * PartySocket 1.3.x clones synthetic CloseEvents with the wrong constructor
 * signature, so handlers often see `code: "close"` (string) and the real
 * `{ code, reason, wasClean }` nested in `event.reason`. Normalize before
 * telemetry or terminal-close UX.
 */
export function normalizeWebSocketCloseEvent(event?: CloseEvent | Event | null): {
  code: number | null;
  reason: string | undefined;
  wasClean: boolean | undefined;
} {
  if (!event) {
    return { code: null, reason: undefined, wasClean: undefined };
  }

  const record = event as CloseEvent & {
    code?: unknown;
    reason?: unknown;
    wasClean?: unknown;
  };

  let code = typeof record.code === "number" ? record.code : null;
  let reason = typeof record.reason === "string" ? record.reason : undefined;
  let wasClean = typeof record.wasClean === "boolean" ? record.wasClean : undefined;

  const nested =
    record.reason && typeof record.reason === "object"
      ? (record.reason as {
          code?: unknown;
          reason?: unknown;
          wasClean?: unknown;
        })
      : null;

  if (nested) {
    if (code === null && typeof nested.code === "number") {
      code = nested.code;
    }
    if (reason === undefined && typeof nested.reason === "string") {
      reason = nested.reason;
    }
    if (wasClean === undefined && typeof nested.wasClean === "boolean") {
      wasClean = nested.wasClean;
    }
  }

  return { code, reason: reason || undefined, wasClean };
}

/**
 * Accept a WebSocket upgrade and immediately close with an application code.
 * Used when chat auth fails so the browser gets a real close frame (and can
 * stop reconnecting on terminal codes) instead of a plain HTTP error body.
 */
export function rejectedChatWebSocketUpgrade(args: {
  httpStatus: number;
  reason: string;
}): Response {
  const code = chatWebSocketCloseCodeForHttpStatus(args.httpStatus);
  const reason = truncateWebSocketCloseReason(args.reason);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  try {
    server.close(code, reason);
  } catch {
    // Close can throw if the peer already went away; the 101 still completes.
  }
  return new Response(null, { status: 101, webSocket: client });
}
