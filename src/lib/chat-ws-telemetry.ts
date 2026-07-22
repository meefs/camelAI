import { reportClientEvent } from "./client-error-reporting";
import { normalizeWebSocketCloseEvent } from "./chat-ws-close";

/**
 * Client-side chat WebSocket + send-path telemetry.
 *
 * Every event funnels through reportClientEvent (source "chat_websocket" /
 * "chat_runner") into /api/client-errors → OBSERVABILITY_EVENTS, so a user
 * whose socket is flapping, half-open (send works, receive dead), or never
 * reconnecting leaves a server-side trace without us asking for a HAR.
 *
 * Reporting budgets live in client-error-reporting (40 events/page, 5 per
 * signature). Event `message` strings must stay CONSTANT per event type
 * (variable data rides `details`/`durationMs`/`count`/`status`) so the
 * signature dedupe caps a reconnect loop instead of letting it drain the
 * page budget.
 */

export const SEND_ACK_TIMEOUT_MS = 15_000;
export const FLAP_WINDOW_MS = 60_000;
export const FLAP_CLOSE_THRESHOLD = 4;

interface RecentClose {
  at: number;
  code: number | null;
}

interface ThreadSocketStats {
  opens: number;
  closes: number;
  errors: number;
  lastOpenAt: number | null;
  lastCloseAt: number | null;
  everOpened: boolean;
  recentCloses: RecentClose[];
  lastFlapReportAt: number;
}

const statsByThread = new Map<string, ThreadSocketStats>();

function statsFor(threadId: string): ThreadSocketStats {
  let stats = statsByThread.get(threadId);
  if (!stats) {
    stats = {
      opens: 0,
      closes: 0,
      errors: 0,
      lastOpenAt: null,
      lastCloseAt: null,
      everOpened: false,
      recentCloses: [],
      lastFlapReportAt: 0,
    };
    statsByThread.set(threadId, stats);
  }
  return stats;
}

/** Network/tab context attached to lifecycle events so a dead-network close
 * is distinguishable from a background-tab throttle or a server-side kill. */
function connectionContext(): Record<string, unknown> {
  return {
    online: typeof navigator !== "undefined" ? navigator.onLine : null,
    visibility:
      typeof document !== "undefined" ? document.visibilityState : null,
  };
}

function lifecycleCounts(stats: ThreadSocketStats): Record<string, unknown> {
  return {
    opens: stats.opens,
    closes: stats.closes,
    errors: stats.errors,
    everOpened: stats.everOpened,
  };
}

/** Pure core of flap detection: whether `recentCloses` (pruned to the flap
 * window by the caller) crosses the reporting threshold at `now`, honoring
 * one report per window. */
export function shouldReportFlap(
  recentCloses: readonly RecentClose[],
  lastFlapReportAt: number,
  now: number,
): boolean {
  if (recentCloses.length < FLAP_CLOSE_THRESHOLD) return false;
  return now - lastFlapReportAt >= FLAP_WINDOW_MS;
}

export function trackChatSocketOpen(threadId: string): void {
  const stats = statsFor(threadId);
  const now = Date.now();
  stats.opens += 1;
  const reconnect = stats.everOpened;
  stats.everOpened = true;
  const msSinceLastClose =
    stats.lastCloseAt !== null ? now - stats.lastCloseAt : undefined;
  stats.lastOpenAt = now;
  reportClientEvent({
    source: "chat_websocket",
    event: "chat_ws_open",
    severity: "info",
    status: reconnect ? "reconnect" : "connect",
    message: "Chat websocket opened.",
    threadId,
    durationMs: msSinceLastClose,
    count: stats.opens,
    details: { ...connectionContext(), ...lifecycleCounts(stats) },
  });
}

