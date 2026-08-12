/**
 * Chat WebSocket close-code helpers for the Worker upgrade path.
 *
 * The browser no longer speaks WebSocket (see chat-sse-close.ts), but the
 * upgrade route stays server-side for one release so stale bundles already
 * holding a socket keep getting real close frames instead of an HTTP body.
 * Application close codes in the 4400–4499 range are treated as terminal by the
 * Agents SDK (`isTerminalCloseEvent`: 1008 or 4000–4999), so those old clients
 * stop reconnect-looping on hard auth failures.
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
