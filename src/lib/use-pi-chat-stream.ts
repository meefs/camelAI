import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ContentBlock, Message } from "@/types";
import { boundBlockText } from "./pi-chunk-encoder";
import { uiMessageToMessage } from "./ui-message-adapter";

/**
 * Client bridge onto ai-chat's owned render history (commit 4). Wraps
 * `useAgentChat` so the durable UIMessage list is the single source of truth for
 * the transcript, adapts each UIMessage into the legacy `Message` shape the
 * renderer consumes, and folds in transient live tool output. The send path,
 * optimistic bubbles, and turn-lifecycle side effects stay in Chat.tsx; this hook
 * is purely the history + streaming projection.
 */

type AgentConnection = Parameters<typeof useAgentChat>[0]["agent"];

// Transient per-tool live output chunk (never persisted); see the encoder spec.
const PI_TOOL_STREAM_PART = "data-pi-tool-stream";

/**
 * Busy-state staleness bound. The server kills any turn whose reply stream goes
 * chunk-silent for chatStreamStallTimeoutMs (10min) and finalizes the stream —
 * and a healthy turn emits at least a transient heartbeat every 30s — so a
 * connected client whose busy indicator sees ZERO progress (no chunk via onData,
 * no message-list change) for longer than this is attached to a dead stream
 * (e.g. a resume handshake adopted a stream whose terminal frame was lost).
 * Clamp the indicator to idle instead of spinning forever; any later genuine
 * progress (a recovery continuation's chunks) releases the clamp.
 */
export const STREAM_PROGRESS_STALE_MS = 12 * 60_000;
const STREAM_STALL_POLL_MS = 30_000;

/** Pure core of the stall clamp: whether a busy stream with its last observed
 * progress at `lastProgressAt` should be treated as dead at `now`. */
export function isStreamProgressStale(
  lastProgressAt: number,
  now: number,
): boolean {
  return now - lastProgressAt >= STREAM_PROGRESS_STALE_MS;
}

export interface PiChatStream {
  /** Adapted transcript: UIMessages → legacy Message, with live tool output and
   * per-message streaming flags applied. */
  messages: Message[];
  /** Raw ai-chat history (UIMessage), for reconciliation/backfill callers. */
  uiMessages: UIMessage[];
  status: string;
  /** True while a client- or server-initiated stream is active for this turn. */
  isStreaming: boolean;
  /** Id of the assistant message currently streaming (the last assistant in the
   * transcript), or null when idle / awaiting the first token. */
  streamingMessageId: string | null;
  /** Replace the durable render history from a loader payload (deferred initial
   * load, missed-turn revalidation). Guarded by the caller. */
  setUiMessages: (messages: UIMessage[]) => void;
}

/**
 * Fold one transient `data-pi-tool-stream` chunk into the per-tool accumulated
 * output. Returns the next map, or null when the chunk is a no-op (malformed, or
 * a duplicate delivery/replay whose `seq` does not advance the per-tool cursor —
 * useAgentChat can hand the same chunk to `onData` twice, and a reconnect
 * replays the whole buffered stream). `cursors` is advanced in place. The
 * accumulated string is bounded to the shared live-overlay tail so a
 * long-running command cannot grow client memory without bound.
 */
export function applyToolStreamData(
  toolStream: ReadonlyMap<string, string>,
  cursors: Map<string, number>,
  data: unknown,
): Map<string, string> | null {
  const record = data as
    | { toolCallId?: unknown; text?: unknown; seq?: unknown }
    | undefined;
  const toolCallId =
    typeof record?.toolCallId === "string" ? record.toolCallId : null;
  if (!toolCallId) return null;
  const text = typeof record?.text === "string" ? record.text : "";
  const seq = typeof record?.seq === "number" ? record.seq : null;
  if (seq !== null) {
    const lastSeq = cursors.get(toolCallId);
    if (lastSeq !== undefined && seq <= lastSeq) return null;
    cursors.set(toolCallId, seq);
  }
  if (!text) return null;
  const next = new Map(toolStream);
  next.set(toolCallId, boundBlockText((next.get(toolCallId) ?? "") + text));
  return next;
}

