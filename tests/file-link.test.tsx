import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    filePreviewPopoverMock(props);
    return (
      <div
        data-testid="file-preview-popover"
        data-filename={props.filename}
        data-preview-url={props.previewUrl}
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
  });
});
