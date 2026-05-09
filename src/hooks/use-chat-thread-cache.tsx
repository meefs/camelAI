"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  ChatHarness,
  LlmModel,
  Message,
  PreviewTarget,
} from "@/types";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import { mergeServerAndLocalMessages } from "@/lib/chat-message-merge";

const MAX_CACHED_THREADS = 20;

export type ChatThreadHistoryState = "server" | "local" | "streaming";

export interface ChatThreadSnapshot {
  workspaceId: string;
  threadId: string;
  threadTitle: string | null;
  threadModel: LlmModel;
  threadProvider: ChatHarness;
  messages: Message[];
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
  previewTarget: PreviewTarget | null;
  historyState: ChatThreadHistoryState;
  loadedAt: number;
}

export interface ChatThreadSnapshotInput {
  workspaceId: string;
  threadId: string;
  threadTitle?: string | null;
  threadModel?: LlmModel;
  threadProvider?: ChatHarness;
  messages?: Message[];
  previewTabs?: PreviewTarget[];
  activeTabId?: string | null;
  previewTarget?: PreviewTarget | null;
  historyState?: ChatThreadHistoryState;
}

interface ChatThreadCacheContextValue {
  getSnapshot: (
    workspaceId: string | null | undefined,
    threadId: string | null | undefined,
  ) => ChatThreadSnapshot | null;
  writeSnapshot: (snapshot: ChatThreadSnapshotInput) => void;
  prefetchMessages: (
    workspaceId: string,
    threadId: string,
    meta?: Pick<
      ChatThreadSnapshotInput,
      "threadTitle" | "threadModel" | "threadProvider"
    >,
  ) => Promise<ChatThreadSnapshot | null>;
}

const ChatThreadCacheContext =
  createContext<ChatThreadCacheContextValue | null>(null);

function cacheKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`;
}

function normalizeMessage(raw: unknown, threadId: string): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : null;
  const role =
    item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
  const createdAt =
    typeof item.created_at === "number" ? item.created_at : null;
  if (!id || !role || createdAt === null) return null;
  return {
    id,
    thread_id: typeof item.thread_id === "string" ? item.thread_id : threadId,
    role,
    content:
      typeof item.content === "string" || Array.isArray(item.content)
        ? item.content
        : "",
    created_at: createdAt,
    forkEntryId:
      typeof item.forkEntryId === "string" && item.forkEntryId.trim()
        ? item.forkEntryId.trim()
        : undefined,
    isMeta: item.isMeta === true,
    sourceToolUseID:
      typeof item.sourceToolUseID === "string" ? item.sourceToolUseID : undefined,
    isCompactSummary: item.isCompactSummary === true,
  };
}

export function hasServerThreadHistory(
  snapshot: ChatThreadSnapshot | null | undefined,
): snapshot is ChatThreadSnapshot {
  return Boolean(
    snapshot &&
      snapshot.historyState === "server" &&
      snapshot.messages.length > 0,
  );
}

export function hasRenderableThreadSnapshot(
  snapshot: ChatThreadSnapshot | null | undefined,
): snapshot is ChatThreadSnapshot {
  return Boolean(snapshot && snapshot.messages.length > 0);
}

export function shouldFetchThreadHistory(
  snapshot: ChatThreadSnapshot | null | undefined,
): boolean {
  return !hasServerThreadHistory(snapshot);
}

export function upsertThreadSnapshot(
  current: Map<string, ChatThreadSnapshot>,
  input: ChatThreadSnapshotInput,
  maxEntries = MAX_CACHED_THREADS,
): Map<string, ChatThreadSnapshot> {
  const key = cacheKey(input.workspaceId, input.threadId);
  const existing = current.get(key);
  const existingMessages = existing?.messages;
  const inputMessages = input.messages;
  const preserveExistingMessages =
    existingMessages !== undefined &&
    existingMessages.length > 0 &&
    input.historyState === "server" &&
    inputMessages !== undefined &&
    inputMessages.length === 0;
  const mergeExistingMessages =
    existingMessages !== undefined &&
    existingMessages.length > 0 &&
    input.historyState === "server" &&
    inputMessages !== undefined &&
    inputMessages.length > 0;
  const messages = preserveExistingMessages
    ? existingMessages
    : mergeExistingMessages
      ? mergeServerAndLocalMessages(inputMessages, existingMessages)
      : inputMessages ?? existing?.messages ?? [];
  const hasActiveStream = messages.some((message) => message.isStreaming);
  const next = new Map(current);
  next.delete(key);
  next.set(key, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    threadTitle:
      input.threadTitle !== undefined
        ? input.threadTitle
        : existing?.threadTitle ?? null,
    threadModel: input.threadModel ?? existing?.threadModel ?? "sonnet",
    threadProvider:
      input.threadProvider ?? existing?.threadProvider ?? "claude",
    messages,
    previewTabs: input.previewTabs ?? existing?.previewTabs ?? [],
    activeTabId:
      input.activeTabId !== undefined
        ? input.activeTabId
        : existing?.activeTabId ?? null,
    previewTarget:
      input.previewTarget !== undefined
        ? input.previewTarget
        : existing?.previewTarget ?? null,
    historyState:
      preserveExistingMessages
        ? existing?.historyState ?? "local"
        : hasActiveStream
          ? "streaming"
        : input.historyState ?? existing?.historyState ?? "local",
    loadedAt: Date.now(),
  });

  while (next.size > maxEntries) {
    const oldestKey = next.keys().next().value;
    if (!oldestKey) break;
    next.delete(oldestKey);
  }
  return next;
}

export function ChatThreadCacheProvider({
  children,
}: {
  children: ReactNode;
}) {
  const snapshotsRef = useRef<Map<string, ChatThreadSnapshot>>(new Map());
  const inflightRef = useRef<Map<string, Promise<ChatThreadSnapshot | null>>>(
    new Map(),
  );

  const writeSnapshot = useCallback((snapshot: ChatThreadSnapshotInput) => {
    if (!getChatDebugFlags().messageCache) return;
    snapshotsRef.current = upsertThreadSnapshot(
      snapshotsRef.current,
      snapshot,
    );
  }, []);

  const getSnapshot = useCallback(
    (workspaceId: string | null | undefined, threadId: string | null | undefined) => {
      if (!getChatDebugFlags().messageCache) return null;
      if (!workspaceId || !threadId) return null;
      return snapshotsRef.current.get(cacheKey(workspaceId, threadId)) ?? null;
    },
    [],
  );

  const prefetchMessages = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      meta?: Pick<
        ChatThreadSnapshotInput,
        "threadTitle" | "threadModel" | "threadProvider"
      >,
    ) => {
      if (!getChatDebugFlags().messageCache) return null;
      const key = cacheKey(workspaceId, threadId);
      const existing = snapshotsRef.current.get(key);
      if (!shouldFetchThreadHistory(existing)) return existing ?? null;

      const inflight = inflightRef.current.get(key);
      if (inflight) return inflight;

      const promise = (async () => {
        try {
          const response = await fetch(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(threadId)}/messages/stream`,
            { headers: { Accept: "application/json" } },
          );
          if (!response.ok) return null;
          const payload = (await response.json()) as { messages?: unknown };
          const messages = Array.isArray(payload.messages)
            ? payload.messages.flatMap((raw) => {
                const message = normalizeMessage(raw, threadId);
                return message ? [message] : [];
              })
            : [];

          const current = snapshotsRef.current.get(key);
          const snapshotInput: ChatThreadSnapshotInput = {
            workspaceId,
            threadId,
            threadTitle: meta?.threadTitle ?? current?.threadTitle ?? null,
            threadModel: meta?.threadModel ?? current?.threadModel,
            threadProvider: meta?.threadProvider ?? current?.threadProvider,
            messages,
            historyState: "server",
            previewTabs: current?.previewTabs,
            activeTabId: current?.activeTabId,
            previewTarget: current?.previewTarget,
          };
          const next = upsertThreadSnapshot(
            snapshotsRef.current,
            snapshotInput,
          );
          snapshotsRef.current = next;
          const written = next.get(key) ?? null;
          return written;
        } catch {
          return null;
        } finally {
          inflightRef.current.delete(key);
        }
      })();

      inflightRef.current.set(key, promise);
      return promise;
    },
    [],
  );

  const value = useMemo(
    () => ({
      getSnapshot,
      writeSnapshot,
      prefetchMessages,
    }),
    [getSnapshot, prefetchMessages, writeSnapshot],
  );

  return (
    <ChatThreadCacheContext.Provider value={value}>
      {children}
    </ChatThreadCacheContext.Provider>
  );
}

export function useChatThreadCache() {
  const context = useContext(ChatThreadCacheContext);
  if (!context) {
    throw new Error(
      "useChatThreadCache must be used within ChatThreadCacheProvider",
    );
  }
  return context;
}
