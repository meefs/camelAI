import { describe, expect, it } from "vitest";

import {
  CHAT_WS_CLOSE_FORBIDDEN,
  CHAT_WS_CLOSE_NOT_FOUND,
  CHAT_WS_CLOSE_TRY_AGAIN,
  CHAT_WS_CLOSE_UNAUTHORIZED,
  chatWebSocketCloseCodeForHttpStatus,
  truncateWebSocketCloseReason,
} from "@/lib/chat-ws-close";

// The browser transport is SSE now (see chat-sse-close.test.ts); what remains
// here is the Worker's legacy WS upgrade-rejection path, kept for one release
// for stale bundles still holding a socket.
describe("chat-ws-close upgrade-rejection helpers", () => {
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
  });

  it("truncates close reasons to the WebSocket byte budget", () => {
    const long = "x".repeat(200);
    expect(truncateWebSocketCloseReason(long).length).toBeLessThanOrEqual(123);
  });
});
