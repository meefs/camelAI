/**
 * Chat SSE terminality helpers shared by the browser transport and its
 * telemetry/lifecycle handlers (supersedes chat-ws-close.ts).
 *
 * HTTP replaces WebSocket close codes as the denial channel: the attach
 * response status carries the verdict before the stream opens, and a mid-stream
 * revocation arrives as `event: bye` + `{"reason":...}`. Both are normalized
 * into the 44xx close-code vocabulary the Agents SDK already treats as terminal
 * (`code === 1008 || 4000 <= code <= 4999`) so the connectionError payload and
 * the user-facing copy stay unchanged across the transport swap.
 */

export type ChatSseByeReason = "idle" | "retry" | "forbidden" | "shutdown";

export const CHAT_SSE_CLOSE_UNAUTHORIZED = 4401;
export const CHAT_SSE_CLOSE_FORBIDDEN = 4403;
export const CHAT_SSE_CLOSE_NOT_FOUND = 4404;
export const CHAT_SSE_CLOSE_BAD_REQUEST = 4400;
/** Non-terminal: client should retry (try again later). */
export const CHAT_SSE_CLOSE_TRY_AGAIN = 1013;
/** Non-terminal: the server parked the stream on purpose (idle grace). */
export const CHAT_SSE_CLOSE_IDLE = 1000;
/** Non-terminal: the server is going away (redeploy); reconnect. */
export const CHAT_SSE_CLOSE_SHUTDOWN = 1001;

const BYE_REASONS: readonly ChatSseByeReason[] = [
  "idle",
  "retry",
  "forbidden",
  "shutdown",
];

export function isChatSseByeReason(value: unknown): value is ChatSseByeReason {
  return (
    typeof value === "string" &&
    (BYE_REASONS as readonly string[]).includes(value)
  );
}

/** Parse a `bye` event payload. Unknown/malformed payloads mean "reconnect". */
export function parseChatSseByeReason(data: string): ChatSseByeReason | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const reason =
      parsed && typeof parsed === "object"
        ? (parsed as { reason?: unknown }).reason
        : parsed;
    return isChatSseByeReason(reason) ? reason : null;
  } catch {
    return isChatSseByeReason(trimmed) ? trimmed : null;
  }
}

/** Attach/POST statuses the client must retry rather than give up on. */
export function isRetryableChatSseHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Terminal = the client must stop reconnecting and surface the failure. 400 /
 * 401 / 403 / 404 are the auth verdicts; any other unclassified 4xx is treated
 * as terminal too, because retrying a hard client error is a doom loop.
 */
export function isTerminalChatSseHttpStatus(status: number): boolean {
  if (status < 400) return false;
  return !isRetryableChatSseHttpStatus(status);
}

export function chatSseCloseCodeForHttpStatus(status: number): number {
  // A 2xx/3xx that still failed the handshake (an intercepting proxy answering
  // the attach with an HTML page) is a network condition, never a verdict.
  if (status < 400) return CHAT_SSE_CLOSE_TRY_AGAIN;
  if (status === 401) return CHAT_SSE_CLOSE_UNAUTHORIZED;
  if (status === 404) return CHAT_SSE_CLOSE_NOT_FOUND;
  if (status === 400) return CHAT_SSE_CLOSE_BAD_REQUEST;
  if (isRetryableChatSseHttpStatus(status)) return CHAT_SSE_CLOSE_TRY_AGAIN;
  return CHAT_SSE_CLOSE_FORBIDDEN;
}

export function chatSseCloseCodeForByeReason(
  reason: ChatSseByeReason | null | undefined,
): number {
  if (reason === "forbidden") return CHAT_SSE_CLOSE_FORBIDDEN;
  if (reason === "retry") return CHAT_SSE_CLOSE_TRY_AGAIN;
  if (reason === "shutdown") return CHAT_SSE_CLOSE_SHUTDOWN;
  if (reason === "idle") return CHAT_SSE_CLOSE_IDLE;
  return CHAT_SSE_CLOSE_TRY_AGAIN;
}

export function isTerminalChatSseByeReason(
  reason: ChatSseByeReason | null | undefined,
): boolean {
  return reason === "forbidden";
}

/**
 * A `bye` with a non-terminal reason is the server ending the stream on purpose
 * (idle park, "try again", redeploy). It is not a transport failure: the stream
 * ended the way the protocol says it may, so it must not be reported as an
 * abnormal disconnect nor feed reconnect-loop detection.
 */
export function isGracefulServerChatSseBye(
  reason: ChatSseByeReason | null | undefined,
): boolean {
  return reason != null && !isTerminalChatSseByeReason(reason);
}

export function isTerminalChatSseCloseCode(
  code: number | null | undefined,
): boolean {
  if (typeof code !== "number" || !Number.isFinite(code)) return false;
  return code === 1008 || (code >= 4000 && code <= 4999);
}

/**
 * SSE has no clean-close frame: the only "intentional" end of stream is one the
 * client caused itself (unmount, thread switch, navigation). Keeping that
 * distinction is what stops navigation teardown from being reported as a
 * reconnect loop.
 */
export function isIntentionalCleanChatSseTeardown(input: {
  aborted: boolean | undefined;
  connectionWasOpen: boolean;
}): boolean {
  return input.connectionWasOpen && input.aborted === true;
}

export function terminalChatSseUserMessage(
  code: number | null | undefined,
  reason?: string,
): string {
  const normalizedReason = (reason || "").toLowerCase();
  if (
    code === CHAT_SSE_CLOSE_UNAUTHORIZED ||
    normalizedReason.includes("unauthorized")
  ) {
    return "Your session expired or is no longer valid. Refresh the page and sign in again.";
  }
  if (
    code === CHAT_SSE_CLOSE_NOT_FOUND ||
    normalizedReason.includes("not found")
  ) {
    return "This chat is no longer available.";
  }
  if (code === CHAT_SSE_CLOSE_BAD_REQUEST) {
    return "Chat could not connect (missing workspace). Pick a workspace and try again.";
  }
  if (code === CHAT_SSE_CLOSE_FORBIDDEN || code === 1008) {
    return "You no longer have access to this chat.";
  }
  return "Chat disconnected and will not reconnect automatically. Refresh the page.";
}