export function trackChatSocketClose(
  threadId: string,
  event?: CloseEvent,
): void {
  const stats = statsFor(threadId);
  const now = Date.now();
  stats.closes += 1;
  const normalized = normalizeWebSocketCloseEvent(event);
  const code = normalized.code;
  const socketLifeMs =
    stats.lastOpenAt !== null ? now - stats.lastOpenAt : undefined;
  stats.lastCloseAt = now;
  stats.recentCloses.push({ at: now, code });
  stats.recentCloses = stats.recentCloses.filter(
    (close) => now - close.at <= FLAP_WINDOW_MS,
  );
  reportClientEvent({
    source: "chat_websocket",
    event: "chat_ws_close",
    severity: "warn",
    status: code !== null ? String(code) : "unknown",
    statusCode: code ?? undefined,
    // The close code is deliberately part of the message: distinct codes get
    // their own per-signature reporting budget.
    message: `Chat websocket closed (code ${code ?? "unknown"}).`,
    threadId,
    durationMs: socketLifeMs,
    count: stats.closes,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      code,
      reason: normalized.reason,
      wasClean: normalized.wasClean,
      socketLifeMs,
      // Preserve raw fields when PartySocket nested the real close payload.
      rawCode: typeof event?.code === "number" ? event.code : String(event?.code ?? ""),
    },
  });

  if (shouldReportFlap(stats.recentCloses, stats.lastFlapReportAt, now)) {
    stats.lastFlapReportAt = now;
    const lifetimes = stats.recentCloses
      .map((close, index) =>
        index === 0 ? null : close.at - stats.recentCloses[index - 1].at,
      )
      .filter((value): value is number => value !== null);
    const avgCycleMs = lifetimes.length
      ? Math.round(lifetimes.reduce((sum, value) => sum + value, 0) / lifetimes.length)
      : undefined;
    reportClientEvent({
      source: "chat_websocket",
      event: "chat_ws_flapping",
      severity: "error",
      status: "flapping",
      message: "Chat websocket is flapping (repeated open/close cycles).",
      threadId,
      durationMs: avgCycleMs,
      count: stats.recentCloses.length,
      details: {
        ...connectionContext(),
        ...lifecycleCounts(stats),
        windowMs: FLAP_WINDOW_MS,
        closeCodes: stats.recentCloses.map((close) => close.code),
      },
    });
  }
}

export function trackChatSocketError(threadId: string): void {
  const stats = statsFor(threadId);
  stats.errors += 1;
  reportClientEvent({
    source: "chat_websocket",
    event: "chat_ws_error",
    severity: "warn",
    status: "error",
    message: "Browser reported a websocket error event.",
    threadId,
    count: stats.errors,
    details: { ...connectionContext(), ...lifecycleCounts(stats) },
  });
}

/** The agents client hit a terminal close and will NOT reconnect — from the
 * user's perspective the thread is dead until a manual refresh. */
export function trackChatSocketTerminalClose(
  threadId: string,
  error: { code?: number; reason?: string; wasClean?: boolean },
): void {
  const stats = statsFor(threadId);
  const normalized = normalizeWebSocketCloseEvent({
    code: error.code,
    reason: error.reason,
    wasClean: error.wasClean,
  } as CloseEvent);
  const code = normalized.code ?? (typeof error.code === "number" ? error.code : null);
  const reason = normalized.reason ?? error.reason;
  reportClientEvent({
    source: "chat_websocket",
    event: "chat_ws_terminal_close",
    severity: "error",
    status: code !== null ? String(code) : "terminal",
    statusCode: code ?? undefined,
    message: "Chat websocket closed terminally; client will not reconnect.",
    threadId,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      code,
      reason: reason || undefined,
      wasClean: normalized.wasClean ?? error.wasClean,
    },
  });
}

/** A reconnect flushed user messages that were composed while disconnected. */
export function trackChatReconnectFlush(threadId: string, count: number): void {
  const stats = statsFor(threadId);
  reportClientEvent({
    source: "chat_websocket",
    event: "chat_ws_reconnect_flush",
    severity: "info",
    status: "flush",
    message: "Re-sent queued user messages after reconnect.",
    threadId,
    count,
    details: { ...connectionContext(), ...lifecycleCounts(stats) },
  });
}

/** A user hit send while the socket was not open+ready; the message was
 * queued for the reconnect flush instead of dispatched. */
