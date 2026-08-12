import { describe, expect, it } from "vitest";

import {
  CHAT_SSE_CLOSE_BAD_REQUEST,
  CHAT_SSE_CLOSE_FORBIDDEN,
  CHAT_SSE_CLOSE_IDLE,
  CHAT_SSE_CLOSE_NOT_FOUND,
  CHAT_SSE_CLOSE_SHUTDOWN,
  CHAT_SSE_CLOSE_TRY_AGAIN,
  CHAT_SSE_CLOSE_UNAUTHORIZED,
  chatSseCloseCodeForByeReason,
  chatSseCloseCodeForHttpStatus,
  isChatSseByeReason,
  isIntentionalCleanChatSseTeardown,
  isRetryableChatSseHttpStatus,
  isTerminalChatSseByeReason,
  isTerminalChatSseCloseCode,
  isTerminalChatSseHttpStatus,
  parseChatSseByeReason,
  terminalChatSseUserMessage,
} from "@/lib/chat-sse-close";

describe("chat-sse-close helpers", () => {
  it("classifies attach statuses as terminal or retryable", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isTerminalChatSseHttpStatus(status)).toBe(true);
      expect(isRetryableChatSseHttpStatus(status)).toBe(false);
    }
    for (const status of [409, 429, 500, 503]) {
      expect(isRetryableChatSseHttpStatus(status)).toBe(true);
      expect(isTerminalChatSseHttpStatus(status)).toBe(false);
    }
    expect(isTerminalChatSseHttpStatus(200)).toBe(false);
  });

  it("maps HTTP statuses to the close-code vocabulary the SDK treats as terminal", () => {
    expect(chatSseCloseCodeForHttpStatus(401)).toBe(CHAT_SSE_CLOSE_UNAUTHORIZED);
    expect(chatSseCloseCodeForHttpStatus(403)).toBe(CHAT_SSE_CLOSE_FORBIDDEN);
    expect(chatSseCloseCodeForHttpStatus(404)).toBe(CHAT_SSE_CLOSE_NOT_FOUND);
    expect(chatSseCloseCodeForHttpStatus(400)).toBe(CHAT_SSE_CLOSE_BAD_REQUEST);
    expect(chatSseCloseCodeForHttpStatus(503)).toBe(CHAT_SSE_CLOSE_TRY_AGAIN);
    expect(chatSseCloseCodeForHttpStatus(429)).toBe(CHAT_SSE_CLOSE_TRY_AGAIN);
    expect(isTerminalChatSseCloseCode(CHAT_SSE_CLOSE_UNAUTHORIZED)).toBe(true);
    expect(isTerminalChatSseCloseCode(CHAT_SSE_CLOSE_TRY_AGAIN)).toBe(false);
    expect(isTerminalChatSseCloseCode(null)).toBe(false);
  });

  it("maps bye reasons to codes and terminality", () => {
    expect(chatSseCloseCodeForByeReason("forbidden")).toBe(CHAT_SSE_CLOSE_FORBIDDEN);
    expect(chatSseCloseCodeForByeReason("retry")).toBe(CHAT_SSE_CLOSE_TRY_AGAIN);
    expect(chatSseCloseCodeForByeReason("idle")).toBe(CHAT_SSE_CLOSE_IDLE);
    expect(chatSseCloseCodeForByeReason("shutdown")).toBe(CHAT_SSE_CLOSE_SHUTDOWN);
    expect(chatSseCloseCodeForByeReason(null)).toBe(CHAT_SSE_CLOSE_TRY_AGAIN);
    expect(isTerminalChatSseByeReason("forbidden")).toBe(true);
    for (const reason of ["idle", "retry", "shutdown", null] as const) {
      expect(isTerminalChatSseByeReason(reason)).toBe(false);
    }
  });

  it("parses bye payloads and rejects unknown reasons", () => {
    expect(parseChatSseByeReason('{"reason":"idle"}')).toBe("idle");
    expect(parseChatSseByeReason('{"reason":"forbidden","detail":"x"}')).toBe(
      "forbidden",
    );
    expect(parseChatSseByeReason("shutdown")).toBe("shutdown");
    expect(parseChatSseByeReason('{"reason":"whatever"}')).toBeNull();
    expect(parseChatSseByeReason("")).toBeNull();
    expect(isChatSseByeReason("retry")).toBe(true);
    expect(isChatSseByeReason("nope")).toBe(false);
  });

  it("requires an opened stream and a client-side abort to call teardown intentional", () => {
    expect(
      isIntentionalCleanChatSseTeardown({ aborted: true, connectionWasOpen: false }),
    ).toBe(false);
    expect(
      isIntentionalCleanChatSseTeardown({ aborted: true, connectionWasOpen: true }),
    ).toBe(true);
    expect(
      isIntentionalCleanChatSseTeardown({
        aborted: undefined,
        connectionWasOpen: true,
      }),
    ).toBe(false);
  });

  it("returns actionable terminal UX copy", () => {
    expect(
      terminalChatSseUserMessage(CHAT_SSE_CLOSE_UNAUTHORIZED, "Unauthorized"),
    ).toMatch(/session/i);
    expect(
      terminalChatSseUserMessage(CHAT_SSE_CLOSE_NOT_FOUND, "Thread not found"),
    ).toMatch(/no longer available/i);
    expect(terminalChatSseUserMessage(CHAT_SSE_CLOSE_BAD_REQUEST)).toMatch(
      /workspace/i,
    );
    expect(terminalChatSseUserMessage(CHAT_SSE_CLOSE_FORBIDDEN)).toMatch(
      /no longer have access/i,
    );
    expect(terminalChatSseUserMessage(null)).toMatch(/will not reconnect/i);
  });
});
