import { memo, useMemo } from 'react';
import { classifyCells } from './cell-classifier';
import { extractHeader } from './notebook-header';
import { removeHeaderContentFromTitleCell } from './report-export-model';
import { OutputRenderer } from './output-renderers';
import { ReportFooter } from './report-footer';
import { ReportHeader } from './report-header';
import { ReportMarkdownCell } from './report-markdown-cell';
import { ReportSidebar } from './report-sidebar';
import type { NotebookFile, TocEntry } from './types';
import { extractTocEntries, getNotebookCells, toText } from './utils';

interface ReportModeProps {
  notebook: NotebookFile;
  layout: 'panel' | 'dialog';
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
                    key={`cell-${index}`}
                    source={source}
                    entries={tocEntriesByCell.get(index) ?? []}
                  />
                );
              }

              const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
              if (outputs.length === 0) return null;

              return (
                <div key={`cell-${index}`} className="min-w-0 space-y-8">
                  {outputs.map((output, outputIndex) => (
                    <OutputRenderer
                      key={`output-${index}-${outputIndex}`}
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
