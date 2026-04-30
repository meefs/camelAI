
'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { SpreadsheetCanvasSurface } from './canvas-surface';
import { parseSpreadsheetWorkbook } from './parse-workbook';
import type { SpreadsheetPreviewProps } from './types';

export function SpreadsheetPreview({
  content,
  filename,
  contentType,
  layout,
  onToolbarStateChange,
}: SpreadsheetPreviewProps) {
  const workbook = useMemo(
    () => parseSpreadsheetWorkbook(content, filename, contentType),
    [content, filename, contentType],
  );

  if (!workbook) {
    return (
      <pre
        className={cn(
          'w-full min-w-0 overflow-auto p-4 text-xs',
          'text-foreground',
          layout === 'dialog' && 'max-h-[60vh]',
        )}
      >
        {typeof content === 'string'
          ? content || 'No preview content available.'
          : 'Unable to parse this spreadsheet.'}
      </pre>
    );
  }

  return (
    <SpreadsheetCanvasSurface
      workbook={workbook}
      layout={layout}
      onToolbarStateChange={onToolbarStateChange}
    />
  );
}