export function trackChatSendQueuedOffline(
  threadId: string,
  info: { readyState: number | null; ready: boolean },
): void {
  const stats = statsFor(threadId);
  reportClientEvent({
    source: "chat_websocket",
    event: "chat_ws_send_queued_offline",
    severity: "warn",
    status: "queued",
    message: "User message queued: socket not open at send time.",
    threadId,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      readyState: info.readyState,
      ready: info.ready,
    },
  });
}

export interface ChatSendTracker {
  accepted(): void;
  rejected(status: string): void;
  failed(error: unknown): void;
}

/**
 * Track one sendMessage RPC. The ack-timeout report is the half-open-socket
 * detector: the frame went out on an OPEN socket but no ack came back within
 * SEND_ACK_TIMEOUT_MS — on a healthy connection the ack is sub-second. Pure
 * telemetry; the call's own 30s client timeout still owns the user-facing
 * failure.
 */
export function trackChatSendDispatched(opts: {
  threadId: string;
  getReadyState: () => number | null;
}): ChatSendTracker {
  const { threadId, getReadyState } = opts;
  const dispatchedAt = Date.now();
  let settled = false;
  const ackTimer = setTimeout(() => {
    if (settled) return;
    const stats = statsFor(threadId);
    reportClientEvent({
      source: "chat_websocket",
      event: "chat_ws_send_ack_timeout",
      severity: "error",
      status: "ack_timeout",
      message: "sendMessage got no ack within the timeout on an open socket.",
      threadId,
      durationMs: Date.now() - dispatchedAt,
      details: {
        ...connectionContext(),
        ...lifecycleCounts(stats),
        readyState: getReadyState(),
        timeoutMs: SEND_ACK_TIMEOUT_MS,
      },
    });
  }, SEND_ACK_TIMEOUT_MS);

  const settle = () => {
    settled = true;
    clearTimeout(ackTimer);
  };

  return {
    accepted() {
      if (settled) return;
      settle();
      reportClientEvent({
        source: "chat_websocket",
        event: "chat_ws_send_accepted",
        severity: "info",
        status: "accepted",
        message: "sendMessage acknowledged.",
        threadId,
        durationMs: Date.now() - dispatchedAt,
      });
    },
    rejected(status: string) {
      if (settled) return;
      settle();
      reportClientEvent({
        source: "chat_websocket",
        event: "chat_ws_send_rejected",
        severity: "warn",
        status,
        message: "sendMessage was rejected by the server.",
        threadId,
        durationMs: Date.now() - dispatchedAt,
      });
    },
    failed(error: unknown) {
      if (settled) return;
      settle();
      const stats = statsFor(threadId);
      reportClientEvent({
        source: "chat_websocket",
        event: "chat_ws_send_failed",
        severity: "error",
        status: "failed",
        message: "sendMessage RPC failed.",
        threadId,
        durationMs: Date.now() - dispatchedAt,
        error,
        details: {
          ...connectionContext(),
          ...lifecycleCounts(stats),
          readyState: getReadyState(),
        },
      });
    },
  };
}

/** The busy indicator has seen zero stream progress for `sinceMs` while the
 * hook still reports an active turn — early warning for a dead receive path. */
export function reportChatStreamNoProgress(
  threadId: string | undefined,
  sinceMs: number,
  status: string,
): void {
  reportClientEvent({
    source: "chat_runner",
    event: "chat_stream_no_progress",
    severity: "warn",
    status,
    message: "Busy turn has made no observable stream progress.",
    threadId: threadId ?? null,
    durationMs: sinceMs,
    details: connectionContext(),
  });
}

/** The stall clamp fired: the stream was provably dead for the full stale
 * bound and the busy indicator was force-cleared. */
export function reportChatStreamStallClamped(
  threadId: string | undefined,
  sinceMs: number,
  status: string,
): void {
  reportClientEvent({
    source: "chat_runner",
    event: "chat_stream_stall_clamped",
    severity: "error",
    status,
    message: "Stream stall clamp fired: busy with no progress past the bound.",
    threadId: threadId ?? null,
    durationMs: sinceMs,
    details: connectionContext(),
  });
}
