import type { Message } from "@/types";

/** A message that represents (or will become) an assistant turn. */
export function isAssistantLikeMessage(
  msg: Message | null | undefined,
): boolean {
  return Boolean(msg && (msg.role === "assistant" || msg.isCompactSummary));
}

/**
 * The transcript ends on a finished assistant reply. Completion metadata is
 * emitted only by turn/completed, so this safely overrides lagging client or
 * sidebar busy flags without hiding an in-progress assistant message.
 */
export function deriveTurnSettled(
  lastMessage: Message | null | undefined,
): boolean {
  return (
    isAssistantLikeMessage(lastMessage) &&
    typeof lastMessage?.completedAtMs === "number"
  );
}

/**
 * Whether to show the "assistant is working" indicator under the transcript.
 *
 * True when the live agent stream, a queued/in-flight send, or the durable
 * workspace running state says a turn is pending, and the transcript currently
 * ends on a non-assistant message. A trailing user message alone is not enough:
 * forks and API-created threads can legitimately be idle at that point.
 */
export function deriveIsAwaitingAssistant(opts: {
  loading: boolean;
  isStreaming: boolean;
  isRunning: boolean;
  lastMessage: Message | null | undefined;
}): boolean {
  const turnPending = opts.loading || opts.isStreaming || opts.isRunning;
  return (
    turnPending &&
    Boolean(opts.lastMessage) &&
    !isAssistantLikeMessage(opts.lastMessage)
  );
}
