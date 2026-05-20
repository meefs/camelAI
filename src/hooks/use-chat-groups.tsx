"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMatches, useRouteLoaderData, useRevalidator } from "react-router";
import type { ChatGroupView, ThreadStatus } from "@/types";
import { useAuthData } from "@/hooks/use-auth-data";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import { maxThreadStatus } from "@/lib/thread-status";

interface AppChatGroupsLoaderData {
  chatGroups?: ChatGroupView[];
}

interface ChatRouteData {
  activeChatGroup?: ChatGroupView | null;
  activeGroupId?: string | null;
  threadId?: string | null;
}

interface ChatGroupsContextValue {
  groups: ChatGroupView[];
  activeGroupId: string | null;
  runningThreadIds: Set<string>;
  hasStatusSnapshot: boolean;
  markThreadIdle: (threadId: string) => void;
}

const ChatGroupsContext = createContext<ChatGroupsContextValue | null>(null);
type ChatGroupThreadSummary = ChatGroupView["open_threads"][number];
export type ThreadSummaryPatch = Partial<
  Pick<ChatGroupThreadSummary, "title" | "model" | "provider">
> & {
  updatedAt: number;
};

function getActiveGroupIdFromMatches(matches: ReturnType<typeof useMatches>) {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.activeChatGroup?.id) return data.activeChatGroup.id;
    if (data?.activeGroupId) return data.activeGroupId;
  }
  return null;
}

function getActiveChatGroupFromMatches(
  matches: ReturnType<typeof useMatches>,
): ChatGroupView | null {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.activeChatGroup) return data.activeChatGroup;
  }
  return null;
}

function getActiveThreadIdFromMatches(matches: ReturnType<typeof useMatches>) {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.threadId) return data.threadId;
  }
  return null;
}

export function getGroupLandingHref(group: ChatGroupView): string {
  const activeThreadStillOpen =
    group.last_active_thread_id &&
    group.open_threads.some((thread) => thread.id === group.last_active_thread_id);
  if (activeThreadStillOpen) return `/chat/${group.last_active_thread_id}`;
  const firstOpen = group.open_threads[0]?.id;
  if (firstOpen) return `/chat/${firstOpen}`;
  return `/chat?group=${encodeURIComponent(group.id)}`;
}

export function reconcileLocalThreadStatusesWithSnapshot(
  localStatuses: Map<string, ThreadStatus>,
  runningThreadIds: Set<string>,
): Map<string, ThreadStatus> {
  let next: Map<string, ThreadStatus> | null = null;
  for (const [threadId, status] of localStatuses) {
    if (status === "running" || runningThreadIds.has(threadId)) {
      next ??= new Map(localStatuses);
      next.delete(threadId);
    }
  }
  return next ?? localStatuses;
}

export function shouldMarkActiveUnreadThreadViewed(
  status: ThreadStatus,
  threadId: string,
  activeThreadId: string | null,
): boolean {
  return status === "unread" && threadId === activeThreadId;
}

export function shouldMarkActiveIdleThreadViewed(
  status: ThreadStatus,
  threadId: string,
  activeThreadId: string | null,
): boolean {
  return status === "idle" && threadId === activeThreadId;
}

export function getThreadIdsRequiringSnapshotRevalidation(
  liveStatuses: ReadonlyMap<string, ThreadStatus>,
  localStatuses: ReadonlyMap<string, ThreadStatus>,
  runningThreadIds: Set<string>,
  activeThreadId: string | null,
): string[] {
  const threadIds = new Set<string>();
  for (const [threadId, status] of liveStatuses) {
    if (status === "running") threadIds.add(threadId);
  }
  for (const [threadId, status] of localStatuses) {
    if (status === "running") threadIds.add(threadId);
  }

  return Array.from(threadIds).filter(
    (threadId) =>
      threadId !== activeThreadId && !runningThreadIds.has(threadId),
  );
}

export function mergeActiveChatGroup(
  groups: ChatGroupView[],
  activeGroup: ChatGroupView | null,
): ChatGroupView[] {
  if (!activeGroup) return groups;
  const existingIndex = groups.findIndex((group) => group.id === activeGroup.id);
  if (existingIndex < 0) return [activeGroup, ...groups];

  const next = [...groups];
  next[existingIndex] = activeGroup;
  return next;
}

export function getCloseGroupRedirect(
  groups: ChatGroupView[],
  activeGroupId: string | null,
  closingGroupId: string,
): string | null {
  if (closingGroupId !== activeGroupId) return null;
  const nextGroup = groups.find((group) => group.id !== closingGroupId);
  return nextGroup ? getGroupLandingHref(nextGroup) : "/chat";
}

