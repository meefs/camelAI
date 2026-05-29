import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';

const useThemeMock = vi.fn();
const useAuthDataMock = vi.fn();

vi.mock('next-themes', () => ({
  useTheme: useThemeMock,
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: useAuthDataMock,
}));

vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: () => <div data-testid="monaco-editor" />,
  DiffEditor: () => <div data-testid="monaco-diff-editor" />,
  loader: {
    config: vi.fn(),
  },
}));

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

const { default: ComputerPageContent } = await import(
  '@/components/pages/computer/computer-page-content'
);

describe('ComputerPageContent read-only file editing mode', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    useThemeMock.mockReturnValue({ resolvedTheme: 'light' });
    useAuthDataMock.mockReturnValue({
      user: { id: 'user_123' },
      currentWorkspace: { id: 'ws_123' },
    });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          path: '/',
          entries: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('renders the read-only badge without the old editing toggle', async () => {
    render(
      <MemoryRouter>
        <ComputerPageContent workspaceId="ws_123" />
      </MemoryRouter>
    );

    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByText('File editing is disabled.')).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('Enable editing')).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws_123/fs/list?path=%2F&recursive=0',
      {}
    );
  });
});
