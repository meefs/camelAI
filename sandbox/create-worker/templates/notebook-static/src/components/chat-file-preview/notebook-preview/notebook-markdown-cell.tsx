import { MarkdownRenderer } from '@/components/markdown-renderer';
import type { NotebookCell } from './types';
import { toText } from './utils';

interface NotebookMarkdownCellProps {
  cell: NotebookCell;
}

export function NotebookMarkdownCell({ cell }: NotebookMarkdownCellProps) {
  const source = toText(cell.source);

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">Markdown</div>
      <MarkdownRenderer content={source || '_Empty cell_'} />
    </div>
  );
}
