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
import type {
  ChatGroupView,
  ThreadCompletionSummaryStatus,
  ThreadStatus,
} from "@/types";
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

export interface LiveThreadMetadata {
  status: ThreadStatus;
  completedAt?: number | null;
  summaryStatus?: ThreadCompletionSummaryStatus | null;
  summary?: string | null;
  latestUserMessage?: string | null;
  runningActivityText?: string | null;
  runningActivityAt?: number | null;
  runningStartedAt?: number | null;
}

type ThreadStatusOverlay = ThreadStatus | LiveThreadMetadata;

interface ChatGroupsContextValue {
  groups: ChatGroupView[];
  activeGroupId: string | null;
  runningThreadIds: Set<string>;
  hasStatusSnapshot: boolean;
  markThreadIdle: (threadId: string) => void;
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

function getOverlayStatus(value: ThreadStatusOverlay | undefined): ThreadStatus | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.status;
}

function getOverlayMetadata(
  value: ThreadStatusOverlay | undefined,
): LiveThreadMetadata | null {
  if (!value || typeof value === "string") return null;
  return value;
}

function mergeThreadMetadata(
  previous: LiveThreadMetadata | undefined,
  metadata: LiveThreadMetadata,
): LiveThreadMetadata {
  return {
    ...previous,
    ...metadata,
    status: metadata.status,
  };
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

export function reconcileLocalThreadStatusesWithSnapshot<T extends ThreadStatusOverlay>(
  localStatuses: Map<string, T>,
  runningThreadIds: Set<string>,
): Map<string, T> {
  let next: Map<string, T> | null = null;
  for (const [threadId, overlay] of localStatuses) {
    const status = getOverlayStatus(overlay);
    if (
      (status === "running" && !runningThreadIds.has(threadId)) ||
      (status !== "running" && runningThreadIds.has(threadId))
    ) {
      next ??= new Map(localStatuses);
      next.delete(threadId);
    }
  }
  return next ?? localStatuses;
}

export function mergeLiveAndLocalThreadStatuses(
  liveStatuses: ReadonlyMap<string, LiveThreadMetadata>,
  localStatuses: ReadonlyMap<string, LiveThreadMetadata>,
): Map<string, LiveThreadMetadata> {
  const next = new Map(liveStatuses);
  for (const [threadId, metadata] of localStatuses) {
    const liveMetadata = next.get(threadId);
    if (liveMetadata?.status === "running" && metadata.status !== "running") {
      continue;
    }
    next.set(threadId, mergeThreadMetadata(liveMetadata, metadata));
  }
  return next;
}

export function hasPendingCompletionSummaries(
  groups: readonly ChatGroupView[] | null | undefined,
): boolean {
  return Boolean(
    groups?.some((group) =>
      [...group.open_threads, ...group.closed_threads].some(
        (thread) => thread.last_assistant_summary_status === "pending",
      ),
    ),
  );
}

export function shouldRevalidateThreadStatusUpdate(
  status: ThreadStatus,
  isMetadataOnlyUpdate: boolean,
  hasSummaryMetadataUpdate: boolean,
): boolean {
  return (
    (status === "running" || status === "idle" || status === "unread") &&
    (!isMetadataOnlyUpdate || hasSummaryMetadataUpdate)
  );
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
  liveStatuses: ReadonlyMap<string, ThreadStatusOverlay>,
  localStatuses: ReadonlyMap<string, ThreadStatusOverlay>,
  runningThreadIds: Set<string>,
  activeThreadId: string | null,
): string[] {
  const threadIds = new Set<string>();
  for (const [threadId, overlay] of liveStatuses) {
    const status = getOverlayStatus(overlay);
    if (status === "running") threadIds.add(threadId);
  }
  for (const [threadId, overlay] of localStatuses) {
    const status = getOverlayStatus(overlay);
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

export function applyLiveRunningStatuses(
  source: ChatGroupView[],
  runningThreadIds: Set<string>,
  hasStatusSnapshot: boolean,
  activeThreadId: string | null = null,
  liveThreadStatuses: ReadonlyMap<string, ThreadStatusOverlay> = new Map(),
): ChatGroupView[] {
  return source.map((group) => {
    const resolveThread = (
      thread: ChatGroupView["open_threads"][number],
    ): ChatGroupView["open_threads"][number] => {
      const liveMetadata = getOverlayMetadata(liveThreadStatuses.get(thread.id));
      const liveStatus = getOverlayStatus(liveThreadStatuses.get(thread.id));
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
      const completedAt =
        typeof liveMetadata?.completedAt === "number" &&
        Number.isFinite(liveMetadata.completedAt)
          ? liveMetadata.completedAt
          : null;
      const latestUserMessage =
        liveMetadata?.latestUserMessage !== undefined
          ? liveMetadata.latestUserMessage
          : undefined;
      const runningActivityText =
        liveMetadata?.runningActivityText !== undefined
          ? liveMetadata.runningActivityText
          : undefined;
      const runningActivityAt =
        typeof liveMetadata?.runningActivityAt === "number" &&
        Number.isFinite(liveMetadata.runningActivityAt)
          ? liveMetadata.runningActivityAt
          : liveMetadata?.runningActivityAt === null
            ? null
            : undefined;
      const runningStartedAt =
        typeof liveMetadata?.runningStartedAt === "number" &&
        Number.isFinite(liveMetadata.runningStartedAt)
          ? liveMetadata.runningStartedAt
          : liveMetadata?.runningStartedAt === null
            ? null
            : undefined;
      const lastAssistantCompletedAt =
        completedAt !== null
          ? completedAt
          : thread.last_assistant_completed_at;
      const lastAssistantSummaryStatus =
        liveMetadata?.summaryStatus !== undefined
          ? liveMetadata.summaryStatus
          : thread.last_assistant_summary_status;
      const lastAssistantSummary =
        liveMetadata?.summary !== undefined
          ? liveMetadata.summary
          : thread.last_assistant_summary;
      const updatedAt =
        completedAt !== null ? Math.max(thread.updated_at, completedAt) : thread.updated_at;
      const lastActiveAt = Math.max(
        thread.last_active_at,
        updatedAt,
        lastAssistantCompletedAt ?? 0,
        resolvedStatus === "running"
          ? (runningActivityAt ?? thread.running_activity_at ?? 0)
          : 0,
        resolvedStatus === "running"
          ? (runningStartedAt ?? thread.running_started_at ?? 0)
          : 0,
      );
      return {
        ...thread,
        updated_at: updatedAt,
        is_unread: resolvedStatus === "unread",
        status: resolvedStatus,
        last_active_at: lastActiveAt,
        last_assistant_completed_at: lastAssistantCompletedAt,
        last_assistant_summary: lastAssistantSummary,
        last_assistant_summary_status: lastAssistantSummaryStatus,
        latest_user_message:
          latestUserMessage !== undefined
            ? latestUserMessage
            : thread.latest_user_message,
        running_activity_text:
          resolvedStatus === "running"
            ? runningActivityText !== undefined
              ? runningActivityText
              : thread.running_activity_text
            : null,
        running_activity_at:
          resolvedStatus === "running"
            ? runningActivityAt !== undefined
              ? runningActivityAt
              : thread.running_activity_at
            : null,
        running_started_at:
          resolvedStatus === "running"
            ? runningStartedAt !== undefined
              ? runningStartedAt
              : thread.running_started_at
            : null,
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
  const markViewedEnabled = chatDebugFlags.markViewed;
  const revalidateRef = useRef(revalidator.revalidate);
  const data = useRouteLoaderData("routes/_app") as
    | AppChatGroupsLoaderData
    | undefined;
  const matches = useMatches();
  const activeThreadId = getActiveThreadIdFromMatches(matches);
  const activeThreadIdRef = useRef(activeThreadId);
  const [liveThreadStatuses, setLiveThreadStatuses] = useState<
    Map<string, LiveThreadMetadata>
  >(
    () => new Map(),
  );
  const [localThreadStatuses, setLocalThreadStatuses] = useState<
    Map<string, LiveThreadMetadata>
  >(() => new Map());
  const liveThreadStatusesRef = useRef(liveThreadStatuses);
  const localThreadStatusesRef = useRef(localThreadStatuses);
  const hasPendingCompletionSummariesRef = useRef(false);
  const [hasStatusSnapshot, setHasStatusSnapshot] = useState(false);
  const resolvedThreadStatuses = useMemo(
    () => mergeLiveAndLocalThreadStatuses(liveThreadStatuses, localThreadStatuses),
    [liveThreadStatuses, localThreadStatuses],
  );
  const runningThreadIds = useMemo(
    () =>
      new Set(
        Array.from(resolvedThreadStatuses)
          .filter(([, metadata]) => metadata.status === "running")
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
    hasPendingCompletionSummariesRef.current = hasPendingCompletionSummaries(
      data?.chatGroups,
    );
  }, [data?.chatGroups]);

  useEffect(() => {
    if (!activeThreadId) return;
    setLiveThreadStatuses((current) => {
      const currentMetadata = current.get(activeThreadId);
      if (currentMetadata?.status !== "unread") return current;
      const next = new Map(current);
      next.set(activeThreadId, { ...currentMetadata, status: "idle" });
      return next;
    });
    setLocalThreadStatuses((current) => {
      const currentMetadata = current.get(activeThreadId);
      if (currentMetadata?.status !== "unread") return current;
      const next = new Map(current);
      next.set(activeThreadId, { ...currentMetadata, status: "idle" });
      return next;
    });
  }, [activeThreadId]);

  const markThreadIdle = useCallback((threadId: string) => {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return;
    setLocalThreadStatuses((current) => {
      const currentStatus =
        current.get(normalizedThreadId) ?? liveThreadStatuses.get(normalizedThreadId);
      const status = currentStatus?.status;
      if (status === "running" || status === "idle") {
        return current;
      }
      const next = new Map(current);
      next.set(normalizedThreadId, {
        ...(currentStatus ?? { status: "idle" as const }),
        status: "idle",
      });
      return next;
    });
  }, [liveThreadStatuses]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleLocalThreadStatus = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const payload = detail as {
        threadId?: unknown;
        status?: unknown;
        latestUserMessage?: unknown;
        runningActivityText?: unknown;
        runningActivityAt?: unknown;
        runningStartedAt?: unknown;
      };
      if (
        typeof payload.threadId !== "string" ||
        (payload.status !== "idle" && payload.status !== "running")
      ) {
        return;
      }
      const threadId = payload.threadId;
      const status = payload.status;
      const latestUserMessage =
        typeof payload.latestUserMessage === "string"
          ? payload.latestUserMessage
          : payload.latestUserMessage === null
            ? null
            : undefined;
      const runningActivityText =
        typeof payload.runningActivityText === "string"
          ? payload.runningActivityText
          : payload.runningActivityText === null
            ? null
            : undefined;
      const runningActivityAt =
        typeof payload.runningActivityAt === "number" &&
        Number.isFinite(payload.runningActivityAt)
          ? payload.runningActivityAt
          : payload.runningActivityAt === null
            ? null
            : undefined;
      const runningStartedAt =
        typeof payload.runningStartedAt === "number" &&
        Number.isFinite(payload.runningStartedAt)
          ? payload.runningStartedAt
          : payload.runningStartedAt === null
            ? null
            : undefined;
      if (
        markViewedEnabled &&
        shouldMarkActiveIdleThreadViewed(status, threadId, activeThreadIdRef.current)
      ) {
        void fetch(`/api/threads/${encodeURIComponent(threadId)}/mark-viewed`, {
          method: "POST",
        }).catch(() => {});
      }

      setLocalThreadStatuses((current) => {
        const existing = current.get(threadId);
        if (
          existing?.status === status &&
          (latestUserMessage === undefined ||
            existing.latestUserMessage === latestUserMessage) &&
          (runningActivityText === undefined ||
            existing.runningActivityText === runningActivityText) &&
          (runningActivityAt === undefined ||
            existing.runningActivityAt === runningActivityAt) &&
          (runningStartedAt === undefined ||
            existing.runningStartedAt === runningStartedAt)
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(
          threadId,
          mergeThreadMetadata(existing, {
            status,
            ...(latestUserMessage === undefined ? {} : { latestUserMessage }),
            ...(runningActivityText === undefined ? {} : { runningActivityText }),
            ...(runningActivityAt === undefined ? {} : { runningActivityAt }),
            ...(runningStartedAt === undefined ? {} : { runningStartedAt }),
          }),
        );
        return next;
      });
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
      setHasStatusSnapshot(false);
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = `${protocol}//${window.location.host}/ws/workspaces/${encodeURIComponent(workspaceId)}/status`;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let revalidateTimer: number | null = null;
    let closedByEffect = false;

    const scheduleStatusRevalidate = (
      threadId: string,
      options: { includeActive?: boolean } = {},
    ) => {
      if (!statusRevalidateEnabled) return;
      if (!options.includeActive && threadId === activeThreadIdRef.current) return;
      if (revalidateTimer !== null) return;
      revalidateTimer = window.setTimeout(() => {
        revalidateTimer = null;
        revalidateRef.current();
      }, 750);
    };
    const scheduleStatusSnapshotRevalidate = () => {
      if (!statusRevalidateEnabled) return;
      if (revalidateTimer !== null) return;
      revalidateTimer = window.setTimeout(() => {
        revalidateTimer = null;
        revalidateRef.current();
      }, 750);
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
            runningThreads?: unknown;
            threadId?: unknown;
            status?: unknown;
            completedAt?: unknown;
            summaryStatus?: unknown;
            summary?: unknown;
            runningActivityText?: unknown;
            runningActivityAt?: unknown;
            runningStartedAt?: unknown;
          };
          if (
            payload.type === "thread_status_snapshot" &&
            (Array.isArray(payload.runningThreadIds) ||
              Array.isArray(payload.runningThreads))
          ) {
            setHasStatusSnapshot(true);
            const fallbackRunningThreadIds = Array.isArray(payload.runningThreadIds)
              ? payload.runningThreadIds.filter(
                  (threadId): threadId is string => typeof threadId === "string",
                )
              : [];
            type RunningThreadSnapshot = {
              threadId: string;
              runningActivityText?: string | null;
              runningActivityAt?: number | null;
              runningStartedAt?: number | null;
            };
            const parsedRunningThreads: RunningThreadSnapshot[] = Array.isArray(payload.runningThreads)
              ? payload.runningThreads.flatMap((entry) => {
                  if (!entry || typeof entry !== "object") return [];
                  const record = entry as {
                    threadId?: unknown;
                    startedAt?: unknown;
                    runningActivityText?: unknown;
                    latestActivityText?: unknown;
                    runningActivityAt?: unknown;
                    latestActivityAt?: unknown;
                  };
                  if (typeof record.threadId !== "string") return [];
                  const runningActivityText =
                    typeof record.runningActivityText === "string"
                      ? record.runningActivityText
                      : typeof record.latestActivityText === "string"
                        ? record.latestActivityText
                        : record.runningActivityText === null ||
                            record.latestActivityText === null
                          ? null
                          : undefined;
                  const runningActivityAt =
                    typeof record.runningActivityAt === "number" &&
                    Number.isFinite(record.runningActivityAt)
                      ? record.runningActivityAt
                      : typeof record.latestActivityAt === "number" &&
                          Number.isFinite(record.latestActivityAt)
                        ? record.latestActivityAt
                        : record.runningActivityAt === null ||
                            record.latestActivityAt === null
                          ? null
                          : undefined;
                  const runningStartedAt =
                    typeof record.startedAt === "number" &&
                    Number.isFinite(record.startedAt)
                      ? record.startedAt
                      : undefined;
                  return [
                    {
                      threadId: record.threadId,
                      runningActivityText,
                      runningActivityAt,
                      runningStartedAt,
                    },
                  ];
                })
              : [];
            const nextRunningThreads: RunningThreadSnapshot[] =
              parsedRunningThreads.length > 0
                ? parsedRunningThreads
                : fallbackRunningThreadIds.map((threadId) => ({ threadId }));
            const nextRunningThreadIds = nextRunningThreads.map(
              (thread) => thread.threadId,
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
              const next = new Map(current);
              for (const [threadId, metadata] of next) {
                if (metadata.status === "running") next.delete(threadId);
              }
              for (const thread of nextRunningThreads) {
                next.set(thread.threadId, {
                  status: "running",
                  ...(thread.runningActivityText === undefined
                    ? {}
                    : { runningActivityText: thread.runningActivityText }),
                  ...(thread.runningActivityAt === undefined
                    ? {}
                    : { runningActivityAt: thread.runningActivityAt }),
                  ...(thread.runningStartedAt === undefined
                    ? {}
                    : { runningStartedAt: thread.runningStartedAt }),
                });
              }
              return next;
            });
            setLocalThreadStatuses((current) =>
              reconcileLocalThreadStatusesWithSnapshot(
                current,
                nextRunningThreadIdSet,
              ),
            );
            if (staleRunningThreadIds.length > 0) {
              scheduleStatusRevalidate(staleRunningThreadIds[0]);
            } else if (hasPendingCompletionSummariesRef.current) {
              scheduleStatusSnapshotRevalidate();
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
            const completedAt =
              typeof payload.completedAt === "number" &&
              Number.isFinite(payload.completedAt)
                ? payload.completedAt
                : undefined;
            const summaryStatus =
              payload.summaryStatus === "pending" ||
              payload.summaryStatus === "ready" ||
              payload.summaryStatus === "failed"
                ? payload.summaryStatus
                : undefined;
            const summary =
              typeof payload.summary === "string"
                ? payload.summary
                : payload.summary === null
                  ? null
                  : undefined;
            const runningActivityText =
              typeof payload.runningActivityText === "string"
                ? payload.runningActivityText
                : payload.runningActivityText === null
                  ? null
                  : undefined;
            const runningActivityAt =
              typeof payload.runningActivityAt === "number" &&
              Number.isFinite(payload.runningActivityAt)
                ? payload.runningActivityAt
                : payload.runningActivityAt === null
                  ? null
                  : undefined;
            const runningStartedAt =
              typeof payload.runningStartedAt === "number" &&
              Number.isFinite(payload.runningStartedAt)
                ? payload.runningStartedAt
                : payload.runningStartedAt === null
                  ? null
                  : undefined;
            const existingMetadata =
              localThreadStatusesRef.current.get(threadId) ??
              liveThreadStatusesRef.current.get(threadId);
            const hasMetadataOnlyUpdate =
              summaryStatus !== undefined ||
              summary !== undefined ||
              runningActivityText !== undefined ||
              runningActivityAt !== undefined ||
              runningStartedAt !== undefined;
            const hasSummaryMetadataUpdate =
              summaryStatus !== undefined || summary !== undefined;
            const isMetadataOnlyUpdate =
              hasMetadataOnlyUpdate &&
              existingMetadata?.status === status &&
              (completedAt === undefined ||
                existingMetadata.completedAt === completedAt);
            setHasStatusSnapshot(true);
            setLiveThreadStatuses((current) => {
              const next = new Map(current);
              next.set(
                threadId,
                mergeThreadMetadata(current.get(threadId), {
                  status,
                  ...(completedAt === undefined ? {} : { completedAt }),
                  ...(summaryStatus === undefined ? {} : { summaryStatus }),
                  ...(summary === undefined ? {} : { summary }),
                  ...(runningActivityText === undefined ? {} : { runningActivityText }),
                  ...(runningActivityAt === undefined ? {} : { runningActivityAt }),
                  ...(runningStartedAt === undefined ? {} : { runningStartedAt }),
                }),
              );
              return next;
            });
            setLocalThreadStatuses((current) => {
              const existing = current.get(threadId);
              if (
                existing?.status === status &&
                (completedAt === undefined || existing.completedAt === completedAt) &&
                (summaryStatus === undefined || existing.summaryStatus === summaryStatus) &&
                (summary === undefined || existing.summary === summary) &&
                (runningActivityText === undefined ||
                  existing.runningActivityText === runningActivityText) &&
                (runningActivityAt === undefined ||
                  existing.runningActivityAt === runningActivityAt) &&
                (runningStartedAt === undefined ||
                  existing.runningStartedAt === runningStartedAt)
              ) {
                return current;
              }
              const next = new Map(current);
              next.set(
                threadId,
                mergeThreadMetadata(existing, {
                  status,
                  ...(completedAt === undefined ? {} : { completedAt }),
                  ...(summaryStatus === undefined ? {} : { summaryStatus }),
                  ...(summary === undefined ? {} : { summary }),
                  ...(runningActivityText === undefined ? {} : { runningActivityText }),
                  ...(runningActivityAt === undefined ? {} : { runningActivityAt }),
                  ...(runningStartedAt === undefined ? {} : { runningStartedAt }),
                }),
              );
              return next;
            });
            if (
              shouldRevalidateThreadStatusUpdate(
                status,
                isMetadataOnlyUpdate,
                hasSummaryMetadataUpdate,
              )
            ) {
              scheduleStatusRevalidate(threadId, {
                includeActive: hasSummaryMetadataUpdate,
              });
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
    );
  }, [
    activeThreadId,
    data?.chatGroups,
    hasStatusSnapshot,
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
