"use client";

import {
  createContext,
  useContext,
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
}

const ChatGroupsContext = createContext<ChatGroupsContextValue | null>(null);

function getActiveGroupIdFromMatches(matches: ReturnType<typeof useMatches>) {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.activeChatGroup?.id) return data.activeChatGroup.id;
    if (data?.activeGroupId) return data.activeGroupId;
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
  const firstClosed = group.closed_threads[0]?.id;
  if (firstClosed) return `/chat/${firstClosed}`;
  return `/chat?group=${encodeURIComponent(group.id)}`;
}

export function applyLiveRunningStatuses(
  source: ChatGroupView[],
  runningThreadIds: Set<string>,
  hasStatusSnapshot: boolean,
  activeThreadId: string | null = null,
  liveThreadStatuses: ReadonlyMap<string, ThreadStatus> = new Map(),
): ChatGroupView[] {
  return source.map((group) => {
    const resolveThread = (
      thread: ChatGroupView["open_threads"][number],
    ): ChatGroupView["open_threads"][number] => {
      const liveStatus = liveThreadStatuses.get(thread.id);
      const status =
        liveStatus === "running" || liveStatus === "unread"
          ? liveStatus
          : liveStatus === "idle" && thread.status === "running"
            ? thread.is_unread
              ? "unread" as const
              : "idle" as const
            : runningThreadIds.has(thread.id)
              ? "running" as const
              : hasStatusSnapshot && thread.status === "running"
                ? thread.is_unread
                  ? "unread" as const
                  : "idle" as const
                : thread.status;
      const isActiveUnread = thread.id === activeThreadId && status === "unread";
      return {
        ...thread,
        is_unread: isActiveUnread ? false : thread.is_unread,
        status: isActiveUnread ? "idle" : status,
      };
    };
    const open_threads = group.open_threads.map(resolveThread);
    const closed_threads = group.closed_threads.map(resolveThread);
    return {
      ...group,
      open_threads,
      closed_threads,
      status: maxThreadStatus([
        ...open_threads.map((thread) => thread.status),
        ...closed_threads.map((thread) => thread.status),
      ]),
    };
  });
}

export function ChatGroupsProvider({ children }: { children: ReactNode }) {
  const { currentWorkspace } = useAuthData();
  const revalidator = useRevalidator();
  const chatDebugFlags = getChatDebugFlags();
  const statusSocketEnabled = chatDebugFlags.statusSocket;
  const statusRevalidateEnabled = chatDebugFlags.statusRevalidate;
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
  const [hasStatusSnapshot, setHasStatusSnapshot] = useState(false);
  const runningThreadIds = useMemo(
    () =>
      new Set(
        Array.from(liveThreadStatuses)
          .filter(([, status]) => status === "running")
          .map(([threadId]) => threadId),
      ),
    [liveThreadStatuses],
  );

  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  }, [revalidator.revalidate]);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

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
    const workspaceId = currentWorkspace?.id;
    if (!statusSocketEnabled || !workspaceId || typeof window === "undefined") {
      setLiveThreadStatuses(new Map());
      setHasStatusSnapshot(false);
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = `${protocol}//${window.location.host}/ws/workspaces/${encodeURIComponent(workspaceId)}/status`;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let revalidateTimer: number | null = null;
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
            setLiveThreadStatuses((current) => {
              const next = new Map(current);
              for (const [threadId, status] of next) {
                if (status === "running") next.delete(threadId);
              }
              for (const threadId of nextRunningThreadIds) {
                next.set(threadId, "running");
              }
              return next;
            });
          }
          if (
            payload.type === "thread_status" &&
            typeof payload.threadId === "string" &&
            (payload.status === "idle" ||
              payload.status === "running" ||
              payload.status === "unread")
          ) {
            const threadId = payload.threadId;
            const status = payload.status as ThreadStatus;
            setHasStatusSnapshot(true);
            setLiveThreadStatuses((current) => {
              const next = new Map(current);
              next.set(threadId, status);
              return next;
            });
            if (status === "idle" || status === "unread") {
              scheduleStatusRevalidate(threadId);
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
      socket?.close();
    };
  }, [currentWorkspace?.id, statusRevalidateEnabled, statusSocketEnabled]);

  const groups = useMemo(() => {
    const source = data?.chatGroups ?? [];
    return applyLiveRunningStatuses(
      source,
      runningThreadIds,
      hasStatusSnapshot,
      activeThreadId,
      liveThreadStatuses,
    );
  }, [
    activeThreadId,
    data?.chatGroups,
    hasStatusSnapshot,
    liveThreadStatuses,
    runningThreadIds,
  ]);

  const value = useMemo(() => ({
    groups,
    activeGroupId: getActiveGroupIdFromMatches(matches),
    runningThreadIds,
    hasStatusSnapshot,
  }), [groups, hasStatusSnapshot, matches, runningThreadIds]);

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