function getThreadSummariesInGroups(
  groups: ChatGroupView[] | undefined,
): Map<string, ChatGroupThreadSummary> {
  const threads = new Map<string, ChatGroupThreadSummary>();
  for (const group of groups ?? []) {
    for (const thread of group.open_threads) {
      threads.set(thread.id, thread);
    }
    for (const thread of group.closed_threads) {
      threads.set(thread.id, thread);
    }
  }
  return threads;
}

export function reconcileThreadSummaryPatchesWithGroups(
  patches: ReadonlyMap<string, ThreadSummaryPatch>,
  groups: ChatGroupView[] | undefined,
): Map<string, ThreadSummaryPatch> {
  if (patches.size === 0) return patches as Map<string, ThreadSummaryPatch>;
  if (!groups) return patches as Map<string, ThreadSummaryPatch>;
  if (groups && groups.length === 0) return new Map();
  const refreshedThreads = getThreadSummariesInGroups(groups);
  if (refreshedThreads.size === 0) return new Map();

  let next: Map<string, ThreadSummaryPatch> | null = null;
  for (const [threadId, patch] of patches) {
    const refreshedThread = refreshedThreads.get(threadId);
    if (refreshedThread && refreshedThread.updated_at < patch.updatedAt) {
      continue;
    }
    next ??= new Map(patches);
    next.delete(threadId);
  }

  return next ?? (patches as Map<string, ThreadSummaryPatch>);
}