/**
 * Collapse duplicate messages sharing one id into a single entry at the FIRST
 * occurrence's position (no mid-turn reorder jump), keeping the copy with the
 * most parts (later copy on ties). The later copy is the one the resumed
 * stream is actively rebuilding, but it starts empty — preferring the richer
 * copy shows the seeded content until the rebuild catches up (equal part
 * count) instead of blanking it for the replay's duration. Returns the input
 * array identity when no id repeats.
 *
 * Why duplicates exist at all: a tab switch remounts Chat mid-turn and seeds
 * useAgentChat from the snapshot cache, then `resume: true` replays the whole
 * buffered turn stream. When the seeded streaming assistant is NOT the tail
 * message (a steering user skeleton lands below it mid-turn), the AI SDK's
 * chunk writer only knows "replace last / push", so the replayed `start` pushes
 * a SECOND message under the same id instead of adopting the seeded one.
 */
export function dedupeUiMessagesById(messages: UIMessage[]): UIMessage[] {
  const bestById = new Map<string, UIMessage>();
  for (const message of messages) {
    const best = bestById.get(message.id);
    if (!best || message.parts.length >= best.parts.length) {
      bestById.set(message.id, message);
    }
  }
  if (bestById.size === messages.length) return messages;
  const emitted = new Set<string>();
  const next: UIMessage[] = [];
  for (const message of messages) {
    if (emitted.has(message.id)) continue;
    emitted.add(message.id);
    next.push(bestById.get(message.id) as UIMessage);
  }
  return next;
}

/**
 * Drop hydrated-remnant parts that a resume replay duplicated inside one
 * assistant message. The same tab-switch replay above, in the tail-seeded case,
 * clones the hydrated assistant as its accumulator and re-appends every
 * replayed part after the already-hydrated ones (the agents package only
 * self-heals duplicated TEXT parts, and only when its tail-only reset matched).
 * A part is a remnant when a LATER part re-states it: same toolCallId (tool
 * parts) or same part id (data parts) supersedes outright; for text/reasoning,
 * an earlier non-empty part where one text is a prefix of the other is the
 * hydrated copy of the replayed part — later-extends-earlier once the replay
 * has caught up, earlier-extends-later while the replayed rebuild is still
 * shorter than the hydrated remnant (keep the later: it is the live, growing
 * copy, and rendering both is exactly the duplication bug). Applied only to messages a
 * replayed `start` actually touched (see replayTouchedIdsRef), so an ordinary
 * transcript with genuinely repeated content is never collapsed. Returns the
 * message identity untouched when nothing drops.
 */
export function collapseReplayDuplicateParts(message: UIMessage): UIMessage {
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length < 2) return message;
  const drop = new Set<number>();
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as {
      type: string;
      text?: unknown;
      toolCallId?: unknown;
      id?: unknown;
    };
    for (let j = i + 1; j < parts.length; j += 1) {
      const later = parts[j] as typeof part;
      if (later.type !== part.type) continue;
      if (part.type === "text" || part.type === "reasoning") {
        const earlierText = typeof part.text === "string" ? part.text : "";
        const laterText = typeof later.text === "string" ? later.text : "";
        if (
          earlierText &&
          (laterText.startsWith(earlierText) ||
            earlierText.startsWith(laterText))
        ) {
          drop.add(i);
          break;
        }
      } else if (typeof part.toolCallId === "string" && part.toolCallId) {
        if (later.toolCallId === part.toolCallId) {
          drop.add(i);
          break;
        }
      } else if (typeof part.id === "string" && part.id) {
        if (later.id === part.id) {
          drop.add(i);
          break;
        }
      }
    }
  }
  if (drop.size === 0) return message;
  return {
    ...message,
    parts: parts.filter((_, index) => !drop.has(index)),
  };
}

