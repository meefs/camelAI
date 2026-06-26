import type { Message } from "@/types";

/** A message that represents (or will become) an assistant turn. */
export function isAssistantLikeMessage(
  msg: Message | null | undefined,
): boolean {
  return Boolean(msg && (msg.role === "assistant" || msg.isCompactSummary));
}

/**
 * Whether to show the "assistant is working" indicator under the transcript.
 *
 * True when a turn is genuinely pending — the agent is streaming, a send is
 * queued/in-flight (`loading`), or this is a freshly-started new chat whose
 * first turn is running in the background (`pendingFirstTurn`) — AND the
 * transcript currently ends on a non-assistant message.
 *
 * It deliberately keys on `pendingFirstTurn` rather than "any trailing user
 * message": a thread can legitimately end on a user message with no pending
 * turn (e.g. a fork created via "Fork from here" copies messages without
 * starting a run), and that must NOT spin forever. The `isAssistantLikeMessage`
 * guard turns the indicator off as soon as the assistant reply appears.
 *
 * `hasTerminalError` cancels the `pendingFirstTurn` signal: that prop comes from
 * the loader and stays true for the mount's lifetime, so if the background first
 * turn fails before producing an assistant message (clearing loading/isStreaming
 * but leaving the synthesized user message last), the indicator would otherwise
 * spin forever and keep the composer in steer mode. A terminal error means the
 * turn is over.
 */
export function deriveIsAwaitingAssistant(opts: {
  loading: boolean;
  isStreaming: boolean;
  pendingFirstTurn: boolean;
  lastMessage: Message | null | undefined;
  hasTerminalError?: boolean;
}): boolean {
  const firstTurnPending = opts.pendingFirstTurn && !opts.hasTerminalError;
  const turnPending = opts.loading || opts.isStreaming || firstTurnPending;
  return (
    turnPending &&
    Boolean(opts.lastMessage) &&
    !isAssistantLikeMessage(opts.lastMessage)
  );
}
