import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { PreviewToolbar } from '@/components/preview-panel/preview-toolbar';
import { formatCopyFilePath } from '@/lib/file-path-copy';
import type { PreviewTarget } from '@/types';

const NOTEBOOK_TARGET: PreviewTarget = {
  kind: 'file',
  source: 'workspace',
  workspaceId: 'workspace-123',
  path: '/reports/analysis.ipynb',
  filename: 'analysis.ipynb',
  contentType: 'application/x-ipynb+json',
};

function renderToolbar(overrides?: Partial<React.ComponentProps<typeof PreviewToolbar>>) {
  return render(
    <PreviewToolbar
      activeTarget={NOTEBOOK_TARGET}
      onRefresh={() => {}}
      openElsewhereKind={null}
      onOpenElsewhere={() => {}}
      notebookViewMode="report"
      onNotebookViewModeChange={() => {}}
      filePreviewOpenUrl="/api/workspaces/workspace-123/fs/content/reports/analysis.ipynb"
      notebookState={{
        notebook: { cells: [] },
        status: 'ready',
      }}
      onNotebookReportPdfDownload={() => {}}
      {...overrides}
    />
  );
}

describe('PreviewToolbar notebook downloads', () => {
  it('shows the active file name in the toolbar and copies its path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderToolbar();

    const fileChip = screen.getByRole('button', { name: /analysis\.ipynb/i });
    expect(fileChip).toBeInTheDocument();

    fireEvent.click(fileChip);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('/reports/analysis.ipynb');
    });
  });

  it('copies project VM paths with the project mention slug from preview context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });
    const mentionSlugMap = new Map([
      [
        'thread_review_dashboard',
        { kind: 'project' as const, name: 'Thread Review Dashboard' },
      ],
    ]);

    render(
      <ChatPreviewProvider
        value={{
          openPreviewTarget: vi.fn(),
          clearPreviewTarget: vi.fn(),
          formatFilePathForCopy: (target) =>
            formatCopyFilePath(target, { mentionSlugMap }),
        }}
      >
        <PreviewToolbar
          activeTarget={{
            kind: 'file',
            source: 'vm',
            workspaceId: 'workspace-123',
            path: '/plans/phase-2-automation.md',
            filename: 'phase-2-automation.md',
            project: 'Thread Review Dashboard',
            contentType: 'text/markdown',
          }}
          onRefresh={() => {}}
          openElsewhereKind={null}
          onOpenElsewhere={() => {}}
          filePreviewOpenUrl="/api/workspaces/workspace-123/fs/content/plans/phase-2-automation.md"
        />
      </ChatPreviewProvider>,
    );

    const fileChip = screen.getByRole('button', { name: /phase-2-automation\.md/i });
    expect(fileChip).toBeInTheDocument();

    fireEvent.click(fileChip);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '@thread_review_dashboard - /plans/phase-2-automation.md',
      );
    });
  });

  it('shows notebook and report PDF download actions', async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole('button', { name: /download/i }));

    expect(screen.getByRole('menuitem', { name: /download notebook \(.ipynb\)/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /download report as pdf/i })).toBeInTheDocument();
  });

  it('omits open-elsewhere for workspace file previews', () => {
    const onOpenElsewhere = vi.fn();
    renderToolbar({ onOpenElsewhere });

    expect(screen.queryByRole('button', { name: /open in computer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open live app/i })).not.toBeInTheDocument();
    expect(onOpenElsewhere).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
  });

  it('omits open-elsewhere for upload file previews', () => {
    renderToolbar({
      activeTarget: {
        ...NOTEBOOK_TARGET,
        source: 'upload',
      },
      openElsewhereKind: null,
    });

    expect(screen.queryByRole('button', { name: /open in computer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open live app/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
  });

  it('disables the PDF export action while the notebook is still loading', async () => {
    const user = userEvent.setup();
    renderToolbar({
      notebookState: {
        notebook: null,
        status: 'loading',
      },
      onNotebookReportPdfDownload: vi.fn(),
    });

    await user.click(screen.getByRole('button', { name: /download/i }));

    const pdfItem = screen.getByRole('menuitem', { name: /download report as pdf/i });
    expect(pdfItem).toHaveAttribute('data-disabled');
  });

  it('shows an exporting trigger state while PDF export is running', () => {
    renderToolbar({
      isNotebookPdfExporting: true,
    });

    expect(screen.getByRole('button', { name: /exporting/i })).toBeInTheDocument();
    expect(screen.getByText('Exporting…')).toBeInTheDocument();
  });

  it('shows a generic preview/source toggle for supported file previews', async () => {
    const user = userEvent.setup();
    const onFileViewModeChange = vi.fn();

    renderToolbar({
      activeTarget: {
        kind: 'file',
        source: 'workspace',
        workspaceId: 'workspace-123',
        path: '/site/index.html',
        filename: 'index.html',
        contentType: 'text/html',
      },
      notebookViewMode: undefined,
      onNotebookViewModeChange: undefined,
      fileViewMode: 'preview',
      onFileViewModeChange,
      filePreviewOpenUrl: '/api/workspaces/workspace-123/fs/content/site/index.html',
      notebookState: undefined,
      onNotebookReportPdfDownload: undefined,
    });

    await user.click(screen.getByRole('tab', { name: /source code/i }));

    expect(onFileViewModeChange).toHaveBeenCalledWith('source');
  });

  it('omits the generic preview/source toggle for binary spreadsheets', () => {
    renderToolbar({
      activeTarget: {
        kind: 'file',
        source: 'workspace',
        workspaceId: 'workspace-123',
        path: '/data/report.xlsx',
        filename: 'report.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      notebookViewMode: undefined,
      onNotebookViewModeChange: undefined,
      fileViewMode: 'preview',
      onFileViewModeChange: vi.fn(),
      filePreviewOpenUrl: '/api/workspaces/workspace-123/fs/content/data/report.xlsx',
      notebookState: undefined,
      onNotebookReportPdfDownload: undefined,
    });

    expect(screen.queryByRole('tab', { name: /source code/i })).not.toBeInTheDocument();
  });
});
