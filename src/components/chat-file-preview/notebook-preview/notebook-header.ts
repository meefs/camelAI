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
    let h1LineIndex: number | null = null;
    let h1Line = '';
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (/^#\s+/.test(line.trim())) {
        h1LineIndex = lineIndex;
        h1Line = line;
        break;
      }
    }
    if (h1LineIndex === null) continue;

    title = stripMarkdownFormatting(h1Line.replace(/^#\s+/, ''));
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

  let visualizationCount = 0;
  for (const cell of cells) {
    if (cell.cell_type === 'code' && hasVisualOutput(cell.outputs ?? [])) {
      visualizationCount += 1;
    }
  }

  return {
    title,
    subtitle,
    executionTimestamp,
    cellCount: cells.length,
    visualizationCount,
    titleCellIndex,
  };
}
