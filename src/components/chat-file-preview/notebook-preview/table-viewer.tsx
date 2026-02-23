'use client';

import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignJustify,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Search,
  XIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ParsedTable } from './types';

interface TableViewerProps {
  table: ParsedTable;
  title: string;
}

interface ResizeState {
  columnIndex: number;
  startX: number;
  startWidth: number;
}

type SortDirection = 'asc' | 'desc' | null;

const MAX_DISPLAY_ROWS = 500;
const COLUMN_WIDTH_SAMPLE_ROWS = MAX_DISPLAY_ROWS;
const DEFAULT_MAX_COLUMN_WIDTH = 200;
const DEFAULT_INDEX_COLUMN_WIDTH = 120;
const CHAR_WIDTH_PX = 7.5;
const CELL_PADDING_PX = 24;
const SORT_ICON_PX = 28;
const MIN_COLUMN_WIDTH = 60;

function isMissingNumericValue(value: string): boolean {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  return (
    normalized.length === 0
    || normalized === '...'
    || normalized === '…'
    || lower === 'none'
    || lower === 'nan'
    || lower === 'nat'
    || lower === 'null'
    || lower === '<na>'
  );
}

function isNumeric(value: string): boolean {
  const normalized = value.trim();
  if (isMissingNumericValue(normalized)) {
    return false;
  }
  return /^-?[\d,]+(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/.test(normalized);
}

function parseNumeric(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '').replace(/%$/, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNumericColumn(rows: readonly string[][], columnIndex: number): boolean {
  let sawNumeric = false;
  for (const row of rows) {
    const value = row[columnIndex] ?? '';
    if (isMissingNumericValue(value)) continue;
    if (!isNumeric(value)) return false;
    sawNumeric = true;
  }
  return sawNumeric;
}

function getMaxRowLength(rows: readonly string[][]): number {
  let max = 0;
  for (const row of rows) {
    if (row.length > max) {
      max = row.length;
    }
  }
  return max;
}

function estimateColumnWidth(
  header: string,
  rows: readonly string[][],
  columnIndex: number,
  isIndexColumn: boolean,
  maxWidth: number
): number {
  const headerExtra = isIndexColumn ? 0 : SORT_ICON_PX;
  const headerWidth = header.length * CHAR_WIDTH_PX + CELL_PADDING_PX + headerExtra;

  let maxCellWidth = 0;
  for (const row of rows) {
    const cellLen = (row[columnIndex] ?? '').length;
    const w = cellLen * CHAR_WIDTH_PX + CELL_PADDING_PX;
    if (w > maxCellWidth) maxCellWidth = w;
  }

  return Math.max(MIN_COLUMN_WIDTH, Math.min(maxWidth, Math.ceil(Math.max(headerWidth, maxCellWidth))));
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sanitizeCsvFilename(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${slug}.csv` : 'table-data.csv';
}

function recordsMatch(
  left: Record<number, number>,
  right: Record<number, number>
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[Number(key)] === value);
}

export function TableViewer({ table, title }: TableViewerProps) {
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [textWrap, setTextWrap] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [measuredIndexWidths, setMeasuredIndexWidths] = useState<Record<number, number>>({});
  const [resizingColumn, setResizingColumn] = useState<number | null>(null);

  const headerCellRefs = useRef<Record<number, HTMLTableCellElement | null>>({});
  const resizeStateRef = useRef<ResizeState | null>(null);
  const pendingWidthRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);

  const columnCount = useMemo(
    () => Math.max(table.headers.length, getMaxRowLength(table.rows)),
    [table.headers, table.rows]
  );
  const parsedRows = table.rows.length;
  const totalRows = table.sourceRowCount ?? parsedRows;
  const dataColumns = Math.max(0, columnCount - table.indexColumns);
  const colLabel = `${dataColumns.toLocaleString()} column${dataColumns === 1 ? '' : 's'}`;
  const hasCsvData = table.headers.length > 0 || table.rows.some((row) => row.length > 0);

  const headers = useMemo(
    () => Array.from({ length: columnCount }, (_, index) => table.headers[index] ?? `Column ${index + 1}`),
    [columnCount, table.headers]
  );
  const widthSampleRows = useMemo(
    () => (
      table.rows.length > COLUMN_WIDTH_SAMPLE_ROWS
        ? table.rows.slice(0, COLUMN_WIDTH_SAMPLE_ROWS)
        : table.rows
    ),
    [table.rows]
  );

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearchTerm(searchInput.trim().toLowerCase());
    }, 150);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    return () => {
      cleanupResizeRef.current?.();
      cleanupResizeRef.current = null;
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const defaults: Record<number, number> = {};
    for (let i = 0; i < columnCount; i++) {
      const isIndex = i < table.indexColumns;
      const maxW = isIndex ? DEFAULT_INDEX_COLUMN_WIDTH : DEFAULT_MAX_COLUMN_WIDTH;
      defaults[i] = estimateColumnWidth(table.headers[i] ?? '', widthSampleRows, i, isIndex, maxW);
    }
    setColumnWidths(defaults);
  }, [columnCount, table.indexColumns, table.headers, widthSampleRows]);

  const sortedRows = useMemo(() => {
    if (sortColumn == null || sortDirection == null || sortColumn < table.indexColumns) {
      return table.rows;
    }

    const directionMultiplier = sortDirection === 'asc' ? 1 : -1;
    const numericColumn = isNumericColumn(table.rows, sortColumn);

    return table.rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const leftValue = left.row[sortColumn] ?? '';
        const rightValue = right.row[sortColumn] ?? '';
        let compare = 0;

        if (numericColumn) {
          const leftNumber = parseNumeric(leftValue);
          const rightNumber = parseNumeric(rightValue);
          if (leftNumber == null && rightNumber == null) compare = 0;
          else if (leftNumber == null) compare = 1;
          else if (rightNumber == null) compare = -1;
          else compare = leftNumber - rightNumber;
        } else {
          compare = leftValue.localeCompare(rightValue, undefined, {
            numeric: true,
            sensitivity: 'base',
          });
        }

        if (compare === 0) {
          compare = left.index - right.index;
        }

        return compare * directionMultiplier;
      })
      .map((entry) => entry.row);
  }, [sortColumn, sortDirection, table.indexColumns, table.rows]);

  const filteredRows = useMemo(() => {
    if (!searchTerm) return sortedRows;
    return sortedRows.filter((row) => row.some((cell) => cell.toLowerCase().includes(searchTerm)));
  }, [searchTerm, sortedRows]);

  const displayRows = useMemo(
    () => filteredRows.slice(0, MAX_DISPLAY_ROWS),
    [filteredRows]
  );
  const hasFilter = searchTerm.length > 0;
  const sortLabel = sortColumn == null ? null : headers[sortColumn] ?? `Column ${sortColumn + 1}`;

  const stickyLeftOffsets = useMemo(() => {
    const offsets: number[] = [];
    let cumulative = 0;
    for (let index = 0; index < table.indexColumns; index += 1) {
      offsets[index] = cumulative;
      cumulative += columnWidths[index] ?? measuredIndexWidths[index] ?? 0;
    }
    return offsets;
  }, [columnWidths, measuredIndexWidths, table.indexColumns]);

  const readIndexHeaderWidths = useCallback(() => {
    if (table.indexColumns <= 0) return;
    const nextWidths: Record<number, number> = {};
    for (let index = 0; index < table.indexColumns; index += 1) {
      const cell = headerCellRefs.current[index];
      if (!cell) continue;
      nextWidths[index] = Math.max(60, Math.round(cell.getBoundingClientRect().width));
    }
    setMeasuredIndexWidths((previous) => (recordsMatch(previous, nextWidths) ? previous : nextWidths));
  }, [table.indexColumns]);

  useEffect(() => {
    if (table.indexColumns <= 0) return;

    const raf = requestAnimationFrame(() => {
      readIndexHeaderWidths();
    });

    if (typeof ResizeObserver === 'undefined') {
      return () => cancelAnimationFrame(raf);
    }

    const observer = new ResizeObserver(() => {
      readIndexHeaderWidths();
    });

    for (let index = 0; index < table.indexColumns; index += 1) {
      const cell = headerCellRefs.current[index];
      if (cell) observer.observe(cell);
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [columnWidths, readIndexHeaderWidths, table.indexColumns]);

  const updateColumnWidth = useCallback((columnIndex: number, width: number) => {
    setColumnWidths((previous) => {
      if (previous[columnIndex] === width) {
        return previous;
      }
      return { ...previous, [columnIndex]: width };
    });
  }, []);

  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>, columnIndex: number) => {
    event.preventDefault();
    event.stopPropagation();

    cleanupResizeRef.current?.();

    const headerCell = headerCellRefs.current[columnIndex];
    const startWidth = columnWidths[columnIndex] ?? headerCell?.getBoundingClientRect().width ?? 120;
    resizeStateRef.current = {
      columnIndex,
      startX: event.clientX,
      startWidth,
    };
    setResizingColumn(columnIndex);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      pendingWidthRef.current = Math.max(
        60,
        Math.round(resizeState.startWidth + moveEvent.clientX - resizeState.startX)
      );

      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const activeResize = resizeStateRef.current;
        const pendingWidth = pendingWidthRef.current;
        if (!activeResize || pendingWidth == null) return;
        updateColumnWidth(activeResize.columnIndex, pendingWidth);
      });
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      cleanupResizeRef.current = null;
      resizeStateRef.current = null;
      pendingWidthRef.current = null;
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      setResizingColumn(null);
    };

    const onMouseUp = () => {
      cleanup();
    };

    cleanupResizeRef.current = cleanup;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [columnWidths, updateColumnWidth]);

  const handleSortToggle = useCallback((columnIndex: number) => {
    if (columnIndex < table.indexColumns) return;

    if (sortColumn !== columnIndex) {
      setSortColumn(columnIndex);
      setSortDirection('asc');
      return;
    }

    if (sortDirection === 'asc') {
      setSortDirection('desc');
      return;
    }

    if (sortDirection === 'desc') {
      setSortColumn(null);
      setSortDirection(null);
      return;
    }

    setSortDirection('asc');
  }, [sortColumn, sortDirection, table.indexColumns]);

  const downloadCsv = useCallback(() => {
    if (!hasCsvData || typeof document === 'undefined') return;

    const lines: string[] = [];
    if (table.headers.length > 0) {
      const paddedHeaders = Array.from(
        { length: columnCount },
        (_, index) => table.headers[index] ?? ''
      );
      lines.push(paddedHeaders.map(escapeCsvCell).join(','));
    }

    for (const row of table.rows) {
      const paddedRow = Array.from({ length: columnCount }, (_, index) => row[index] ?? '');
      lines.push(paddedRow.map(escapeCsvCell).join(','));
    }

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = sanitizeCsvFilename(title);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }, [columnCount, hasCsvData, table.headers, table.rows, title]);

  const tableStatusParts: string[] = [];
  if (displayRows.length < filteredRows.length) {
    tableStatusParts.push(
      `Showing ${displayRows.length.toLocaleString()} of ${filteredRows.length.toLocaleString()} rows x ${colLabel}`
    );
  } else if (!hasFilter && displayRows.length < totalRows) {
    tableStatusParts.push(
      `Showing ${displayRows.length.toLocaleString()} of ${totalRows.toLocaleString()} rows x ${colLabel}`
    );
  } else {
    tableStatusParts.push(
      `Showing ${displayRows.length.toLocaleString()} rows x ${colLabel}`
    );
  }
  if (hasFilter) {
    tableStatusParts.push(
      `${filteredRows.length.toLocaleString()} of ${parsedRows.toLocaleString()} rows match`
    );
  }
  if (sortLabel && sortDirection) {
    tableStatusParts.push(`Sorted by ${sortLabel} (${sortDirection})`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Filter rows..."
            className="h-7 pl-6 pr-7 text-xs"
            aria-label="Filter rows"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              className="absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground"
              aria-label="Clear filter"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setTextWrap((value) => !value)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs transition-colors',
            textWrap
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground/70 hover:text-foreground'
          )}
          aria-pressed={textWrap}
        >
          <AlignJustify className="size-3" />
          Wrap
        </button>

        <button
          type="button"
          onClick={downloadCsv}
          disabled={!hasCsvData}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs transition-colors',
            hasCsvData
              ? 'text-muted-foreground/70 hover:text-foreground'
              : 'cursor-not-allowed text-muted-foreground/40'
          )}
        >
          <Download className="size-3" />
          Download as CSV
        </button>
      </div>

      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto',
          resizingColumn !== null && 'cursor-col-resize select-none'
        )}
      >
        <table
          className={cn(
            'min-w-full border-collapse text-xs',
            textWrap
              ? 'w-max [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal'
              : 'w-full table-fixed [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap'
          )}
        >
          <colgroup>
            {Array.from({ length: columnCount }, (_, index) => (
              <col
                key={`column-${index}`}
                style={columnWidths[index] != null ? { width: `${columnWidths[index]}px` } : undefined}
              />
            ))}
          </colgroup>

          <TableHeader className="[&_tr]:border-b [&_tr]:border-border/80">
            <TableRow className="sticky top-0 z-30 h-auto border-border/80 bg-muted hover:bg-muted">
              {headers.map((header, columnIndex) => {
                const isIndexColumn = columnIndex < table.indexColumns;
                const isLastIndexColumn =
                  table.indexColumns > 0 && columnIndex === table.indexColumns - 1;
                const isSortedColumn = sortColumn === columnIndex && sortDirection != null;
                const stickyStyle: CSSProperties | undefined = isIndexColumn
                  ? { position: 'sticky', left: stickyLeftOffsets[columnIndex] ?? 0 }
                  : undefined;

                return (
                  <th
                    key={`header-${columnIndex}`}
                    ref={(node) => {
                      headerCellRefs.current[columnIndex] = node;
                    }}
                    style={stickyStyle}
                    className={cn(
                      'relative h-auto px-3 py-2 text-xs font-medium text-muted-foreground',
                      isIndexColumn && 'z-30 bg-muted text-muted-foreground/70',
                      isLastIndexColumn && 'border-r border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]',
                      !textWrap && 'overflow-hidden text-ellipsis'
                    )}
                  >
                    {isIndexColumn ? (
                      <span className="block truncate">{header}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSortToggle(columnIndex)}
                        className="flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <span className="truncate">{header}</span>
                        {isSortedColumn ? (
                          sortDirection === 'asc' ? (
                            <ArrowUp className="size-3 shrink-0" />
                          ) : (
                            <ArrowDown className="size-3 shrink-0" />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 shrink-0 opacity-45" />
                        )}
                      </button>
                    )}
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      className="absolute right-0 top-0 bottom-0 z-40 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/40"
                      onMouseDown={(event) => startResize(event, columnIndex)}
                    />
                  </th>
                );
              })}
            </TableRow>
          </TableHeader>

          <TableBody className="[&_tr:last-child]:border-b-0">
            {displayRows.length === 0 ? (
              <TableRow className="border-b border-border/40">
                <TableCell colSpan={Math.max(columnCount, 1)} className="px-3 py-4 text-xs text-muted-foreground/80">
                  No rows match the current filter.
                </TableCell>
              </TableRow>
            ) : (
              displayRows.map((row, rowIndex) => {
                return (
                  <TableRow
                    key={`row-${rowIndex}`}
                    className={cn(
                      'border-b border-border/40',
                      'hover:bg-muted/30'
                    )}
                  >
                    {Array.from({ length: columnCount }, (_, columnIndex) => {
                      const cellValue = row[columnIndex] ?? '';
                      const isIndexColumn = columnIndex < table.indexColumns;
                      const isLastIndexColumn =
                        table.indexColumns > 0 && columnIndex === table.indexColumns - 1;
                      const numericCell = !isIndexColumn && isNumeric(cellValue);
                      const stickyStyle: CSSProperties | undefined = isIndexColumn
                        ? { position: 'sticky', left: stickyLeftOffsets[columnIndex] ?? 0 }
                        : undefined;

                      if (isIndexColumn) {
                        return (
                          <th
                            key={`row-${rowIndex}-col-${columnIndex}`}
                            scope="row"
                            style={stickyStyle}
                            className={cn(
                              'px-3 py-1.5 text-left text-xs font-normal text-muted-foreground/70',
                              'bg-background',
                              'z-10',
                              isLastIndexColumn && 'border-r border-border/40 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]',
                              !textWrap && 'overflow-hidden text-ellipsis'
                            )}
                          >
                            {cellValue}
                          </th>
                        );
                      }

                      return (
                        <TableCell
                          key={`row-${rowIndex}-col-${columnIndex}`}
                          className={cn(
                            'px-3 py-1.5 text-xs text-foreground/90',
                            numericCell && 'font-mono tabular-nums text-right',
                            !textWrap && 'overflow-hidden text-ellipsis'
                          )}
                        >
                          {cellValue}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </table>
      </div>

      <div className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground/70">
        {tableStatusParts.join(' | ')}
      </div>
    </div>
  );
}
