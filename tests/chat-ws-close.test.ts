import { describe, expect, it } from "vitest";

import {
  CHAT_WS_CLOSE_FORBIDDEN,
  CHAT_WS_CLOSE_NOT_FOUND,
  CHAT_WS_CLOSE_TRY_AGAIN,
  CHAT_WS_CLOSE_UNAUTHORIZED,
  chatWebSocketCloseCodeForHttpStatus,
  isTerminalChatWebSocketCloseCode,
  normalizeWebSocketCloseEvent,
  terminalChatWebSocketUserMessage,
  truncateWebSocketCloseReason,
} from "@/lib/chat-ws-close";

describe("chat-ws-close helpers", () => {
  it("maps HTTP auth failures to terminal application close codes", () => {
    expect(chatWebSocketCloseCodeForHttpStatus(401)).toBe(
      CHAT_WS_CLOSE_UNAUTHORIZED,
    );
    expect(chatWebSocketCloseCodeForHttpStatus(403)).toBe(
      CHAT_WS_CLOSE_FORBIDDEN,
    );
    expect(chatWebSocketCloseCodeForHttpStatus(404)).toBe(
      CHAT_WS_CLOSE_NOT_FOUND,
    );
    expect(chatWebSocketCloseCodeForHttpStatus(503)).toBe(
      CHAT_WS_CLOSE_TRY_AGAIN,
    );
    expect(chatWebSocketCloseCodeForHttpStatus(500)).toBe(
      CHAT_WS_CLOSE_TRY_AGAIN,
    );
    expect(chatWebSocketCloseCodeForHttpStatus(429)).toBe(
      CHAT_WS_CLOSE_TRY_AGAIN,
    );
    expect(isTerminalChatWebSocketCloseCode(CHAT_WS_CLOSE_UNAUTHORIZED)).toBe(
      true,
    );
    expect(isTerminalChatWebSocketCloseCode(CHAT_WS_CLOSE_TRY_AGAIN)).toBe(
      false,
    );
  });

  it("unwraps PartySocket nested synthetic CloseEvent payloads", () => {
    const nested = {
      code: 1000,
      reason: "timeout",
      wasClean: true,
    };
    const mangled = {
      code: "close",
      reason: nested,
      wasClean: undefined,
    } as unknown as CloseEvent;

    expect(normalizeWebSocketCloseEvent(mangled)).toEqual({
      code: 1000,
      reason: "timeout",
      wasClean: true,
    });
  });

  it("truncates close reasons to the WebSocket byte budget", () => {
    const long = "x".repeat(200);
    expect(truncateWebSocketCloseReason(long).length).toBeLessThanOrEqual(123);
  });

  it("returns actionable terminal UX copy", () => {
    expect(
      terminalChatWebSocketUserMessage(CHAT_WS_CLOSE_UNAUTHORIZED, "Unauthorized"),
    ).toMatch(/session/i);
    expect(
      terminalChatWebSocketUserMessage(CHAT_WS_CLOSE_NOT_FOUND, "Thread not found"),
    ).toMatch(/no longer available/i);
  });
});
