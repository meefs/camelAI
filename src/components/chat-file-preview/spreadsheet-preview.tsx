'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { FullScreenDialog } from './notebook-preview/full-screen-dialog';
import { NotebookTable } from './notebook-preview/notebook-table';
import { TableViewer } from './notebook-preview/table-viewer';
import type { ParsedTable } from './notebook-preview/types';
import { getFileExtension } from './file-type-utils';

interface SpreadsheetPreviewProps {
  content: string;
  filename: string;
  contentType?: string;
  layout: 'panel' | 'dialog';
}

export function getSpreadsheetDelimiter(filename: string, contentType?: string): ',' | '\t' {
  const normalizedContentType = contentType?.toLowerCase();
  if (getFileExtension(filename) === 'tsv') return '\t';
  if (normalizedContentType?.includes('tab-separated-values')) return '\t';
  return ',';
}

export function parseDelimitedTable(text: string, delimiter: string): ParsedTable | null {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === delimiter) {
      current.push(field);
      field = '';
      continue;
    }

    if (char === '\n' || char === '\r') {
      current.push(field);
      field = '';
      if (current.some((cell) => cell.length > 0)) {
        rows.push(current);
      }
      current = [];

      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      continue;
    }

    field += char;
  }

  current.push(field);
  if (current.some((cell) => cell.length > 0)) {
    rows.push(current);
  }

  if (rows.length === 0) return null;

  return {
    headers: rows[0] ?? [],
    rows: rows.slice(1),
    indexColumns: 0,
    caption: null,
    sourceRowCount: null,
  };
}

export function SpreadsheetPreview({ content, filename, contentType, layout }: SpreadsheetPreviewProps) {
  const delimiter = getSpreadsheetDelimiter(filename, contentType);
  const table = useMemo(() => parseDelimitedTable(content, delimiter), [content, delimiter]);
  const [isFullScreen, setIsFullScreen] = useState(false);

  if (!table) {
    return (
      <pre
        className={cn(
          'w-full min-w-0 overflow-auto p-4 text-xs text-foreground',
          layout === 'dialog' && 'max-h-[60vh]'
        )}
      >
        {content || 'No preview content available.'}
      </pre>
    );
  }

  return (
    <>
      <div className={cn('p-4', layout === 'dialog' && 'max-h-[60vh] overflow-auto')}>
        <NotebookTable
          table={table}
          mode="notebook"
          onExpand={() => setIsFullScreen(true)}
        />
      </div>
      <FullScreenDialog
        open={isFullScreen}
        onOpenChange={setIsFullScreen}
        title={filename}
      >
        <TableViewer table={table} title={filename} />
      </FullScreenDialog>
    </>
  );
}
