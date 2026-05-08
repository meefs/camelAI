"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMatches, useRouteLoaderData } from "react-router";
import type { ChatGroupView } from "@/types";
import { useAuthData } from "@/hooks/use-auth-data";
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
): ChatGroupView[] {
  return source.map((group) => {
    const resolveThread = (
      thread: ChatGroupView["open_threads"][number],
    ): ChatGroupView["open_threads"][number] => {
      const status = runningThreadIds.has(thread.id)
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
  const data = useRouteLoaderData("routes/_app") as
    | AppChatGroupsLoaderData
    | undefined;
  const matches = useMatches();
  const [runningThreadIds, setRunningThreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hasStatusSnapshot, setHasStatusSnapshot] = useState(false);

  useEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!workspaceId || typeof window === "undefined") {
      setRunningThreadIds(new Set());
      setHasStatusSnapshot(false);
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = `${protocol}//${window.location.host}/ws/workspaces/${encodeURIComponent(workspaceId)}/status`;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closedByEffect = false;

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
            setRunningThreadIds(
              new Set(
                payload.runningThreadIds.filter(
                  (threadId): threadId is string => typeof threadId === "string",
                ),
              ),
            );
          }
          if (
            payload.type === "thread_status" &&
            typeof payload.threadId === "string"
          ) {
            setRunningThreadIds((current) => {
              const next = new Set(current);
              if (payload.status === "running") {
                next.add(payload.threadId as string);
              } else {
                next.delete(payload.threadId as string);
              }
              return next;
            });
          }
        } catch {
          // Ignore malformed status frames.
        }
      });

      nextSocket.addEventListener("close", () => {
        if (closedByEffect || socket !== nextSocket) return;
        setHasStatusSnapshot(false);
        setRunningThreadIds(new Set());
        reconnectTimer = window.setTimeout(connect, 1000);
      });
      nextSocket.addEventListener("error", () => {
        if (socket !== nextSocket) return;
        setHasStatusSnapshot(false);
        setRunningThreadIds(new Set());
        nextSocket.close();
      });
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [currentWorkspace?.id]);

  const groups = useMemo(() => {
    const source = data?.chatGroups ?? [];
    return applyLiveRunningStatuses(
      source,
      runningThreadIds,
      hasStatusSnapshot,
      getActiveThreadIdFromMatches(matches),
    );
  }, [data?.chatGroups, hasStatusSnapshot, matches, runningThreadIds]);

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
