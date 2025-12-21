'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { Thread } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { ChatsToolbar } from '@/components/history/chats-toolbar';
import { ChatsList } from '@/components/history/chats-list';

export default function HistoryPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectMode, setSelectMode] = useState<'off' | 'manual' | 'implicit'>('off');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectMode !== 'off';

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, user, router]);

  // Fetch threads
  const fetchThreads = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/threads');
      const data = await res.json() as unknown;
      setThreads(Array.isArray(data) ? (data as Thread[]) : []);
    } catch (error) {
      console.error('Failed to fetch threads:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      fetchThreads();
    }
  }, [user, fetchThreads]);

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
      await fetch(`/api/threads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      setThreads(prev => prev.map(t => t.id === id ? { ...t, title: newTitle } : t));
    } catch (error) {
      console.error('Failed to rename thread:', error);
    }
  };

  const handleDeleteThread = async (id: string) => {
    try {
      await fetch(`/api/threads/${id}`, { method: 'DELETE' });
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

  if (authLoading) {
    return null;
  }

  return (
    <>
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 shrink-0 bg-background">
        <div className="flex h-12 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <div
            data-orientation="vertical"
            role="none"
            className="bg-border shrink-0 w-px h-4 mr-2"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Chat History</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      {/* Main Content Wrapper */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="w-full flex-1 min-h-0 flex flex-col px-4 md:px-6">
          {/* Toolbar */}
          <ChatsToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            totalCount={filteredThreads.length}
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
          />
        </div>
      </div>
    </>
  );
}
