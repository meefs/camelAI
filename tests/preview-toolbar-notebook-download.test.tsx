import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PreviewToolbar } from '@/components/preview-panel/preview-toolbar';
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
      openElsewhereKind="computer"
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

  it('shows notebook and report PDF download actions', async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole('button', { name: /download/i }));

    expect(screen.getByRole('menuitem', { name: /download notebook \(.ipynb\)/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /download report as pdf/i })).toBeInTheDocument();
  });

  it('keeps the open-in-computer action for workspace file previews', async () => {
    const user = userEvent.setup();
    const onOpenElsewhere = vi.fn();
    renderToolbar({ onOpenElsewhere });

    await user.click(screen.getByRole('button', { name: /open in computer/i }));

    expect(onOpenElsewhere).toHaveBeenCalledTimes(1);
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
});
