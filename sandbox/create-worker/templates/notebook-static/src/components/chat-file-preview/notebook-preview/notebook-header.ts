import type {
  NotebookFile,
  NotebookHeader,
} from './types';
import {
  getNotebookCells,
  hasVisualOutput,
  stripMarkdownFormatting,
  toText,
} from './utils';

export function extractHeader(notebook: NotebookFile): NotebookHeader {
  const cells = getNotebookCells(notebook);
  let title: string | null = null;
  let subtitle: string | null = null;
  let titleCellIndex: number | null = null;

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell.cell_type !== 'markdown') continue;

    const lines = toText(cell.source).split('\n');
    const h1LineIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    if (h1LineIndex === -1) continue;

    title = stripMarkdownFormatting(lines[h1LineIndex].replace(/^#\s+/, ''));
    titleCellIndex = i;

    const remainingLines = lines.slice(h1LineIndex + 1);
    const subtitleLines: string[] = [];
    for (const line of remainingLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) break;
      if (trimmed.length > 0) subtitleLines.push(trimmed);
    }
    if (subtitleLines.length > 0) {
      subtitle = stripMarkdownFormatting(subtitleLines.join(' '));
    }
    break;
  }

  let executionTimestamp: Date | null = null;
  for (const cell of cells) {
    if (cell.cell_type !== 'code') continue;
    const startTime = cell.metadata?.execution?.['iopub.execute_input'];
    if (typeof startTime !== 'string') continue;

    const parsed = new Date(startTime);
    if (!Number.isNaN(parsed.getTime())) {
      executionTimestamp = parsed;
      break;
    }
  }

  const visualizationCount = cells.filter((cell) =>
    cell.cell_type === 'code' && hasVisualOutput(cell.outputs ?? [])
  ).length;

  return {
    title,
    subtitle,
    executionTimestamp,
    cellCount: cells.length,
    visualizationCount,
    titleCellIndex,
  };
}
