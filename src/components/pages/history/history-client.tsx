'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { Thread, WorkspaceWithAccess } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { PageHeader } from '@/components/page-header';
import { ChatsToolbar } from '@/components/history/chats-toolbar';
import { ChatsList } from '@/components/history/chats-list';
import { SwitchWorkspaceDialog } from '@/components/history/switch-workspace-dialog';
import {
  deleteThread,
  getThreadsPage,
  getThreadsPageAllWorkspaces,
  updateThreadTitle,
} from '@/lib/server-actions/thread';

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
  const {
    currentOrg,
    currentWorkspace,
    workspaces,
    switchWorkspace,
    loading: authLoading,
  } = useAuth();
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'this-workspace' | 'all-workspaces'>('this-workspace');
  const [selectMode, setSelectMode] = useState<'off' | 'manual' | 'implicit'>('off');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeOrgId, setActiveOrgId] = useState(initialOrgId);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    currentWorkspace?.id ?? null
  );
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(initialOffset);
  const [limit, setLimit] = useState(initialLimit);
  const [switchDialog, setSwitchDialog] = useState<{
    open: boolean;
    threadId: string | null;
    workspace: WorkspaceWithAccess | null;
  }>({ open: false, threadId: null, workspace: null });
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const isSelecting = selectMode !== 'off';
  const hasMore = threads.length < total;
  const workspaceMap = useMemo(
    () => new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

  const fetchThreadsPage = useCallback(
    async (nextFilter: 'this-workspace' | 'all-workspaces', nextOffset: number, nextLimit: number) => {
      if (nextFilter === 'all-workspaces') {
        return getThreadsPageAllWorkspaces({ offset: nextOffset, limit: nextLimit });
      }
      return getThreadsPage({ offset: nextOffset, limit: nextLimit });
    },
    []
  );

  const refreshThreads = useCallback(async (nextFilter: 'this-workspace' | 'all-workspaces' = filter) => {
    try {
      setLoading(true);
      const page = await fetchThreadsPage(nextFilter, 0, limit);
      setThreads(Array.isArray(page.items) ? (page.items as Thread[]) : []);
      setTotal(page.total);
      setOffset(page.offset);
      setLimit(page.limit);
    } catch (error) {
      console.error('Failed to fetch threads:', error);
    } finally {
      setLoading(false);
    }
  }, [fetchThreadsPage, filter, limit]);

  useEffect(() => {
    if (currentOrg?.id && currentOrg.id !== activeOrgId) {
      setActiveOrgId(currentOrg.id);
      refreshThreads();
    }
  }, [currentOrg?.id, activeOrgId, refreshThreads]);

  useEffect(() => {
    const workspaceId = currentWorkspace?.id ?? null;
    if (workspaceId === activeWorkspaceId) return;
    setActiveWorkspaceId(workspaceId);
    if (filter === 'this-workspace' && workspaceId) {
      refreshThreads();
    }
  }, [activeWorkspaceId, currentWorkspace?.id, filter, refreshThreads]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      const nextOffset = offset + limit;
      const page = await fetchThreadsPage(filter, nextOffset, limit);
      setThreads((prev) => [...prev, ...(page.items as Thread[])]);
      setTotal(page.total);
      setOffset(page.offset);
      setLimit(page.limit);
    } catch (error) {
      console.error('Failed to load more threads:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchThreadsPage, filter, hasMore, limit, loadingMore, offset]);

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
      setFilter(value);
      setSelectedIds(new Set());
      setSelectMode('off');
      refreshThreads(value);
    },
    [refreshThreads]
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
  const handleRenameThread = async (id: string, newTitle: string) => {
    const thread = threads.find((entry) => entry.id === id);
    if (!thread) return;
    try {
      await updateThreadTitle(id, newTitle, thread.workspace_id);
      setThreads(prev => prev.map(t => t.id === id ? { ...t, title: newTitle } : t));
    } catch (error) {
      console.error('Failed to rename thread:', error);
    }
  };

  const handleDeleteThread = async (id: string) => {
    const thread = threads.find((entry) => entry.id === id);
    if (!thread) return;
    try {
      await deleteThread(id, thread.workspace_id);
      setThreads(prev => prev.filter(t => t.id !== id));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error) {
      console.error('Failed to delete thread:', error);
    }
  };

  const handleDeleteSelected = async () => {
    const idsToDelete = Array.from(selectedIds);
    await Promise.all(idsToDelete.map(id => handleDeleteThread(id)));
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

    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(switchDialog.workspace.id);
      navigate(`/chat/${switchDialog.threadId}`);
    } catch (error) {
      console.error('Failed to switch workspace:', error);
    } finally {
      setSwitchingWorkspace(false);
      setSwitchDialog({ open: false, threadId: null, workspace: null });
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
            loading={authLoading || loading}
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
    </>
  );
}
