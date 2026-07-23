'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams, useRevalidator, useFetcher } from 'react-router';
import type { Thread, ThreadCreator, WorkspaceWithAccess } from '@/types';
import { useAuthData } from '@/hooks/use-auth-data';
import {
  isWorkspaceSwitchSupersededError,
  useSwitchWorkspace,
} from '@/hooks/use-auth-actions';
import { PageHeader } from '@/components/page-header';
import { ChatsToolbar } from '@/components/history/chats-toolbar';
import { ChatsList } from '@/components/history/chats-list';
import { SwitchWorkspaceDialog } from '@/components/history/switch-workspace-dialog';
import { ContainerLoadingDialog } from '@/components/container-loading-dialog';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { canonicalizeThreadSearchQuery } from '@/lib/thread-search';

// Note: Auth is handled by the (app) layout - no need to check here

const PAGE_SIZE = 50;

interface HistoryPageResponse {
  threads: Thread[];
  total: number;
  offset: number;
  limit: number;
  queryKey: string;
  q?: string;
}

function getHistoryScope(searchParams: URLSearchParams): 'this-workspace' | 'all-workspaces' {
  const scope = searchParams.get('scope') ?? searchParams.get('filter');
  return scope === 'all-workspaces' ? 'all-workspaces' : 'this-workspace';
}

interface HistoryClientProps {
  initialThreads: Thread[];
  initialTotal: number;
  initialOffset: number;
  initialLimit: number;
  threadCreators: ThreadCreator[];
  currentUserId: string;
  initialQueryKey: string;
}

