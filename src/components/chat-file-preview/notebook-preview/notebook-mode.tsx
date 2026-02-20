import type { NotebookFile } from './types';
import { NotebookCodeCell } from './notebook-code-cell';
import { NotebookMarkdownCell } from './notebook-markdown-cell';
import { getNotebookCells } from './utils';

interface NotebookModeProps {
  notebook: NotebookFile;
  layout: 'panel' | 'dialog';
}

export function NotebookMode({ notebook, layout }: NotebookModeProps) {
  const cells = getNotebookCells(notebook);

  return (
    <div className="mx-auto max-w-[1800px] space-y-3 p-3">
      {cells.map((cell, index) => (
        cell.cell_type === 'markdown' ? (
          <NotebookMarkdownCell key={`cell-${index}`} cell={cell} />
        ) : (
          <NotebookCodeCell key={`cell-${index}`} cell={cell} cellIndex={index} layout={layout} />
        )
      ))}
    </div>
  );
}
