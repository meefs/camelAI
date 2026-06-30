import { memo, useMemo } from 'react';
import { classifyCells } from './cell-classifier';
import { extractHeader } from './notebook-header';
import { removeHeaderContentFromTitleCell } from './report-export-model';
import { OutputRenderer } from './output-renderers';
import { ReportFooter } from './report-footer';
import { ReportHeader } from './report-header';
import { ReportMarkdownCell } from './report-markdown-cell';
import { ReportSidebar } from './report-sidebar';
import type { NotebookCell, NotebookFile, NotebookOutput, TocEntry } from './types';
import {
  extractTocEntries,
  getNotebookCells,
  isIgnorableTextOutput,
  toText,
} from './utils';

interface ReportModeProps {
  notebook: NotebookFile;
  layout: 'panel' | 'dialog';
}

function getReportCellKey(cell: NotebookCell) {
  const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '';
  return [cell.cell_type ?? 'cell', cell.execution_count ?? 'none', source.slice(0, 80)].join(':');
}

function getReportOutputKey(output: NotebookOutput) {
  const text = Array.isArray(output.text) ? output.text.join('') : output.text ?? '';
  return [output.output_type ?? 'output', output.name ?? 'none', text.slice(0, 80)].join(':');
}

function ReportModeComponent({ notebook, layout }: ReportModeProps) {
  const cells = useMemo(() => getNotebookCells(notebook), [notebook]);
  const header = useMemo(() => extractHeader(notebook), [notebook]);
  const classifiedCells = useMemo(() => classifyCells(cells), [cells]);
  const tocEntries = useMemo(
    () => extractTocEntries(cells, header.titleCellIndex),
    [cells, header.titleCellIndex]
  );

  const tocEntriesByCell = useMemo(() => {
    const map = new Map<number, TocEntry[]>();
    for (const entry of tocEntries) {
      const existing = map.get(entry.cellIndex) ?? [];
      existing.push(entry);
      map.set(entry.cellIndex, existing);
    }
    return map;
  }, [tocEntries]);

  const visibleCells = useMemo(
    () => classifiedCells.filter((item) => item.classification === 'show'),
    [classifiedCells]
  );

  const codeCellCount = cells.filter((cell) => cell.cell_type === 'code').length;
  const languageVersion = notebook.metadata?.language_info?.version;

  return (
    <div className="notebook-report mx-auto w-full max-w-5xl px-6 py-6">
      <div className="flex gap-8">
        <ReportSidebar entries={tocEntries} />

        <div className="min-w-0 max-w-3xl flex-1">
          <ReportHeader header={header} />

          <div className="space-y-8">
            {visibleCells.map(({ cell, index }) => {
              if (cell.cell_type === 'markdown') {
                let source = toText(cell.source);
                if (index === header.titleCellIndex) {
                  source = removeHeaderContentFromTitleCell(source);
                }
                if (!source.trim()) return null;

                return (
                  <ReportMarkdownCell
                    key={getReportCellKey(cell)}
                    source={source}
                    entries={tocEntriesByCell.get(index) ?? []}
                  />
                );
              }

              const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
              const reportOutputs = outputs.filter((output) => !isIgnorableTextOutput(output));
              if (reportOutputs.length === 0) return null;

              return (
                <div key={getReportCellKey(cell)} className="min-w-0 space-y-8">
                  {reportOutputs.map((output, outputIndex) => (
                    <OutputRenderer
                      key={getReportOutputKey(output)}
                      output={output}
                      mode="report"
                      layout={layout}
                      title={`Output ${outputIndex + 1}`}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          <ReportFooter codeCellCount={codeCellCount} languageVersion={languageVersion} />
        </div>
      </div>
    </div>
  );
}

function areReportModePropsEqual(prev: ReportModeProps, next: ReportModeProps): boolean {
  return prev.notebook === next.notebook && prev.layout === next.layout;
}

export const ReportMode = memo(ReportModeComponent, areReportModePropsEqual);
