import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileLink } from '@/components/tool-call/file-link';

const mockUseAuth = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

describe('FileLink', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
  });

  describe('URL generation regression test', () => {
    it('uses workspaceId, not orgId, in the href', () => {
      mockUseAuth.mockReturnValue({
        currentOrg: { id: 'org-123', name: 'Test Org' },
        currentWorkspace: { id: 'ws-456', name: 'Test Workspace' },
      });

      render(<FileLink path="/app/index.html" />);

      const link = screen.getByRole('link');
      const href = link.getAttribute('href');

      expect(href).toContain('/computer/ws-456');
      expect(href).not.toContain('/computer/org-123');
      expect(href).toContain('file=%2Fapp%2Findex.html');
    });

    it('falls back to plain text when no workspace is set', () => {
      mockUseAuth.mockReturnValue({
        currentOrg: { id: 'org-123', name: 'Test Org' },
        currentWorkspace: null,
      });

      render(<FileLink path="/app/index.html" />);

      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('/app/index.html')).toBeInTheDocument();
    });
  });

  describe('path normalization', () => {
    it('strips /home/claude prefix from paths', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/home/claude/app/index.html" />);

      const link = screen.getByRole('link');
      const href = link.getAttribute('href');

      expect(href).toContain('file=%2Fapp%2Findex.html');
      expect(href).not.toContain('home');
      expect(href).not.toContain('claude');
    });

    it('strips /workspace prefix from paths', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/workspace/app/style.css" />);

      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toContain('file=%2Fapp%2Fstyle.css');
    });
  });

  describe('link behavior', () => {
    it('opens in new tab with security attributes', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/app/index.html" />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('encodes special characters in file paths', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/app/my file #1.html" />);

      const link = screen.getByRole('link');
      const href = link.getAttribute('href');

      expect(href).toContain('file=%2Fapp%2Fmy%20file%20%231.html');
    });
  });
});
