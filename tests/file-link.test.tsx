import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { FileLink } from '@/components/tool-call/file-link';

const { mockUseAuthData, filePreviewPopoverMock } = vi.hoisted(() => ({
  mockUseAuthData: vi.fn(),
  filePreviewPopoverMock: vi.fn(),
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => mockUseAuthData(),
}));

vi.mock('@/components/chat-file-preview', () => ({
  FilePreviewPopover: (props: {
    filename: string;
    previewUrl: string;
    textPreviewUrl?: string;
    fullTextPreviewUrl?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    filePreviewPopoverMock(props);
    return (
      <div
        data-testid="file-preview-popover"
        data-filename={props.filename}
        data-preview-url={props.previewUrl}
        data-text-preview-url={props.textPreviewUrl}
        data-full-text-preview-url={props.fullTextPreviewUrl}
      />
    );
  },
}));

describe('FileLink', () => {
  beforeEach(() => {
    mockUseAuthData.mockReset();
    filePreviewPopoverMock.mockClear();
  });

  describe('URL generation regression test', () => {
    it('uses workspaceId, not orgId, in the preview URL', () => {
      mockUseAuthData.mockReturnValue({
        currentOrg: { id: 'org-123', name: 'Test Org' },
        currentWorkspace: { id: 'ws-456', name: 'Test Workspace' },
      });

      render(<FileLink path="/app/index.html" />);

      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByRole('button', { name: '/app/index.html' })).toBeInTheDocument();
      const popover = screen.getByTestId('file-preview-popover');

      expect(popover).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/fs/content/app/index.html',
      );
      expect(popover).toHaveAttribute(
        'data-text-preview-url',
        '/api/workspaces/ws-456/file-preview/text?source=workspace&path=%2Fapp%2Findex.html&mode=initial&maxLines=1000',
      );
      expect(popover).toHaveAttribute(
        'data-full-text-preview-url',
        '/api/workspaces/ws-456/file-preview/text?source=workspace&path=%2Fapp%2Findex.html&mode=full',
      );
      expect(popover.getAttribute('data-preview-url')).not.toContain('org-123');
    });

    it('falls back to plain text when no workspace is set', () => {
      mockUseAuthData.mockReturnValue({
        currentOrg: { id: 'org-123', name: 'Test Org' },
        currentWorkspace: null,
      });

      render(<FileLink path="/app/index.html" />);

      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByText('/app/index.html')).toBeInTheDocument();
    });
  });

  describe('path normalization', () => {
    it('strips /home/claude prefix from paths', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/home/claude/app/index.html" />);

      const popover = screen.getByTestId('file-preview-popover');
      const previewUrl = popover.getAttribute('data-preview-url');

      expect(previewUrl).toBe('/api/workspaces/ws-456/fs/content/app/index.html');
      expect(previewUrl).not.toContain('home');
      expect(previewUrl).not.toContain('claude');
    });

    it('strips /workspace prefix from paths', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/workspace/app/style.css" />);

      expect(screen.getByTestId('file-preview-popover')).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/fs/content/app/style.css',
      );
    });

    it('routes relative R2 output and upload paths to preview endpoints', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      const { rerender } = render(<FileLink path="outputs/report.md" />);

      expect(screen.getByRole('button', { name: 'report.md' })).toBeInTheDocument();
      expect(screen.getByTestId('file-preview-popover')).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/outputs/report.md',
      );

      filePreviewPopoverMock.mockClear();
      rerender(<FileLink path="uploads/photos/cat pic.png" />);

      expect(screen.getByRole('button', { name: 'cat pic.png' })).toBeInTheDocument();
      expect(screen.getByTestId('file-preview-popover')).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/uploads/photos/cat%20pic.png',
      );
    });

    it('keeps legacy R2 mount links previewable for persisted chat history', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      const { rerender } = render(<FileLink path="/mnt/user-outputs/report.pdf" />);

      expect(screen.getByRole('button', { name: 'report.pdf' })).toBeInTheDocument();
      expect(screen.getByTestId('file-preview-popover')).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/outputs/report.pdf',
      );

      filePreviewPopoverMock.mockClear();
      rerender(<FileLink path="/mnt/user-uploads/photos/cat.png" />);

      expect(screen.getByRole('button', { name: 'cat.png' })).toBeInTheDocument();
      expect(screen.getByTestId('file-preview-popover')).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/uploads/photos/cat.png',
      );
    });
  });

  describe('link behavior', () => {
    it('renders a preview button instead of an external anchor', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/app/index.html" />);

      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByRole('button', { name: '/app/index.html' })).toBeInTheDocument();
    });

    it('encodes special characters per path segment in preview URLs', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/app/my file #1.html" />);

      expect(screen.getByTestId('file-preview-popover')).toHaveAttribute(
        'data-preview-url',
        '/api/workspaces/ws-456/fs/content/app/my%20file%20%231.html',
      );
    });

    it('uses the thread workspace id from preview context before auth state', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'other-ws' },
      });
      const openPreviewTarget = vi.fn();

      render(
        <ChatPreviewProvider
          value={{
            workspaceId: 'thread-ws',
            openPreviewTarget,
            clearPreviewTarget: vi.fn(),
          }}
        >
          <FileLink path="/notes.md">notes.md</FileLink>
        </ChatPreviewProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));

      expect(openPreviewTarget).toHaveBeenCalledWith({
        kind: 'file',
        source: 'workspace',
        workspaceId: 'thread-ws',
        path: '/notes.md',
        filename: 'notes.md',
      });
    });

    it('opens VM targets with their project metadata', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'other-ws' },
      });
      const openPreviewTarget = vi.fn();

      render(
        <ChatPreviewProvider
          value={{
            workspaceId: 'thread-ws',
            openPreviewTarget,
            clearPreviewTarget: vi.fn(),
          }}
        >
          <FileLink
            path="/src/App.tsx"
            previewTarget={{
              source: 'vm',
              project: 'demo-app',
              path: '/src/App.tsx',
              filename: 'App.tsx',
            }}
          >
            App.tsx
          </FileLink>
        </ChatPreviewProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'App.tsx' }));

      expect(openPreviewTarget).toHaveBeenCalledWith({
        kind: 'file',
        source: 'vm',
        workspaceId: 'thread-ws',
        project: 'demo-app',
        path: '/src/App.tsx',
        filename: 'App.tsx',
      });
    });

    it('does not double-prefix output targets passed as canonical preview metadata', () => {
      mockUseAuthData.mockReturnValue({
        currentWorkspace: { id: 'other-ws' },
      });
      const openPreviewTarget = vi.fn();

      render(
        <ChatPreviewProvider
          value={{
            workspaceId: 'thread-ws',
            openPreviewTarget,
            clearPreviewTarget: vi.fn(),
          }}
        >
          <FileLink
            path="outputs/report.html"
            previewTarget={{
              source: 'output',
              path: 'report.html',
              filename: 'report.html',
            }}
          >
            report.html
          </FileLink>
        </ChatPreviewProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'report.html' }));

      expect(openPreviewTarget).toHaveBeenCalledWith({
        kind: 'file',
        source: 'output',
        workspaceId: 'thread-ws',
        path: 'report.html',
        filename: 'report.html',
      });
    });
  });
});
