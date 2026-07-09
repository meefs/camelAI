import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FLAP_CLOSE_THRESHOLD,
  FLAP_WINDOW_MS,
  SEND_ACK_TIMEOUT_MS,
  shouldReportFlap,
  trackChatSendDispatched,
  trackChatSocketClose,
  trackChatSocketOpen,
} from "@/lib/chat-ws-telemetry";

// The telemetry module reports through navigator.sendBeacon (with a fetch
// fallback); install a beacon capture to assert on emitted events. jsdom does
// not implement sendBeacon, so define rather than spy.
function captureBeacons(): { events: () => Array<Record<string, unknown>> } {
  const payloads: Array<Record<string, unknown>> = [];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: (_url: string, body: Blob) => {
      // jsdom's Blob has no .text(); FileReader is implemented.
      const reader = new FileReader();
      reader.onload = () => {
        payloads.push(JSON.parse(String(reader.result)) as Record<string, unknown>);
      };
      reader.readAsText(body);
      return true;
    },
  });
  return {
    events: () => payloads,
  };
}

async function flushBeacons(): Promise<void> {
  // FileReader's load event may be scheduled on the fake clock; run it before
  // dropping back to real timers, then yield a real macrotask.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("shouldReportFlap", () => {
  const closes = (count: number, now: number) =>
    Array.from({ length: count }, (_, index) => ({
      at: now - index * 1000,
      code: 1006,
    }));

  it("stays quiet below the close threshold", () => {
    const now = 1_000_000;
    expect(
      shouldReportFlap(closes(FLAP_CLOSE_THRESHOLD - 1, now), 0, now),
    ).toBe(false);
  });

  it("reports once the threshold is crossed", () => {
    const now = 1_000_000;
    expect(shouldReportFlap(closes(FLAP_CLOSE_THRESHOLD, now), 0, now)).toBe(
      true,
    );
  });

  it("suppresses repeat reports inside one window", () => {
    const now = 1_000_000;
    expect(
      shouldReportFlap(
        closes(FLAP_CLOSE_THRESHOLD + 2, now),
        now - FLAP_WINDOW_MS / 2,
        now,
      ),
    ).toBe(false);
    expect(
      shouldReportFlap(
        closes(FLAP_CLOSE_THRESHOLD + 2, now),
        now - FLAP_WINDOW_MS,
        now,
      ),
    ).toBe(true);
  });
});

describe("chat websocket telemetry events", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports socket close with code, status, and lifetime", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatSocketOpen(threadId);
    trackChatSocketClose(threadId, {
      code: 1006,
      reason: "",
      wasClean: false,
    } as CloseEvent);
    await flushBeacons();

    const close = beacons
      .events()
      .find((event) => event.event === "chat_ws_close");
    expect(close).toBeDefined();
    expect(close?.status).toBe("1006");
    expect(close?.statusCode).toBe(1006);
    expect(close?.severity).toBe("warn");
    expect(close?.threadId).toBe(threadId);
    expect(String(close?.details)).toContain('"wasClean":false');
  });

  it("escalates to a flapping report after repeated close cycles", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    for (let cycle = 0; cycle < FLAP_CLOSE_THRESHOLD; cycle += 1) {
      trackChatSocketOpen(threadId);
      trackChatSocketClose(threadId, {
        code: 1006,
        reason: "",
        wasClean: false,
      } as CloseEvent);
    }
    await flushBeacons();

    const flap = beacons
      .events()
      .find((event) => event.event === "chat_ws_flapping");
    expect(flap).toBeDefined();
    expect(flap?.severity).toBe("error");
    expect(flap?.count).toBe(FLAP_CLOSE_THRESHOLD);
  });

  it("reports an ack timeout when sendMessage never settles", async () => {
    vi.useFakeTimers();
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatSendDispatched({
      threadId,
      getReadyState: () => WebSocket.OPEN,
    });
    vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 1);
    await flushBeacons();

    const timeout = beacons
      .events()
      .find((event) => event.event === "chat_ws_send_ack_timeout");
    expect(timeout).toBeDefined();
    expect(timeout?.severity).toBe("error");
    expect(timeout?.threadId).toBe(threadId);
  });

  it("suppresses the ack timeout once the send settles", async () => {
    vi.useFakeTimers();
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    const tracker = trackChatSendDispatched({
      threadId,
      getReadyState: () => WebSocket.OPEN,
    });
    tracker.accepted();
    vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 1);
    await flushBeacons();

    const events = beacons.events();
    expect(
      events.find((event) => event.event === "chat_ws_send_ack_timeout"),
    ).toBeUndefined();
    const accepted = events.find(
      (event) => event.event === "chat_ws_send_accepted",
    );
    expect(accepted).toBeDefined();
    expect(accepted?.status).toBe("accepted");
  });
});
