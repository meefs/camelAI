'use client';

import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ParsedTable } from './types';

interface NotebookTableProps {
  table: ParsedTable;
  mode: 'report' | 'notebook';
}

function isNumeric(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized === '...' || normalized === 'NaN' || normalized === 'None') {
    return false;
  }
  return /^-?[\d,]+(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/.test(normalized);
}

export function NotebookTable({ table, mode }: NotebookTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showOverflowFade, setShowOverflowFade] = useState(false);
  const isReport = mode === 'report';
  const columnCount = Math.max(0, table.headers.length, ...table.rows.map((row) => row.length));
  const rowCount = table.rows.length;

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
  }, [updateOverflowFade, columnCount, rowCount]);

  return (
    <div className="relative w-full min-w-0">
      <div
        className={cn(
          'relative min-w-0 overflow-hidden',
          isReport && 'rounded-xl border border-border/60 bg-background/50 shadow-sm'
        )}
      >
        <div ref={scrollRef} className="min-w-0 overflow-x-auto">
          <table className="w-max min-w-full border-collapse text-xs">
            {table.headers.length > 0 ? (
              <TableHeader className="[&_tr]:border-b [&_tr]:border-border/80">
                <TableRow className="h-auto border-border/80 bg-muted/40 hover:bg-muted/40">
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
              {table.rows.map((row, rowIndex) => (
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
                    const numericCell = !isIndexColumn && isNumeric(cellValue);

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
                          {cellValue}
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
                        {cellValue}
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

      {table.caption ? (
        <p className="mt-1.5 text-xs text-muted-foreground/60">{table.caption}</p>
      ) : null}
    </div>
  );
}
