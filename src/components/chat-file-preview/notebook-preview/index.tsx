import { cn } from '@/lib/utils';
import { NotebookMode } from './notebook-mode';
import { ReportMode } from './report-mode';
import type { NotebookFile } from './types';

type PreviewLayout = 'dialog' | 'panel';

interface NotebookPreviewProps {
  notebook: NotebookFile;
  layout: PreviewLayout;
  viewMode: 'report' | 'notebook';
}

export function NotebookPreview({
  notebook,
  layout,
  viewMode,
}: NotebookPreviewProps) {
  return (
    <div
      data-notebook-scroll-root="true"
      className={cn(
        '@container overflow-auto',
        layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]'
      )}
    >
      {viewMode === 'report' ? (
        <ReportMode notebook={notebook} layout={layout} />
      ) : (
        <NotebookMode notebook={notebook} layout={layout} />
      )}
    </div>
  );
}

export type { NotebookCell, NotebookFile } from './types';
