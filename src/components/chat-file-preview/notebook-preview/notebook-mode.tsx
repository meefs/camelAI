import type { NotebookFile } from './types';
import { NotebookCodeCell } from './notebook-code-cell';
import { NotebookMarkdownCell } from './notebook-markdown-cell';

interface NotebookModeProps {
  notebook: NotebookFile;
  layout: 'panel' | 'dialog';
}

export function NotebookMode({ notebook, layout }: NotebookModeProps) {
  const cells = notebook.cells ?? [];

  return (
    <div className="space-y-3 p-3">
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
