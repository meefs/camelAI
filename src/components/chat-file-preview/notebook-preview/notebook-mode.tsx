import type { NotebookFile } from './types';
import { NotebookCodeCell } from './notebook-code-cell';
import { NotebookMarkdownCell } from './notebook-markdown-cell';
import { getNotebookCells } from './utils';
import type { NotebookCell } from './types';

function getNotebookCellKey(cell: NotebookCell) {
  const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '';
  return [cell.cell_type ?? 'cell', cell.execution_count ?? 'none', source.slice(0, 80)].join(':');
}

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
          <NotebookMarkdownCell key={getNotebookCellKey(cell)} cell={cell} />
        ) : (
          <NotebookCodeCell key={getNotebookCellKey(cell)} cell={cell} cellIndex={index} layout={layout} />
        )
      ))}
    </div>
  );
}
