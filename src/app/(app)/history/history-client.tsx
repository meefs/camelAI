'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Thread } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { PageHeader } from '@/components/page-header';
import { ChatsToolbar } from '@/components/history/chats-toolbar';
import { ChatsList } from '@/components/history/chats-list';
import { deleteThread, getThreadsPage, updateThreadTitle } from '@/lib/server-actions/thread';

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
  const router = useRouter();
  const { currentOrg, loading: authLoading, user } = useAuth();
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectMode, setSelectMode] = useState<'off' | 'manual' | 'implicit'>('off');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeOrgId, setActiveOrgId] = useState(initialOrgId);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(initialOffset);
  const [limit, setLimit] = useState(initialLimit);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const isSelecting = selectMode !== 'off';
  const hasMore = threads.length < total;

  useEffect(() => {
    if (!authLoading && !user) {
      setThreads([]);
      setSelectedIds(new Set());
      setSelectMode('off');
      setTotal(0);
      setOffset(0);
      router.replace('/login');
    }
  }, [authLoading, user, router]);

  const refreshThreads = useCallback(async () => {
    try {
      setLoading(true);
      const page = await getThreadsPage({ offset: 0, limit });
      setThreads(Array.isArray(page.items) ? (page.items as Thread[]) : []);
      setTotal(page.total);
      setOffset(page.offset);
      setLimit(page.limit);
    } catch (error) {
      console.error('Failed to fetch threads:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentOrg?.id && currentOrg.id !== activeOrgId) {
      setActiveOrgId(currentOrg.id);
      refreshThreads();
    }
  }, [currentOrg?.id, activeOrgId, refreshThreads]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      const nextOffset = offset + limit;
      const page = await getThreadsPage({ offset: nextOffset, limit });
      setThreads((prev) => [...prev, ...(page.items as Thread[])]);
      setTotal(page.total);
      setOffset(page.offset);
      setLimit(page.limit);
    } catch (error) {
      console.error('Failed to load more threads:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, limit, loadingMore, offset]);

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
    try {
      await updateThreadTitle(id, newTitle);
      setThreads(prev => prev.map(t => t.id === id ? { ...t, title: newTitle } : t));
    } catch (error) {
      console.error('Failed to rename thread:', error);
    }
  };

  const handleDeleteThread = async (id: string) => {
    try {
      await deleteThread(id);
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
    router.push(`/chat/${id}`);
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
          />
        </div>
      </div>
    </>
  );
}
