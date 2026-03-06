import { classifyCells } from './cell-classifier';
import { extractHeader } from './notebook-header';
import { getTableDisplayModel, type TableDisplayModel } from './table-display';
import type {
  NotebookFile,
  NotebookHeader,
  ParsedTable,
  TocEntry,
} from './types';
import { extractTocEntries, getNotebookCells, getOutputRender, getOutputText, toText } from './utils';

export interface NotebookReportExportModel {
  header: NotebookHeader;
  codeCellCount: number;
  languageVersion?: string;
  tocEntries: TocEntry[];
  blocks: NotebookReportExportBlock[];
}

export type NotebookReportExportBlock =
  | { id: string; kind: 'markdown'; markdown: string }
  | { id: string; kind: 'chart'; chartKind: 'vegalite' | 'plotly'; spec: Record<string, unknown>; title: string }
  | { id: string; kind: 'table'; table: ParsedTable; display: TableDisplayModel; title: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; src: string; title: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'html'; html: string; title: string };

export function removeHeaderContentFromTitleCell(source: string): string {
  const lines = source.split('\n');
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line.trim()));
  if (h1Index === -1) return source;

  let cursor = h1Index + 1;
  while (cursor < lines.length) {
    const trimmed = lines[cursor].trim();
    if (trimmed.length === 0) {
      cursor += 1;
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      break;
    }
    cursor += 1;
  }

  return [...lines.slice(0, h1Index), ...lines.slice(cursor)].join('\n').trim();
}

export function buildNotebookReportExportModel(
  notebook: NotebookFile
): NotebookReportExportModel {
  const cells = getNotebookCells(notebook);
  const header = extractHeader(notebook);
  const classifiedCells = classifyCells(cells);
  const visibleCells = classifiedCells.filter((item) => item.classification === 'show');
  const tocEntries = extractTocEntries(cells, header.titleCellIndex);
  const codeCellCount = cells.filter((cell) => cell.cell_type === 'code').length;
  const languageVersion = notebook.metadata?.language_info?.version;
  const blocks: NotebookReportExportBlock[] = [];

  for (const { cell, index } of visibleCells) {
    if (cell.cell_type === 'markdown') {
      let source = toText(cell.source);
      if (index === header.titleCellIndex) {
        source = removeHeaderContentFromTitleCell(source);
      }
      if (!source.trim()) {
        continue;
      }
      blocks.push({
        id: `cell-${index}`,
        kind: 'markdown',
        markdown: source,
      });
      continue;
    }

    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    outputs.forEach((output, outputIndex) => {
      const id = `cell-${index}-output-${outputIndex}`;
      const title = `Output ${outputIndex + 1}`;

      if (output.output_type === 'error') {
        const errorText = getOutputText(output).trim();
        if (errorText) {
          blocks.push({ id, kind: 'error', text: errorText });
        }
        return;
      }

      const render = getOutputRender(output);

      switch (render.kind) {
        case 'vegalite':
          blocks.push({
            id,
            kind: 'chart',
            chartKind: 'vegalite',
            spec: render.spec,
            title,
          });
          return;
        case 'plotly':
          blocks.push({
            id,
            kind: 'chart',
            chartKind: 'plotly',
            spec: render.payload,
            title,
          });
          return;
        case 'table':
          blocks.push({
            id,
            kind: 'table',
            table: render.table,
            display: getTableDisplayModel(render.table),
            title,
          });
          return;
        case 'html':
          blocks.push({
            id,
            kind: 'html',
            html: render.html,
            title,
          });
          return;
        case 'image':
          blocks.push({
            id,
            kind: 'image',
            src: render.src,
            title,
          });
          return;
        case 'text':
          if (render.text.trim()) {
            blocks.push({
              id,
              kind: 'text',
              text: render.text,
            });
          }
          return;
        case 'unsupported':
          return;
      }
    });
  }

  return {
    header,
    codeCellCount,
    languageVersion,
    tocEntries,
    blocks,
  };
}
