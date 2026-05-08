'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams, useRevalidator, useFetcher } from 'react-router';
import { toast } from 'sonner';
import type { Thread, ThreadCreator, WorkspaceWithAccess } from '@/types';
import { useAuthData } from '@/hooks/use-auth-data';
import { useSwitchWorkspace } from '@/hooks/use-auth-actions';
import { PageHeader } from '@/components/page-header';
import { ChatsToolbar } from '@/components/history/chats-toolbar';
import { ChatsList } from '@/components/history/chats-list';
import { SwitchWorkspaceDialog } from '@/components/history/switch-workspace-dialog';
import { ContainerLoadingDialog } from '@/components/container-loading-dialog';

// Note: Auth is handled by the (app) layout - no need to check here

const PAGE_SIZE = 50;

interface HistoryPageResponse {
  threads: Thread[];
  total: number;
  offset: number;
  limit: number;
  queryKey: string;
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
  const isSelecting = selectMode !== 'off';
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

  useEffect(() => {
    setAllThreads(initialThreads);
    setCurrentOffset(initialOffset + initialThreads.length);
    setTotal(initialTotal);
  }, [initialQueryKey, initialThreads, initialOffset, initialTotal]);

  useEffect(() => {
    if (!loadFetcher.data?.threads || loadFetcher.data.queryKey !== initialQueryKey) {
      return;
    }

    setAllThreads((prev) => {
      const existingIds = new Set(prev.map((thread) => thread.id));
      const nextThreads = loadFetcher.data!.threads.filter(
        (thread) => !existingIds.has(thread.id)
      );
      return [...prev, ...nextThreads];
    });
    setCurrentOffset(loadFetcher.data.offset + loadFetcher.data.threads.length);
    setTotal(loadFetcher.data.total);
  }, [loadFetcher.data]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) {
      return;
    }

    if (scope === 'this-workspace' && !currentWorkspace?.id) {
      return;
    }

    const params = new URLSearchParams({
      offset: String(currentOffset),
      limit: String(initialLimit || PAGE_SIZE),
      scope,
    });
    if (scope === 'this-workspace' && currentWorkspace?.id) {
      params.set('workspaceId', currentWorkspace.id);
    }
    if (activeCreatorId) {
      params.set('createdBy', activeCreatorId);
    }
    params.set('queryKey', initialQueryKey);
    loadFetcher.load(`/api/history?${params.toString()}`);
  }, [
    activeCreatorId,
    currentOffset,
    currentWorkspace?.id,
    hasMore,
    initialLimit,
    initialQueryKey,
    loadFetcher,
    loading,
    loadingMore,
    scope,
  ]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loadingMore || loading) return;

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
  }, [hasMore, loadMore, loading, loadingMore]);

  // Filter threads by search query
  const filteredThreads = useMemo(
    () =>
      allThreads.filter((thread) =>
        thread.title.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [allThreads, searchQuery]
  );
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

  useEffect(() => {
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
    if (selectedIds.size === filteredThreads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredThreads.map((thread) => thread.id)));
    }
  }, [enterSelectMode, filteredThreads, selectedIds.size]);

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

  const openThreadAsNewGroup = useCallback(async (id: string) => {
    try {
      const response = await fetch("/api/chat-groups/move-thread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: id, targetGroupId: "new" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as
          | { error?: string }
          | null;
        toast.error(payload?.error ?? "Failed to open chat");
        return false;
      }
      navigate(`/chat/${id}`);
      return true;
    } catch (error) {
      console.error("Failed to open history thread as a new group:", error);
      toast.error("Failed to open chat");
      return false;
    }
  }, [navigate]);

  const handleOpenThread = useCallback((id: string) => {
    const thread = allThreads.find((entry) => entry.id === id);
    if (!thread) return;

    if (!currentWorkspace || thread.workspace_id === currentWorkspace.id) {
      void openThreadAsNewGroup(id);
      return;
    }

    const targetWorkspace = workspaceMap.get(thread.workspace_id);
    if (!targetWorkspace) {
      void openThreadAsNewGroup(id);
      return;
    }

    setSwitchDialog({ open: true, threadId: id, workspace: targetWorkspace });
  }, [allThreads, currentWorkspace, openThreadAsNewGroup, workspaceMap]);

  const handleConfirmSwitch = async () => {
    if (!switchDialog.workspace || !switchDialog.threadId) return;
    const targetWorkspace = switchDialog.workspace;
    const targetThreadId = switchDialog.threadId;

    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(targetWorkspace.id);
      setSwitchDialog({ open: false, threadId: null, workspace: null });
      setContainerDialog({ open: true, workspace: targetWorkspace });
      await openThreadAsNewGroup(targetThreadId);
    } catch (error) {
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
            totalCount={searchQuery ? filteredThreads.length : total}
            isSelecting={isSelecting}
            selectedCount={selectedIds.size}
            allSelected={selectedIds.size === filteredThreads.length && filteredThreads.length > 0}
            onEnterSelectMode={() => setSelectMode('manual')}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onDeleteSelected={handleDeleteSelected}
          />

          {/* Scrollable List */}
          <ChatsList
            threads={filteredThreads}
            loading={loading}
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