export default function HistoryClient({
  initialThreads,
  initialTotal,
  initialOffset,
  initialLimit,
  threadCreators,
  currentUserId,
  initialQueryKey,
}: HistoryClientProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state: revalidatorState, revalidate } = useRevalidator();
  const actionFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const loadFetcher = useFetcher<HistoryPageResponse>();
  const {
    user,
    currentOrg,
    currentWorkspace,
    workspaces,
  } = useAuthData();
  const { switchWorkspace } = useSwitchWorkspace();

  const scope = getHistoryScope(searchParams);
  const activeCreatorId = searchParams.get('createdBy')?.trim() || null;

  const [searchQuery, setSearchQuery] = useState('');
  const effectiveQuery = canonicalizeThreadSearchQuery(
    useDebouncedValue(searchQuery, 250),
  );
  const [listQuery, setListQuery] = useState('');
  const [listQueryKey, setListQueryKey] = useState(initialQueryKey);
  const [allThreads, setAllThreads] = useState(initialThreads);
  const [total, setTotal] = useState(initialTotal);
  const [currentOffset, setCurrentOffset] = useState(initialOffset + initialThreads.length);
  const [selectMode, setSelectMode] = useState<'off' | 'manual' | 'implicit'>('off');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [switchDialog, setSwitchDialog] = useState<{
    open: boolean;
    threadId: string | null;
    workspace: WorkspaceWithAccess | null;
  }>({ open: false, threadId: null, workspace: null });
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [containerDialog, setContainerDialog] = useState<{
    open: boolean;
    workspace: WorkspaceWithAccess | null;
  }>({ open: false, workspace: null });
  const previousOrgIdRef = useRef<string | null | undefined>(undefined);
  const previousWorkspaceIdRef = useRef<string | null | undefined>(undefined);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const seenHistoryResponsesRef = useRef(
    new WeakSet<HistoryPageResponse>(),
  );
  const isSelecting = selectMode !== 'off';
  const searchPending =
    effectiveQuery !== listQuery || initialQueryKey !== listQueryKey;
  const hasMore = allThreads.length < total;
  const loading = revalidatorState === 'loading' && allThreads.length === 0;
  const loadingMore = loadFetcher.state !== 'idle';
  const workspaceMap = useMemo(
    () => new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

  // Revalidate only after an actual org/workspace switch, not on initial mount.
  useEffect(() => {
    const nextOrgId = currentOrg?.id;
    const nextWorkspaceId = currentWorkspace?.id;

    if (
      previousOrgIdRef.current === undefined &&
      previousWorkspaceIdRef.current === undefined
    ) {
      previousOrgIdRef.current = nextOrgId;
      previousWorkspaceIdRef.current = nextWorkspaceId;
      return;
    }

    const orgChanged = previousOrgIdRef.current !== nextOrgId;
    const workspaceChanged = previousWorkspaceIdRef.current !== nextWorkspaceId;

    previousOrgIdRef.current = nextOrgId;
    previousWorkspaceIdRef.current = nextWorkspaceId;

    if (orgChanged || workspaceChanged) {
      revalidate();
    }
  }, [currentOrg?.id, currentWorkspace?.id, revalidate]);

  const buildPageParams = useCallback((offset: number) => {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(initialLimit || PAGE_SIZE),
      scope,
      queryKey: initialQueryKey,
    });
    if (scope === 'this-workspace' && currentWorkspace?.id) {
      params.set('workspaceId', currentWorkspace.id);
    }
    if (activeCreatorId) {
      params.set('createdBy', activeCreatorId);
    }
    if (effectiveQuery) {
      params.set('q', effectiveQuery);
    }
    return params;
  }, [
    activeCreatorId,
    currentWorkspace?.id,
    effectiveQuery,
    initialLimit,
    initialQueryKey,
    scope,
  ]);

  const loadHistoryPage = loadFetcher.load;

  useEffect(() => {
    if (!effectiveQuery) {
      setAllThreads(initialThreads);
      const visibleIds = new Set(initialThreads.map((thread) => thread.id));
      setSelectedIds((previous) => {
        const next = new Set(
          Array.from(previous).filter((id) => visibleIds.has(id)),
        );
        return next.size === previous.size ? previous : next;
      });
      setCurrentOffset(initialOffset + initialThreads.length);
      setTotal(initialTotal);
      setListQuery('');
      setListQueryKey(initialQueryKey);
      return;
    }

    loadHistoryPage(`/api/history?${buildPageParams(0).toString()}`);
  }, [
    buildPageParams,
    effectiveQuery,
    initialOffset,
    initialQueryKey,
    initialThreads,
    initialTotal,
    loadHistoryPage,
  ]);

  useEffect(() => {
    const data = loadFetcher.data;
    // React Router retains fetcher.data between loads. Mark every payload as
    // seen before validating it so later query changes cannot reprocess it.
    if (!data || seenHistoryResponsesRef.current.has(data)) {
      return;
    }
    seenHistoryResponsesRef.current.add(data);

    if (!data.threads || data.queryKey !== initialQueryKey) {
      return;
    }
    if ((data.q ?? '') !== effectiveQuery) return;

    if (data.offset === 0) {
      setAllThreads(data.threads);
      const visibleIds = new Set(data.threads.map((thread) => thread.id));
      setSelectedIds((previous) => {
        const next = new Set(
          Array.from(previous).filter((id) => visibleIds.has(id)),
        );
        return next.size === previous.size ? previous : next;
      });
    } else {
      setAllThreads((prev) => {
        const existingIds = new Set(prev.map((thread) => thread.id));
        const nextThreads = data.threads.filter(
          (thread) => !existingIds.has(thread.id)
        );
        return [...prev, ...nextThreads];
      });
    }
    setCurrentOffset(data.offset + data.threads.length);
    setTotal(data.total);
    setListQuery(data.q ?? '');
    setListQueryKey(data.queryKey);
  }, [effectiveQuery, initialQueryKey, loadFetcher.data]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || searchPending || !hasMore) {
      return;
    }

    if (scope === 'this-workspace' && !currentWorkspace?.id) {
      return;
    }

    loadHistoryPage(`/api/history?${buildPageParams(currentOffset).toString()}`);
  }, [
    buildPageParams,
    currentOffset,
    currentWorkspace?.id,
    hasMore,
    loadHistoryPage,
    loading,
    loadingMore,
    searchPending,
    scope,
  ]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loadingMore || loading || searchPending) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { root: scrollViewportRef.current, rootMargin: '200px' }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loading, loadingMore, searchPending]);
  const hasActiveCreator = useMemo(
    () => threadCreators.some((creator) => creator.userId === activeCreatorId),
    [activeCreatorId, threadCreators]
  );

  const handleScopeChange = useCallback(
    (value: 'this-workspace' | 'all-workspaces') => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('scope', value);
      nextParams.delete('filter');
      setSearchParams(nextParams);
      setSelectedIds(new Set());
      setSelectMode('off');
    },
    [searchParams, setSearchParams]
  );

  useLayoutEffect(() => {
    if (!activeCreatorId || hasActiveCreator) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('createdBy');
    nextParams.delete('filter');
    setSearchParams(nextParams);
    setSelectedIds(new Set());
    setSelectMode('off');
  }, [activeCreatorId, hasActiveCreator, searchParams, setSearchParams]);

  const handleCreatorChange = useCallback(
    (userId: string | null) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('filter');
      if (userId) {
        nextParams.set('createdBy', userId);
      } else {
        nextParams.delete('createdBy');
      }
      setSearchParams(nextParams);
      setSelectedIds(new Set());
      setSelectMode('off');
    },
    [searchParams, setSearchParams]
  );

  const enterSelectMode = useCallback((mode: 'manual' | 'implicit') => {
    setSelectMode((prev) => (prev === 'manual' ? prev : mode));
  }, []);

  useEffect(() => {
    if (selectedIds.size === 0 && selectMode === 'implicit') {
      setSelectMode('off');
    }
  }, [selectedIds, selectMode]);

  // Selection handlers
  const handleToggleSelect = useCallback((id: string) => {
    enterSelectMode('implicit');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [enterSelectMode]);

  const handleSelectAll = useCallback(() => {
    enterSelectMode('implicit');
    if (selectedIds.size === allThreads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allThreads.map((thread) => thread.id)));
    }
  }, [allThreads, enterSelectMode, selectedIds.size]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectMode('off');
  }, []);

  const handleEnterSelectMode = useCallback(() => {
    enterSelectMode('implicit');
  }, [enterSelectMode]);

  // Thread actions
  const handleRenameThread = useCallback((id: string, newTitle: string) => {
    const thread = allThreads.find((entry) => entry.id === id);
    if (!thread) return;
    actionFetcher.submit(
      {
        intent: 'renameThread',
        threadId: id,
        workspaceId: thread.workspace_id,
        title: newTitle,
      },
      { method: 'POST' }
    );
  }, [actionFetcher, allThreads]);

  const handleDeleteThread = useCallback((id: string) => {
    const thread = allThreads.find((entry) => entry.id === id);
    if (!thread) return;
    actionFetcher.submit(
      {
        intent: 'deleteThread',
        threadId: id,
        workspaceId: thread.workspace_id,
      },
      { method: 'POST' }
    );
    setAllThreads((prev) => prev.filter((entry) => entry.id !== id));
    setTotal((prev) => Math.max(0, prev - 1));
    setCurrentOffset((prev) => Math.max(0, prev - 1));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [actionFetcher, allThreads]);

  const handleDeleteSelected = useCallback(() => {
    const idsToDelete = Array.from(selectedIds);
    idsToDelete.forEach((id) => handleDeleteThread(id));
    handleClearSelection();
  }, [handleClearSelection, handleDeleteThread, selectedIds]);

  const openHistoryThread = useCallback(async (id: string) => {
    navigate(`/chat/${id}`);
    return true;
  }, [navigate]);

  const handleOpenThread = useCallback((id: string) => {
    const thread = allThreads.find((entry) => entry.id === id);
    if (!thread) return;

    if (!currentWorkspace || thread.workspace_id === currentWorkspace.id) {
      void openHistoryThread(id);
      return;
    }

    const targetWorkspace = workspaceMap.get(thread.workspace_id);
    if (!targetWorkspace) {
      void openHistoryThread(id);
      return;
    }

    setSwitchDialog({ open: true, threadId: id, workspace: targetWorkspace });
  }, [allThreads, currentWorkspace, openHistoryThread, workspaceMap]);

  const handleConfirmSwitch = async () => {
    if (!switchDialog.workspace || !switchDialog.threadId) return;
    const targetWorkspace = switchDialog.workspace;
    const targetThreadId = switchDialog.threadId;

    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(targetWorkspace.id);
      setSwitchDialog({ open: false, threadId: null, workspace: null });
      setContainerDialog({ open: true, workspace: targetWorkspace });
      await openHistoryThread(targetThreadId);
    } catch (error) {
      if (isWorkspaceSwitchSupersededError(error)) return;
      console.error('Failed to switch workspace:', error);
    } finally {
      setSwitchingWorkspace(false);
    }
  };

  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Chat History' }]} />

      {/* Main Content Wrapper */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="max-w-4xl mx-auto w-full flex-1 min-h-0 flex flex-col px-4 md:px-6">
          {/* Toolbar */}
          <ChatsToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            scope={scope}
            onScopeChange={handleScopeChange}
            creators={threadCreators}
            currentUser={user}
            currentUserId={currentUserId}
            activeCreatorId={activeCreatorId}
            onCreatorChange={handleCreatorChange}
            totalCount={total}
            isSelecting={isSelecting}
            selectedCount={selectedIds.size}
            allSelected={selectedIds.size === allThreads.length && allThreads.length > 0}
            onEnterSelectMode={() => setSelectMode('manual')}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onDeleteSelected={handleDeleteSelected}
          />

          {/* Scrollable List */}
          <ChatsList
            threads={allThreads}
            loading={loading || searchPending}
            searchActive={listQuery !== ''}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onOpenThread={handleOpenThread}
            onRenameThread={handleRenameThread}
            onDeleteThread={handleDeleteThread}
            onEnterSelectMode={handleEnterSelectMode}
            hideCreator={activeCreatorId !== null}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loadMoreRef={loadMoreRef}
            scrollViewportRef={scrollViewportRef}
            workspaceMap={workspaceMap}
            currentWorkspaceId={currentWorkspace?.id ?? null}
            showWorkspaceBadges={scope === 'all-workspaces'}
          />
        </div>
      </div>

      {switchDialog.workspace ? (
        <SwitchWorkspaceDialog
          open={switchDialog.open}
          onOpenChange={(open) => {
            if (!open) {
              setSwitchDialog({ open: false, threadId: null, workspace: null });
            }
          }}
          workspace={switchDialog.workspace}
          onConfirm={handleConfirmSwitch}
          loading={switchingWorkspace}
        />
      ) : null}

      {containerDialog.workspace ? (
        <ContainerLoadingDialog
          open={containerDialog.open}
          onOpenChange={(open) => {
            if (!open) {
              setContainerDialog({ open: false, workspace: null });
            }
          }}
          workspace={containerDialog.workspace}
          title="Starting workspace..."
          description="We're spinning up the {workspace} container to open this chat. This can take up to 20 seconds."
          statusLabel="Warming container..."
        />
      ) : null}
    </>
  );
}
