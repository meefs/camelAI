import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/types';
import HistoryClient from '@/components/pages/history/history-client';

const mocks = vi.hoisted(() => ({
  fetcher: {
    data: undefined as
      | {
          threads: Thread[];
          total: number;
          offset: number;
          limit: number;
          queryKey: string;
          q?: string;
        }
      | undefined,
    state: 'idle' as const,
    load: vi.fn(),
    submit: vi.fn(),
  },
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn(),
}));

vi.mock('react-router', () => ({
  useFetcher: () => mocks.fetcher,
  useNavigate: () => vi.fn(),
  useRevalidator: () => ({ state: 'idle', revalidate: vi.fn() }),
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    user: null,
    currentOrg: { id: 'org-1' },
    currentWorkspace: { id: 'workspace-1' },
    workspaces: [],
  }),
}));

vi.mock('@/hooks/use-auth-actions', () => ({
  isWorkspaceSwitchSupersededError: () => false,
  useSwitchWorkspace: () => ({ switchWorkspace: vi.fn() }),
}));

vi.mock('@/hooks/use-debounced-value', () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock('@/components/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/container-loading-dialog', () => ({
  ContainerLoadingDialog: () => null,
}));
vi.mock('@/components/history/switch-workspace-dialog', () => ({
  SwitchWorkspaceDialog: () => null,
}));
vi.mock('@/components/history/chats-toolbar', async () => {
  const React = await import('react');
  return {
    ChatsToolbar: ({
      searchQuery,
      onSearchChange,
    }: {
      searchQuery: string;
      onSearchChange: (query: string) => void;
    }) => React.createElement('input', {
      'aria-label': 'History search',
      value: searchQuery,
      onChange: (event: { target: { value: string } }) =>
        onSearchChange(event.target.value),
    }),
  };
});
vi.mock('@/components/history/chats-list', async () => {
  const React = await import('react');
  return {
    ChatsList: ({
      loading,
      threads,
      selectedIds,
      onToggleSelect,
    }: {
      loading: boolean;
      threads: Thread[];
      selectedIds: Set<string>;
      onToggleSelect: (id: string) => void;
    }) =>
      React.createElement('div', {
        'data-testid': 'history-list',
        'data-loading': String(loading),
        'data-selected-ids': Array.from(selectedIds).sort().join(','),
        'data-thread-ids': threads.map((entry) => entry.id).join(','),
      }, threads.map((entry) => React.createElement('button', {
        key: entry.id,
        type: 'button',
        onClick: () => onToggleSelect(entry.id),
      }, `Toggle ${entry.id}`))),
  };
});

const thread: Thread = {
  id: 'thread-1',
  workspace_id: 'workspace-1',
  title: 'Needle result',
  created_by: 'user-1',
  model: 'sonnet',
  created_at: 1,
  updated_at: 1,
  user_message_count: 1,
};

const replacementThread: Thread = {
  ...thread,
  id: 'thread-2',
  title: 'Replacement result',
};

const pageTwoThread: Thread = {
  ...thread,
  id: 'thread-3',
  title: 'Second page result',
};

function renderHistory(initialQueryKey: string) {
  return (
    <HistoryClient
      initialThreads={[thread]}
      initialTotal={1}
      initialOffset={0}
      initialLimit={50}
      threadCreators={[]}
      currentUserId="user-1"
      initialQueryKey={initialQueryKey}
    />
  );
}

describe('history search dataset pending state', () => {
  beforeEach(() => {
    mocks.fetcher.data = undefined;
    mocks.fetcher.load.mockReset();
    mocks.fetcher.submit.mockReset();
    mocks.searchParams = new URLSearchParams();
    mocks.setSearchParams.mockReset();
  });

  it('hides results when queryKey changes with the same active query', async () => {
    const view = render(renderHistory('scope-a'));

    fireEvent.change(screen.getByLabelText('History search'), {
      target: { value: 'needle' },
    });
    expect(screen.getByTestId('history-list')).toHaveAttribute(
      'data-loading',
      'true',
    );

    mocks.fetcher.data = {
      threads: [thread],
      total: 1,
      offset: 0,
      limit: 50,
      queryKey: 'scope-a',
      q: 'needle',
    };
    view.rerender(renderHistory('scope-a'));

    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-loading',
        'false',
      );
    });

    view.rerender(renderHistory('scope-b'));
    expect(screen.getByTestId('history-list')).toHaveAttribute(
      'data-loading',
      'true',
    );
  });

  it('drops selections that are absent from a page-zero replacement', async () => {
    const view = render(renderHistory('scope-a'));

    fireEvent.click(screen.getByRole('button', { name: 'Toggle thread-1' }));
    expect(screen.getByTestId('history-list')).toHaveAttribute(
      'data-selected-ids',
      'thread-1',
    );

    fireEvent.change(screen.getByLabelText('History search'), {
      target: { value: 'replacement' },
    });
    mocks.fetcher.data = {
      threads: [replacementThread],
      total: 1,
      offset: 0,
      limit: 50,
      queryKey: 'scope-a',
      q: 'replacement',
    };
    view.rerender(renderHistory('scope-a'));

    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-selected-ids',
        '',
      );
    });
  });

  it('accepts an echoed query capped at an emoji boundary', async () => {
    const query = `${'a'.repeat(199)}😀`;
    const view = render(renderHistory('scope-a'));

    fireEvent.change(screen.getByLabelText('History search'), {
      target: { value: query },
    });

    await waitFor(() => expect(mocks.fetcher.load).toHaveBeenCalled());
    const requestPath = mocks.fetcher.load.mock.calls.at(-1)?.[0] as string;
    const echoedQuery = new URL(requestPath, 'https://example.com')
      .searchParams.get('q');
    expect(echoedQuery).toBe(query);

    mocks.fetcher.data = {
      threads: [thread],
      total: 1,
      offset: 0,
      limit: 50,
      queryKey: 'scope-a',
      q: echoedQuery ?? undefined,
    };
    view.rerender(renderHistory('scope-a'));

    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-loading',
        'false',
      );
    });
  });

  it('does not reprocess a retained page-two response for a repeated query', async () => {
    const view = render(renderHistory('scope-a'));

    fireEvent.change(screen.getByLabelText('History search'), {
      target: { value: 'foo' },
    });
    mocks.fetcher.data = {
      threads: [replacementThread],
      total: 2,
      offset: 0,
      limit: 1,
      queryKey: 'scope-a',
      q: 'foo',
    };
    view.rerender(renderHistory('scope-a'));
    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-thread-ids',
        'thread-2',
      );
    });

    mocks.fetcher.data = {
      threads: [pageTwoThread],
      total: 2,
      offset: 1,
      limit: 1,
      queryKey: 'scope-a',
      q: 'foo',
    };
    view.rerender(renderHistory('scope-a'));
    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-thread-ids',
        'thread-2,thread-3',
      );
    });

    fireEvent.change(screen.getByLabelText('History search'), {
      target: { value: '' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-thread-ids',
        'thread-1',
      );
    });

    const loadCountBeforeRepeat = mocks.fetcher.load.mock.calls.length;
    fireEvent.change(screen.getByLabelText('History search'), {
      target: { value: 'foo' },
    });
    await waitFor(() => {
      expect(mocks.fetcher.load.mock.calls.length).toBeGreaterThan(
        loadCountBeforeRepeat,
      );
    });
    expect(screen.getByTestId('history-list')).toHaveAttribute(
      'data-thread-ids',
      'thread-1',
    );
    expect(screen.getByTestId('history-list')).toHaveAttribute(
      'data-loading',
      'true',
    );

    mocks.fetcher.data = {
      threads: [replacementThread],
      total: 1,
      offset: 0,
      limit: 1,
      queryKey: 'scope-a',
      q: 'foo',
    };
    view.rerender(renderHistory('scope-a'));
    await waitFor(() => {
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-thread-ids',
        'thread-2',
      );
      expect(screen.getByTestId('history-list')).toHaveAttribute(
        'data-loading',
        'false',
      );
    });
  });
});
