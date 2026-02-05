'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams, useRevalidator, useFetcher } from 'react-router';
import type { Thread, WorkspaceWithAccess } from '@/types';
import { useAuthData } from '@/hooks/use-auth-data';
import { useSwitchWorkspace } from '@/hooks/use-auth-actions';
import { PageHeader } from '@/components/page-header';
import { ChatsToolbar } from '@/components/history/chats-toolbar';
import { ChatsList } from '@/components/history/chats-list';
import { SwitchWorkspaceDialog } from '@/components/history/switch-workspace-dialog';
import { ContainerLoadingDialog } from '@/components/container-loading-dialog';

// Note: Auth is handled by the (app) layout - no need to check here

interface HistoryClientProps {
  initialThreads: Thread[];
  initialOrgId: string;
  initialTotal: number;
  initialOffset: number;
  initialLimit: number;
}

export default function HistoryClient({
  initialThreads,
  initialOrgId,
  initialTotal,
  initialOffset,
  initialLimit,
}: HistoryClientProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const {
    currentOrg,
    currentWorkspace,
    workspaces,
  } = useAuthData();
  const { switchWorkspace } = useSwitchWorkspace();

  const filter = (searchParams.get('filter') as 'this-workspace' | 'all-workspaces') || 'this-workspace';
  const threads = initialThreads;
  const total = initialTotal;
  const offset = initialOffset;
  const limit = initialLimit;

  const [searchQuery, setSearchQuery] = useState('');
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
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const isSelecting = selectMode !== 'off';
  const hasMore = threads.length < total;
  const loading = revalidator.state === 'loading';
  const loadingMore = false; // TODO: Implement load more with URL params
  const workspaceMap = useMemo(
    () => new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

  // Revalidate when org or workspace changes
  useEffect(() => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
    }
  }, [currentOrg?.id, currentWorkspace?.id]);

  const loadMore = useCallback(() => {
    // TODO: Implement pagination with URL params
  }, []);

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
  const filteredThreads = threads.filter(thread =>
    thread.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFilterChange = useCallback(
    (value: 'this-workspace' | 'all-workspaces') => {
      setSearchParams({ filter: value });
      setSelectedIds(new Set());
      setSelectMode('off');
    },
    [setSearchParams]
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
  const handleToggleSelect = (id: string) => {
    enterSelectMode('implicit');
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    enterSelectMode('implicit');
    if (selectedIds.size === filteredThreads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredThreads.map(t => t.id)));
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setSelectMode('off');
  };

  const handleEnterSelectMode = () => {
    enterSelectMode('implicit');
  };

  // Thread actions
  const handleRenameThread = (id: string, newTitle: string) => {
    const thread = threads.find((entry) => entry.id === id);
    if (!thread) return;
    fetcher.submit(
      {
        intent: 'renameThread',
        threadId: id,
        workspaceId: thread.workspace_id,
        title: newTitle,
      },
      { method: 'POST' }
    );
  };

  const handleDeleteThread = (id: string) => {
    const thread = threads.find((entry) => entry.id === id);
    if (!thread) return;
    fetcher.submit(
      {
        intent: 'deleteThread',
        threadId: id,
        workspaceId: thread.workspace_id,
      },
      { method: 'POST' }
    );
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleDeleteSelected = () => {
    const idsToDelete = Array.from(selectedIds);
    idsToDelete.forEach(id => handleDeleteThread(id));
    handleClearSelection();
  };

  const handleOpenThread = (id: string) => {
    const thread = threads.find((entry) => entry.id === id);
    if (!thread) return;

    if (!currentWorkspace || thread.workspace_id === currentWorkspace.id) {
      navigate(`/chat/${id}`);
      return;
    }

    const targetWorkspace = workspaceMap.get(thread.workspace_id);
    if (!targetWorkspace) {
      navigate(`/chat/${id}`);
      return;
    }

    setSwitchDialog({ open: true, threadId: id, workspace: targetWorkspace });
  };

  const handleConfirmSwitch = async () => {
    if (!switchDialog.workspace || !switchDialog.threadId) return;
    const targetWorkspace = switchDialog.workspace;
    const targetThreadId = switchDialog.threadId;

    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(targetWorkspace.id);
      setSwitchDialog({ open: false, threadId: null, workspace: null });
      setContainerDialog({ open: true, workspace: targetWorkspace });
      navigate(`/chat/${targetThreadId}`);
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
            filter={filter}
            onFilterChange={handleFilterChange}
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
            hasMore={hasMore}
            loadingMore={loadingMore}
            loadMoreRef={loadMoreRef}
            scrollViewportRef={scrollViewportRef}
            workspaceMap={workspaceMap}
            currentWorkspaceId={currentWorkspace?.id ?? null}
            showWorkspaceBadges={filter === 'all-workspaces'}
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