/** Splice a streaming tool_result (accumulated live output) after any tool_use
 * that has not yet settled. Mirrors the legacy overlay's streaming command
 * output; the settled block replaces it once tool-output-available arrives.
 * Returns the message unchanged (same identity) when nothing merges. */
function mergeLiveToolOutput(
  message: Message,
  toolStream: Map<string, string>,
): Message {
  if (typeof message.content === "string") return message;
  const settled = new Set<string>();
  for (const block of message.content) {
    if (block.type === "tool_result") settled.add(block.tool_use_id);
  }
  const next: ContentBlock[] = [];
  let changed = false;
  for (const block of message.content) {
    next.push(block);
    if (block.type === "tool_use" && !settled.has(block.id)) {
      const liveText = toolStream.get(block.id);
      if (liveText) {
        next.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: liveText,
          status: "succeeded",
          itemId: block.id,
          ...(block.itemKind ? { itemKind: block.itemKind } : {}),
        });
        changed = true;
      }
    }
  }
  return changed ? { ...message, content: next } : message;
}

export function usePiChatStream(opts: {
  agent: AgentConnection;
  threadId: string | undefined;
  initialUiMessages: UIMessage[];
}): PiChatStream {
  const { agent, threadId, initialUiMessages } = opts;

  // Live tool output keyed by toolCallId, fed by transient data-pi-tool-stream
  // chunks. Merged into the adapted tool_result at render, cleared on turn end
  // and thread switch (never persisted). The cursor map (last applied seq per
  // tool) rides alongside and is cleared with it.
  const [toolStream, setToolStream] = useState<Map<string, string>>(
    () => new Map(),
  );
  const toolStreamCursorsRef = useRef<Map<string, number>>(new Map());

  // Stall clamp (see STREAM_PROGRESS_STALE_MS): timestamp of the last observed
  // stream progress — any data-* chunk delivered to onData (tool output AND the
  // transient server heartbeats) or any change to the message list (text/tool
  // chunks replace the streaming message object each tick).
  const lastStreamProgressAtRef = useRef(Date.now());
  const [stallClamped, setStallClamped] = useState(false);
  const noteStreamProgress = useCallback(() => {
    lastStreamProgressAtRef.current = Date.now();
    setStallClamped(false);
  }, []);

  const onData = useCallback(
    (part: { type: string; data?: unknown }) => {
      noteStreamProgress();
      if (part.type !== PI_TOOL_STREAM_PART) return;
      const data = part.data;
      setToolStream((prev) => {
        const next = applyToolStreamData(
          prev,
          toolStreamCursorsRef.current,
          data,
        );
        return next ?? prev;
      });
    },
    [noteStreamProgress],
  );

  const chat = useAgentChat<unknown, UIMessage>({
    agent,
    messages: initialUiMessages,
    getInitialMessages: null,
    syncMessagesToServer: false,
    resume: true,
    onData,
  });

  // Message ids a resumed-stream replay wrote a `start` chunk for. Replay onto
  // a snapshot-seeded (already hydrated) transcript is what duplicates
  // messages/parts (see dedupeUiMessagesById / collapseReplayDuplicateParts);
  // scoping the normalization to these ids keeps it away from ordinary
  // transcripts. The set drains when a cf_agent_chat_messages broadcast lands —
  // that frame replaces local state with the server's clean list in the same
  // event, so the collapse (with its prefix heuristic) never outlives the
  // window where replay artifacts can exist. NOTE: this reads the agents
  // package's ws frame shape (type/replay/body); a shape change here degrades
  // to the pre-fix behavior, it cannot break the transport.
  const [replayTouchedIds, setReplayTouchedIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Live mirrors for the socket listener. rawIsStreamingRef: a broadcast
  // landing MID-turn (steering persist, fork-id stamp) merges the local live
  // accumulator back in — replay artifacts can survive it, so only an idle
  // broadcast may drain the set. chatMessagesRef: a replayed start is only
  // harmful when it lands on an id already hydrated in the transcript; the
  // listener needs the current list to tell.
  const rawIsStreamingRef = useRef(false);
  rawIsStreamingRef.current = chat.isStreaming;
  const chatMessagesRef = useRef(chat.messages);
  chatMessagesRef.current = chat.messages;
  useEffect(() => {
    const socket = agent as unknown as {
      addEventListener?: (
        type: "message",
        listener: (event: MessageEvent) => void,
      ) => void;
      removeEventListener?: (
        type: "message",
        listener: (event: MessageEvent) => void,
      ) => void;
    };
    if (!socket?.addEventListener) return;
    const onSocketMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      if (event.data.includes('"cf_agent_chat_messages"')) {
        // An idle broadcast (e.g. the turn-settling persist) replaced local
        // state with the server's clean list: replay artifacts (and any need
        // to collapse them) are gone. Mid-turn broadcasts don't drain — see
        // rawIsStreamingRef.
        if (!rawIsStreamingRef.current) {
          setReplayTouchedIds((prev) => (prev.size > 0 ? new Set() : prev));
        }
        return;
      }
      // Cheap prescreen: only a replayed `start` frame matters (one per
      // message), not the O(chunks) delta frames. The body is a JSON string
      // nested in JSON, so its quotes arrive escaped.
      if (
        !event.data.includes('"cf_agent_use_chat_response"') ||
        !event.data.includes('"replay":true') ||
        !event.data.includes('\\"start\\"')
      ) {
        return;
      }
      try {
        const frame = JSON.parse(event.data) as {
          type?: unknown;
          replay?: unknown;
          body?: unknown;
        };
        if (frame.type !== "cf_agent_use_chat_response" || !frame.replay) {
          return;
        }
        if (typeof frame.body !== "string") return;
        const chunk = JSON.parse(frame.body) as {
          type?: unknown;
          messageId?: unknown;
        };
        if (chunk.type === "start" && typeof chunk.messageId === "string") {
          const messageId = chunk.messageId;
          // Only a replay landing on an ALREADY-HYDRATED copy of the message
          // can duplicate content (the AI SDK clones or pushes alongside it).
          // A start for an absent or empty-parts id rebuilds cleanly — marking
          // it would only expose the collapse heuristic to clean transcripts
          // (e.g. every reconnect replay of an already-completed turn).
          const existing = chatMessagesRef.current.find(
            (message) => message.id === messageId,
          );
          if (!existing || existing.parts.length === 0) return;
          setReplayTouchedIds((prev) =>
            prev.has(messageId) ? prev : new Set(prev).add(messageId),
          );
        }
      } catch {
        // Not a JSON frame we understand; the chat transport owns it.
      }
    };
    socket.addEventListener("message", onSocketMessage);
    return () => socket.removeEventListener?.("message", onSocketMessage);
  }, [agent]);

  // Normalized render history: duplicate-id messages collapsed to one entry,
  // replay-touched assistant messages stripped of hydrated-remnant parts. This
  // (not chat.messages) is the transcript every consumer sees — including the
  // thread-switch snapshot, so a captured mid-replay state re-seeds clean.
  // Duplicates can only exist after a replayed start touched an id, so an empty
  // set skips all normalization work on the ordinary streaming hot path. The
  // collapse result is cached by input identity so a touched-but-settled
  // message keeps a stable output identity across ticks (the downstream
  // adapter cache is keyed on it).
  const collapseCacheRef = useRef(new WeakMap<UIMessage, UIMessage>());
  const uiMessages = useMemo(() => {
    if (replayTouchedIds.size === 0) return chat.messages;
    const deduped = dedupeUiMessagesById(chat.messages);
    let changed = false;
    const collapsed = deduped.map((message) => {
      if (
        message.role !== "assistant" ||
        !replayTouchedIds.has(message.id)
      ) {
        return message;
      }
      let next = collapseCacheRef.current.get(message);
      if (!next) {
        next = collapseReplayDuplicateParts(message);
        collapseCacheRef.current.set(message, next);
      }
      if (next !== message) changed = true;
      return next;
    });
    return changed ? collapsed : deduped;
  }, [chat.messages, replayTouchedIds]);
  const rawIsStreaming = chat.isStreaming;
  const rawStatus = chat.status;

  // Message-list identity changes are stream progress too (text deltas never
  // reach onData). setState inside the effect is safe: it bails unless a clamp
  // was actually set.
  useEffect(() => {
    lastStreamProgressAtRef.current = Date.now();
    setStallClamped(false);
  }, [uiMessages]);

  // While the hook reports busy, poll for progress; clamp once the stream has
  // been provably dead for STREAM_PROGRESS_STALE_MS. Reset the progress clock
  // when a busy window opens so a fresh resume attach gets the full budget.
  const busy =
    rawIsStreaming || rawStatus === "streaming" || rawStatus === "submitted";
  useEffect(() => {
    if (!busy) {
      setStallClamped(false);
      return;
    }
    lastStreamProgressAtRef.current = Date.now();
    const timer = setInterval(() => {
      if (isStreamProgressStale(lastStreamProgressAtRef.current, Date.now())) {
        console.warn(
          "[usePiChatStream] clearing busy indicator: stream reported active with no progress past the stall bound",
        );
        setStallClamped(true);
      }
    }, STREAM_STALL_POLL_MS);
    return () => clearInterval(timer);
  }, [busy]);

  const isStreaming = rawIsStreaming && !stallClamped;
  const status = stallClamped ? "ready" : rawStatus;

  // The streaming assistant is the LAST assistant message, not necessarily the
  // array tail: a steering user skeleton can land below it mid-turn.
  const streamingMessageId = useMemo(() => {
    if (!isStreaming) return null;
    for (let i = uiMessages.length - 1; i >= 0; i -= 1) {
      if (uiMessages[i].role === "assistant") return uiMessages[i].id;
    }
    return null;
  }, [isStreaming, uiMessages]);

  // Clear live tool output at each turn boundary and on thread switch so a stale
  // command tail never lingers into the next turn.
  const clearToolStream = useCallback(() => {
    toolStreamCursorsRef.current = new Map();
    setToolStream((prev) => (prev.size > 0 ? new Map() : prev));
  }, []);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const was = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (was && !isStreaming) clearToolStream();
  }, [clearToolStream, isStreaming]);
  useEffect(() => {
    clearToolStream();
    // Replay-touched ids clear on thread switch (the persist-broadcast drain in
    // the socket listener handles turn end).
    setReplayTouchedIds((prev) => (prev.size > 0 ? new Set() : prev));
  }, [clearToolStream, threadId]);

  // Adapt each UIMessage once, cached by object identity — ai-chat replaces only
  // the streaming message object per tick, so history never re-adapts. Streaming
  // flag and live tool output are cheap post-steps; mergeLiveToolOutput returns
  // the adapted message identity untouched when it has no unsettled tool with
  // accumulated output.
  const adaptCacheRef = useRef(new WeakMap<UIMessage, Message>());
  const messages = useMemo(() => {
    const cache = adaptCacheRef.current;
    return uiMessages.map((ui) => {
      let base = cache.get(ui);
      if (!base) {
        base = uiMessageToMessage(ui, { threadId });
        cache.set(ui, base);
      }
      const streaming = ui.id === streamingMessageId;
      const withLive =
        toolStream.size > 0 ? mergeLiveToolOutput(base, toolStream) : base;
      if (!streaming) return withLive;
      return withLive === base
        ? { ...base, isStreaming: true }
        : { ...withLive, isStreaming: true };
    });
  }, [uiMessages, streamingMessageId, toolStream, threadId]);

  const setUiMessages = useCallback(
    (next: UIMessage[]) => {
      chat.setMessages(next);
    },
    [chat],
  );

  return {
    messages,
    uiMessages,
    status,
    isStreaming,
    streamingMessageId,
    setUiMessages,
  };
}
