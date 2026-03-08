'use client';

import { cn } from '@/lib/utils';
import { Download, Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ParsedTable } from './types';
import {
  REPORT_MAX_CELL_CHARS,
  getTableDisplayModel,
  isNumericValue,
  truncateCell,
} from './table-display';

interface NotebookTableProps {
  table: ParsedTable;
  mode: 'report' | 'notebook';
  onExpand?: () => void;
}

export function NotebookTable({ table, mode, onExpand }: NotebookTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showOverflowFade, setShowOverflowFade] = useState(false);
  const isReport = mode === 'report';
  const {
    columnCount,
    parsedRows,
    totalRows,
    displayCapped,
    displayRows,
    captionText,
    hasCsvData,
  } = getTableDisplayModel(table);

  const updateOverflowFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const canOverflow = el.scrollWidth > el.clientWidth + 1;
    const atRightEdge = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setShowOverflowFade(canOverflow && !atRightEdge);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflowFade();
    el.addEventListener('scroll', updateOverflowFade, { passive: true });

    const observer = new ResizeObserver(updateOverflowFade);
    observer.observe(el);
    const tableElement = el.querySelector('table');
    if (tableElement) {
      observer.observe(tableElement);
    }

    return () => {
      el.removeEventListener('scroll', updateOverflowFade);
      observer.disconnect();
    };
  }, [updateOverflowFade]);

  useEffect(() => {
    const raf = requestAnimationFrame(updateOverflowFade);
    return () => cancelAnimationFrame(raf);
  }, [updateOverflowFade, columnCount, totalRows]);

  const downloadCsv = useCallback(() => {
    if (!hasCsvData || typeof document === 'undefined') {
      return;
    }

    const escapeCell = (value: string): string => {
      if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };

    const csvColumnCount = columnCount;
    const lines: string[] = [];

    if (table.headers.length > 0) {
      const paddedHeaders = Array.from(
        { length: csvColumnCount },
        (_, columnIndex) => table.headers[columnIndex] ?? ''
      );
      lines.push(paddedHeaders.map(escapeCell).join(','));
    }

    for (const row of table.rows) {
      const paddedRow = Array.from(
        { length: csvColumnCount },
        (_, columnIndex) => row[columnIndex] ?? ''
      );
      lines.push(paddedRow.map(escapeCell).join(','));
    }

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = 'table-data.csv';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }, [columnCount, hasCsvData, table.headers, table.rows]);

  return (
    <div className="relative w-full min-w-0">
      <div
        className={cn(
          'relative min-w-0 overflow-hidden',
          isReport && 'rounded-xl border border-border/60 bg-background/50 shadow-sm'
        )}
      >
        <div
          ref={scrollRef}
          className={cn(
            'min-w-0 overflow-x-auto',
            isReport && 'max-h-[600px] overflow-y-auto'
          )}
        >
          <table className="w-max min-w-full border-collapse text-xs">
            {table.headers.length > 0 ? (
              <TableHeader className="[&_tr]:border-b [&_tr]:border-border/80">
                <TableRow className={cn(
                  'h-auto border-border/80 bg-muted/40 hover:bg-muted/40',
                  isReport && 'sticky top-0 z-10'
                )}>
                  {table.headers.map((header, columnIndex) => {
                    const isIndexColumn = columnIndex < table.indexColumns;
                    const isLastIndexColumn =
                      table.indexColumns > 0 && columnIndex === table.indexColumns - 1;

                    return (
                      <TableHead
                        key={`header-${columnIndex}`}
                        className={cn(
                          'h-auto px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground',
                          isIndexColumn && 'text-muted-foreground/70',
                          isLastIndexColumn && 'border-r border-border/50'
                        )}
                      >
                        {header}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
            ) : null}

            <TableBody className="[&_tr:last-child]:border-b-0">
              {displayRows.map((row, rowIndex) => (
                <TableRow
                  key={`row-${rowIndex}`}
                  className={cn(
                    'border-b border-border/40',
                    rowIndex % 2 === 1 && 'bg-muted/20',
                    'hover:bg-muted/30'
                  )}
                >
                  {Array.from({ length: columnCount }, (_, columnIndex) => {
                    const cellValue = row[columnIndex] ?? '';
                    const isIndexColumn = columnIndex < table.indexColumns;
                    const isLastIndexColumn =
                      table.indexColumns > 0 && columnIndex === table.indexColumns - 1;
                    const numericCell = !isIndexColumn && isNumericValue(cellValue);

                    if (isIndexColumn) {
                      return (
                        <th
                          key={`row-${rowIndex}-col-${columnIndex}`}
                          scope="row"
                          className={cn(
                            'px-3 py-1.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground/70',
                            isLastIndexColumn && 'border-r border-border/40'
                          )}
                        >
                          {isReport && cellValue.length > REPORT_MAX_CELL_CHARS ? (
                            <span title={cellValue}>{truncateCell(cellValue)}</span>
                          ) : cellValue}
                        </th>
                      );
                    }

                    return (
                      <TableCell
                        key={`row-${rowIndex}-col-${columnIndex}`}
                        className={cn(
                          'px-3 py-1.5 text-xs whitespace-nowrap text-foreground/90',
                          numericCell && 'font-mono tabular-nums text-right'
                        )}
                      >
                        {isReport && cellValue.length > REPORT_MAX_CELL_CHARS ? (
                          <span title={cellValue}>{truncateCell(cellValue)}</span>
                        ) : cellValue}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>

        {showOverflowFade ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />
        ) : null}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-4 text-xs text-muted-foreground/60">
        <span>{captionText}</span>
        <div className="flex shrink-0 items-center gap-2">
          {onExpand ? (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Expand table"
              className={cn(
                'inline-flex shrink-0 items-center text-xs transition-colors',
                'text-muted-foreground/70 hover:text-foreground'
              )}
            >
              <Maximize2 className="size-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!hasCsvData}
            aria-label={displayCapped
              ? `Download all ${parsedRows.toLocaleString()} rows as CSV`
              : 'Download as CSV'}
            className={cn(
              'notebook-table-download-btn',
              'inline-flex shrink-0 items-center text-xs transition-colors',
              hasCsvData
                ? 'text-muted-foreground/70 hover:text-foreground'
                : 'cursor-not-allowed text-muted-foreground/40'
            )}
          >
            <Download className="size-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