function getThreadSummaryPatchFromPayload(payload: unknown): ThreadSummaryPatch | null {
  if (!payload || typeof payload !== "object") return null;
  const thread = (payload as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object") return null;
  const record = thread as Record<string, unknown>;
  if (
    typeof record.title !== "string" ||
    typeof record.model !== "string" ||
    (record.provider !== "claude" && record.provider !== "codex") ||
    typeof record.updated_at !== "number" ||
    !Number.isFinite(record.updated_at)
  ) {
    return null;
  }

  return {
    title: record.title,
    model: record.model as ChatGroupThreadSummary["model"],
    provider: record.provider,
    updatedAt: record.updated_at,
  };
}

function mergeThreadSummaryPatch(
  current: ReadonlyMap<string, ThreadSummaryPatch>,
  threadId: string,
  patch: ThreadSummaryPatch,
): Map<string, ThreadSummaryPatch> {
  const currentPatch = current.get(threadId);
  if (currentPatch && currentPatch.updatedAt > patch.updatedAt) {
    return current as Map<string, ThreadSummaryPatch>;
  }

  const nextPatch: ThreadSummaryPatch = {
    ...currentPatch,
    ...patch,
    updatedAt: Math.max(currentPatch?.updatedAt ?? 0, patch.updatedAt),
  };
  if (
    currentPatch?.title === nextPatch.title &&
    currentPatch?.model === nextPatch.model &&
    currentPatch?.provider === nextPatch.provider &&
    currentPatch?.updatedAt === nextPatch.updatedAt
  ) {
    return current as Map<string, ThreadSummaryPatch>;
  }

  const next = new Map(current);
  next.set(threadId, nextPatch);
  return next;
}

export function applyLiveRunningStatuses(
  source: ChatGroupView[],
  runningThreadIds: Set<string>,
  hasStatusSnapshot: boolean,
  activeThreadId: string | null = null,
  liveThreadStatuses: ReadonlyMap<string, ThreadStatus> = new Map(),
  threadSummaryPatches: ReadonlyMap<string, ThreadSummaryPatch> = new Map(),
): ChatGroupView[] {
  let changed = false;
  const nextGroups = source.map((group) => {
    const resolveThread = (
      thread: ChatGroupThreadSummary,
    ): ChatGroupThreadSummary => {
      const liveStatus = liveThreadStatuses.get(thread.id);
      const status =
        liveStatus === "running" ||
        liveStatus === "unread" ||
        liveStatus === "idle"
          ? liveStatus
          : runningThreadIds.has(thread.id)
              ? "running" as const
              : hasStatusSnapshot && thread.status === "running"
                ? thread.is_unread
                  ? "unread" as const
                  : "idle" as const
                : thread.status;
      const resolvedStatus =
        thread.id === activeThreadId && status === "unread" ? "idle" : status;
      const summaryPatch = threadSummaryPatches.get(thread.id);
      const nextTitle = summaryPatch?.title ?? thread.title;
      const nextModel = summaryPatch?.model ?? thread.model;
      const nextProvider = summaryPatch?.provider ?? thread.provider;
      const nextIsUnread = resolvedStatus === "unread";
      const currentIsUnread = thread.is_unread ?? thread.status === "unread";

      if (
        thread.status === resolvedStatus &&
        currentIsUnread === nextIsUnread &&
        thread.title === nextTitle &&
        thread.model === nextModel &&
        thread.provider === nextProvider
      ) {
        return thread;
      }

      changed = true;
      return {
        ...thread,
        title: nextTitle,
        model: nextModel,
        provider: nextProvider,
        is_unread: nextIsUnread,
        status: resolvedStatus,
      };
    };
    let openThreadsChanged = false;
    let closedThreadsChanged = false;
    const open_threads = group.open_threads.map((thread) => {
      const nextThread = resolveThread(thread);
      if (nextThread !== thread) openThreadsChanged = true;
      return nextThread;
    });
    const closed_threads = group.closed_threads.map((thread) => {
      const nextThread = resolveThread(thread);
      if (nextThread !== thread) closedThreadsChanged = true;
      return nextThread;
    });
    const nextStatus = maxThreadStatus([
      ...open_threads.map((thread) => thread.status),
      ...closed_threads.map((thread) => thread.status),
    ]);

    if (
      !openThreadsChanged &&
      !closedThreadsChanged &&
      group.status === nextStatus
    ) {
      return group;
    }

    changed = true;
    return {
      ...group,
      open_threads: openThreadsChanged ? open_threads : group.open_threads,
      closed_threads: closedThreadsChanged ? closed_threads : group.closed_threads,
      status: nextStatus,
    };
  });

  return changed ? nextGroups : source;
}

export function ChatGroupsProvider({ children }: { children: ReactNode }) {
  const { currentWorkspace } = useAuthData();
  const revalidator = useRevalidator();
  const chatDebugFlags = getChatDebugFlags();
  const statusSocketEnabled = chatDebugFlags.statusSocket;
  const statusRevalidateEnabled = chatDebugFlags.statusRevalidate;
  const markViewedEnabled = chatDebugFlags.markViewed;
  const revalidateRef = useRef(revalidator.revalidate);
  const data = useRouteLoaderData("routes/_app") as
    | AppChatGroupsLoaderData
    | undefined;
  const matches = useMatches();
  const activeThreadId = getActiveThreadIdFromMatches(matches);
  const activeThreadIdRef = useRef(activeThreadId);
  const [liveThreadStatuses, setLiveThreadStatuses] = useState<
    Map<string, ThreadStatus>
  >(
    () => new Map(),
  );
  const [localThreadStatuses, setLocalThreadStatuses] = useState<
    Map<string, ThreadStatus>
  >(() => new Map());
  const [localThreadSummaryPatches, setLocalThreadSummaryPatches] = useState<
    Map<string, ThreadSummaryPatch>
  >(() => new Map());
  const liveThreadStatusesRef = useRef(liveThreadStatuses);
  const localThreadStatusesRef = useRef(localThreadStatuses);
  const [hasStatusSnapshot, setHasStatusSnapshot] = useState(false);
  const resolvedThreadStatuses = useMemo(() => {
    const next = new Map(liveThreadStatuses);
    for (const [threadId, status] of localThreadStatuses) {
      next.set(threadId, status);
    }
    return next;
  }, [liveThreadStatuses, localThreadStatuses]);
  const runningThreadIds = useMemo(
    () =>
      new Set(
        Array.from(resolvedThreadStatuses)
          .filter(([, status]) => status === "running")
          .map(([threadId]) => threadId),
      ),
    [resolvedThreadStatuses],
  );

  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  }, [revalidator.revalidate]);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    liveThreadStatusesRef.current = liveThreadStatuses;
  }, [liveThreadStatuses]);

  useEffect(() => {
    localThreadStatusesRef.current = localThreadStatuses;
  }, [localThreadStatuses]);

  useEffect(() => {
    if (!activeThreadId) return;
    setLiveThreadStatuses((current) => {
      if (current.get(activeThreadId) !== "unread") return current;
      const next = new Map(current);
      next.delete(activeThreadId);
      return next;
    });
  }, [activeThreadId]);

  useEffect(() => {
    setLocalThreadSummaryPatches((current) =>
      reconcileThreadSummaryPatchesWithGroups(current, data?.chatGroups),
    );
  }, [data?.chatGroups]);

  const markThreadIdle = useCallback((threadId: string) => {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return;
    setLocalThreadStatuses((current) => {
      const currentStatus =
        current.get(normalizedThreadId) ??
        liveThreadStatusesRef.current.get(normalizedThreadId);
      if (currentStatus === "running" || currentStatus === "idle") {
        return current;
      }
      const next = new Map(current);
      next.set(normalizedThreadId, "idle");
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleLocalThreadStatus = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const payload = detail as {
        threadId?: unknown;
        status?: unknown;
        title?: unknown;
        model?: unknown;
        provider?: unknown;
        updatedAt?: unknown;
      };
      if (
        typeof payload.threadId !== "string" ||
        (payload.status !== undefined &&
          payload.status !== "idle" &&
          payload.status !== "running")
      ) {
        return;
      }
      const threadId = payload.threadId;
      const status =
        payload.status === "idle" || payload.status === "running"
          ? payload.status
          : null;
      if (status) {
        if (
          markViewedEnabled &&
          shouldMarkActiveIdleThreadViewed(status, threadId, activeThreadIdRef.current)
        ) {
          void fetch(`/api/threads/${encodeURIComponent(threadId)}/mark-viewed`, {
            method: "POST",
          }).catch(() => {});
        }

        setLocalThreadStatuses((current) => {
          if (current.get(threadId) === status) return current;
          const next = new Map(current);
          next.set(threadId, status);
          return next;
        });
      }

      const title =
        typeof payload.title === "string" ? payload.title.trim() : undefined;
      const model = typeof payload.model === "string" ? payload.model : undefined;
      const provider =
        payload.provider === "codex" || payload.provider === "claude"
          ? payload.provider
          : undefined;
      if (title || model || provider) {
        setLocalThreadSummaryPatches((current) => {
          const currentPatch = current.get(threadId);
          const updatedAt =
            typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? payload.updatedAt
              : Date.now();
          if (currentPatch && currentPatch.updatedAt > updatedAt) {
            return current;
          }
          return mergeThreadSummaryPatch(current, threadId, {
            ...(title ? { title } : {}),
            ...(model ? { model: model as ChatGroupThreadSummary["model"] } : {}),
            ...(provider
              ? { provider: provider as ChatGroupThreadSummary["provider"] }
              : {}),
            updatedAt,
          });
        });
      }
    };

    window.addEventListener("camelai:thread-status", handleLocalThreadStatus);
    return () => {
      window.removeEventListener("camelai:thread-status", handleLocalThreadStatus);
    };
  }, [markViewedEnabled]);

  useEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!statusSocketEnabled || !workspaceId || typeof window === "undefined") {
      setLiveThreadStatuses(new Map());
      setLocalThreadStatuses(new Map());
      setLocalThreadSummaryPatches(new Map());
      setHasStatusSnapshot(false);
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = `${protocol}//${window.location.host}/ws/workspaces/${encodeURIComponent(workspaceId)}/status`;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let revalidateTimer: number | null = null;
    const metadataRefreshTimers = new Map<string, number>();
    let closedByEffect = false;

    const scheduleStatusRevalidate = (threadId: string) => {
      if (!statusRevalidateEnabled) return;
      if (threadId === activeThreadIdRef.current) return;
      if (revalidateTimer !== null) return;
      revalidateTimer = window.setTimeout(() => {
        revalidateTimer = null;
        revalidateRef.current();
      }, 750);
    };
    const refreshThreadSummary = async (threadId: string) => {
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`);
        if (!response.ok || closedByEffect) return;
        const patch = getThreadSummaryPatchFromPayload(await response.json());
        if (!patch || closedByEffect) return;
        setLocalThreadSummaryPatches((current) =>
          mergeThreadSummaryPatch(current, threadId, patch),
        );
      } catch {
        // The next loader refresh will catch up if this narrow metadata fetch fails.
      }
    };
    const scheduleThreadSummaryRefresh = (threadId: string) => {
      if (threadId === activeThreadIdRef.current) return;
      if (metadataRefreshTimers.has(threadId)) return;
      const timer = window.setTimeout(() => {
        metadataRefreshTimers.delete(threadId);
        void refreshThreadSummary(threadId);
      }, 750);
      metadataRefreshTimers.set(threadId, timer);
    };
    const markActiveThreadViewed = (threadId: string) => {
      if (!markViewedEnabled) return;
      void fetch(`/api/threads/${encodeURIComponent(threadId)}/mark-viewed`, {
        method: "POST",
      }).catch(() => {});
    };

    const connect = () => {
      const nextSocket = new WebSocket(socketUrl);
      socket = nextSocket;

      nextSocket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data as string) as {
            type?: unknown;
            runningThreadIds?: unknown;
            threadId?: unknown;
            status?: unknown;
          };
          if (
            payload.type === "thread_status_snapshot" &&
            Array.isArray(payload.runningThreadIds)
          ) {
            setHasStatusSnapshot(true);
            const nextRunningThreadIds = payload.runningThreadIds.filter(
              (threadId): threadId is string => typeof threadId === "string",
            );
            const nextRunningThreadIdSet = new Set(nextRunningThreadIds);
            const staleRunningThreadIds =
              getThreadIdsRequiringSnapshotRevalidation(
                liveThreadStatusesRef.current,
                localThreadStatusesRef.current,
                nextRunningThreadIdSet,
                activeThreadIdRef.current,
              );
            setLiveThreadStatuses((current) => {
              let next: Map<string, ThreadStatus> | null = null;
              for (const [threadId, status] of current) {
                if (status === "running") {
                  next ??= new Map(current);
                  next.delete(threadId);
                }
              }
              for (const threadId of nextRunningThreadIds) {
                if ((next ?? current).get(threadId) !== "running") {
                  next ??= new Map(current);
                  next.set(threadId, "running");
                }
              }
              return next ?? current;
            });
            setLocalThreadStatuses((current) =>
              reconcileLocalThreadStatusesWithSnapshot(
                current,
                nextRunningThreadIdSet,
              ),
            );
            if (staleRunningThreadIds.length > 0) {
              scheduleStatusRevalidate(staleRunningThreadIds[0]);
              for (const threadId of staleRunningThreadIds) {
                scheduleThreadSummaryRefresh(threadId);
              }
            }
          }
          if (
            payload.type === "thread_status" &&
            typeof payload.threadId === "string" &&
            (payload.status === "idle" ||
              payload.status === "running" ||
              payload.status === "unread")
          ) {
            const threadId = payload.threadId;
            const payloadStatus = payload.status as ThreadStatus;
            const isActiveUnread = shouldMarkActiveUnreadThreadViewed(
              payloadStatus,
              threadId,
              activeThreadIdRef.current,
            );
            if (isActiveUnread) {
              markActiveThreadViewed(threadId);
            }
            const status = isActiveUnread ? "idle" : payloadStatus;
            setHasStatusSnapshot(true);
            setLiveThreadStatuses((current) => {
              if (current.get(threadId) === status) return current;
              const next = new Map(current);
              next.set(threadId, status);
              return next;
            });
            setLocalThreadStatuses((current) => {
              if (current.get(threadId) === status) return current;
              const next = new Map(current);
              next.set(threadId, status);
              return next;
            });
            if (status === "idle" || status === "unread") {
              scheduleStatusRevalidate(threadId);
              scheduleThreadSummaryRefresh(threadId);
            }
          }
        } catch {
          // Ignore malformed status frames.
        }
      });

      nextSocket.addEventListener("close", () => {
        if (closedByEffect || socket !== nextSocket) return;
        reconnectTimer = window.setTimeout(connect, 1000);
      });
      nextSocket.addEventListener("error", () => {
        if (socket !== nextSocket) return;
        nextSocket.close();
      });
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (revalidateTimer) window.clearTimeout(revalidateTimer);
      for (const timer of metadataRefreshTimers.values()) {
        window.clearTimeout(timer);
      }
      metadataRefreshTimers.clear();
      socket?.close();
    };
  }, [
    currentWorkspace?.id,
    markViewedEnabled,
    statusRevalidateEnabled,
    statusSocketEnabled,
  ]);

  const groups = useMemo(() => {
    const source = mergeActiveChatGroup(
      data?.chatGroups ?? [],
      getActiveChatGroupFromMatches(matches),
    );
    return applyLiveRunningStatuses(
      source,
      runningThreadIds,
      hasStatusSnapshot,
      activeThreadId,
      resolvedThreadStatuses,
      localThreadSummaryPatches,
    );
  }, [
    activeThreadId,
    data?.chatGroups,
    hasStatusSnapshot,
    localThreadSummaryPatches,
    matches,
    resolvedThreadStatuses,
    runningThreadIds,
  ]);

  const value = useMemo(() => ({
    groups,
    activeGroupId: getActiveGroupIdFromMatches(matches),
    runningThreadIds,
    hasStatusSnapshot,
    markThreadIdle,
  }), [groups, hasStatusSnapshot, markThreadIdle, matches, runningThreadIds]);

  return (
    <ChatGroupsContext.Provider value={value}>
      {children}
    </ChatGroupsContext.Provider>
  );
}

export function useChatGroups() {
  const context = useContext(ChatGroupsContext);
  if (!context) {
    throw new Error("useChatGroups must be used within ChatGroupsProvider");
  }
  return context;
}
