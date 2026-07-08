import type { Message } from '../types';

/**
 * Overlay the server's wholesale current-turn snapshot onto a base list.
 *
 * The server builds the active turn's messages whole and the browser replaces
 * (not accumulates) its overlay on every Agent-state update, so a streaming
 * message that gets re-id'd at turn/completed simply replaces its earlier entry
 * here instead of duplicating it. Matching keys on id/clientMessageId; the
 * overlay entry wins.
 *
 * New overlay entries (the live assistant turn) are inserted *above* any
 * optimistic steering echoes — the trailing run of `sentDuringStreaming` user
 * messages the browser appended while the turn was streaming. Those echoes were
 * sent to steer the in-flight assistant, so they must render below it, not
 * above. The overlay never carries user messages, so this only repositions the
 * assistant turn relative to the client-side echoes; it also keeps the turn-end
 * fold consistent (the finalized assistant lands above the echoes too).
 */
export function mergeOverlay(base: Message[], overlay: Message[]): Message[] {
  if (overlay.length === 0) return base;
  const next = [...base];
  const additions: Message[] = [];
  for (const message of overlay) {
    const index = next.findIndex(
      (existing) =>
        existing.id === message.id ||
        (message.clientMessageId &&
          existing.clientMessageId === message.clientMessageId)
    );
    if (index === -1) {
      additions.push(message);
    } else {
      next[index] = { ...next[index], ...message };
    }
  }
  if (additions.length === 0) return next;

  let insertAt = next.length;
  while (insertAt > 0 && next[insertAt - 1].sentDuringStreaming === true) {
    insertAt -= 1;
  }
  next.splice(insertAt, 0, ...additions);
  return next;
}
