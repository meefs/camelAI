'use client';

import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import {
  getFileExtension,
  getPreviewType,
  isBinarySpreadsheet,
  isImageFile,
} from '@/components/chat-file-preview/file-type-utils';
import {
  getSpreadsheetDelimiter,
  parseDelimitedRows,
} from '@/components/chat-file-preview/spreadsheet/parse-delimited';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { Skeleton } from '@/components/ui/skeleton';
import { formatFileSize } from '@/components/file-card';
import { cn } from '@/lib/utils';

const HOVER_TEXT_RENDER_MAX_CHARS = 4_000;

export type AttachmentHoverKind = 'image' | 'table' | 'markdown' | 'text' | 'metadata';

export type AttachmentPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'error'; message: string };

export interface DelimitedPreviewShape {
  header: string[];
  body: string[][];
  totalRows: number;
  totalCols: number;
  cols: number;
}

export interface AttachmentHoverPreviewProps {
  /** Header title: chat title for transcripts, original filename otherwise. */
  displayName: string;
  /** Real filename with extension; drives extension labels and CSV/TSV delimiters. */
  filename: string;
  size?: number;
  contentType?: string;
  kind: AttachmentHoverKind;
  imageUrl: string | null;
  state: AttachmentPreviewState;
  /** Source-chat attribution text. Row is omitted entirely when absent. */
  footer?: ReactNode;
}

export function getAttachmentHoverKind(
  filename: string,
  contentType?: string,
): AttachmentHoverKind {
  const previewType = getPreviewType(filename, contentType);
  switch (previewType) {
    case 'image':
    case 'svg':
      return isImageFile(filename, contentType) ? 'image' : 'metadata';
    case 'spreadsheet':
      return isBinarySpreadsheet(filename, contentType) ? 'metadata' : 'table';
    case 'markdown':
      return 'markdown';
    case 'code':
    case 'text':
    case 'json':
    case 'jsonl':
    case 'html':
      return 'text';
    default:
      return 'metadata';
  }
}

export function shapeDelimitedPreview(
  text: string,
  truncated: boolean,
  filename: string,
  contentType?: string,
): DelimitedPreviewShape {
  const rows = parseDelimitedRows(text, getSpreadsheetDelimiter(filename, contentType));
  const safeRows = truncated ? rows.slice(0, -1) : rows;
  const header = safeRows[0] ?? [];
  const body = safeRows.slice(1, 9);
  const totalRows = Math.max(safeRows.length - 1, 0);
  const totalCols = Math.max(header.length, ...body.map((row) => row.length), 0);
  const cols = Math.min(totalCols, 6);

  return { header, body, totalRows, totalCols, cols };
}

function AttachmentHeader({
  displayName,
  filename,
  size,
}: {
  displayName: string;
  filename: string;
  size?: number;
}) {
  const ext = getFileExtension(filename).toUpperCase() || 'FILE';

  return (
    <div className="space-y-0.5 px-3 py-2.5">
      <p className="break-words text-sm font-medium leading-snug text-foreground">
        {displayName}
      </p>
      <p className="text-xs text-muted-foreground">
        {ext}
        {size != null ? ` · ${formatFileSize(size)}` : ''}
      </p>
    </div>
  );
}

function LoadingBody() {
  return (
    <div className="space-y-2 bg-muted/30 px-3 py-3">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

function MetadataBody({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="px-3 pb-2.5 text-xs text-muted-foreground">{message}</p>;
}

function ImageBody({
  imageUrl,
  displayName,
}: {
  imageUrl: string;
  displayName: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative bg-muted/30">
      {!loaded && !failed ? <Skeleton className="h-40 w-full rounded-none" /> : null}
      {failed ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          Couldn&apos;t load image.
        </p>
      ) : (
        <img
          src={imageUrl}
          alt={displayName}
          className={cn(
            'max-h-60 w-full object-contain',
            !loaded && 'absolute h-0 opacity-0',
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function TableBody({
  text,
  truncated,
  filename,
  contentType,
}: {
  text: string;
  truncated: boolean;
  filename: string;
  contentType?: string;
}) {
  const shape = shapeDelimitedPreview(text, truncated, filename, contentType);
  if (shape.header.length === 0 && shape.body.length === 0) {
    return <MetadataBody message="Empty file." />;
  }

  const clippedColumns = Math.max(0, shape.totalCols - shape.cols);
  const showFootnote = truncated || shape.totalRows > shape.body.length || clippedColumns > 0;

  return (
    <div>
      <table className="w-full table-fixed text-[11px] tabular-nums">
        <thead>
          <tr>
            {Array.from({ length: shape.cols }, (_, index) => (
              <th
                key={index}
                className="truncate bg-muted/50 px-2 py-1 text-left font-medium text-muted-foreground"
              >
                {shape.header[index] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shape.body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: shape.cols }, (_, columnIndex) => (
                <td
                  key={columnIndex}
                  className="truncate border-b border-border/50 px-2 py-1 text-foreground"
                >
                  {row[columnIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {showFootnote ? (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
          First {shape.body.length} rows
          {clippedColumns > 0 ? ` · ${clippedColumns} more columns` : ''}
        </div>
      ) : null}
    </div>
  );
}

function MarkdownBody({
  text,
  truncated,
}: {
  text: string;
  truncated: boolean;
}) {
  const shownText = text.slice(0, HOVER_TEXT_RENDER_MAX_CHARS);
  const clipped = truncated || text.length > HOVER_TEXT_RENDER_MAX_CHARS;

  return (
    <div className="bg-muted/30">
      <div className="max-h-[280px] overflow-y-auto px-3 py-2.5">
        <MarkdownRenderer
          content={shownText || 'Empty file.'}
          variant="default"
          className="text-sm"
        />
      </div>
      {clipped ? (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
          Preview truncated
        </div>
      ) : null}
    </div>
  );
}

function TextBody({
  text,
  truncated,
}: {
  text: string;
  truncated: boolean;
}) {
  const shownText = text.slice(0, HOVER_TEXT_RENDER_MAX_CHARS);
  const clipped = truncated || text.length > HOVER_TEXT_RENDER_MAX_CHARS;

  return (
    <div className="bg-muted/30">
      <pre className="max-h-[280px] overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground">
        {shownText || 'Empty file.'}
      </pre>
      {clipped ? (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
          Preview truncated
        </div>
      ) : null}
    </div>
  );
}

function AttachmentBody({
  kind,
  imageUrl,
  state,
  displayName,
  filename,
  contentType,
}: {
  kind: AttachmentHoverKind;
  imageUrl: string | null;
  state: AttachmentPreviewState;
  displayName: string;
  filename: string;
  contentType?: string;
}) {
  if (state.status === 'error') {
    return <MetadataBody message={state.message} />;
  }

  if (kind === 'image') {
    return imageUrl ? (
      <ImageBody key={imageUrl} imageUrl={imageUrl} displayName={displayName} />
    ) : (
      <MetadataBody />
    );
  }

  if (kind === 'metadata') {
    return <MetadataBody />;
  }

  if (state.status === 'idle' || state.status === 'loading') {
    return <LoadingBody />;
  }

  if (kind === 'table') {
    return (
      <TableBody
        text={state.text}
        truncated={state.truncated}
        filename={filename}
        contentType={contentType}
      />
    );
  }

  if (kind === 'markdown') {
    return <MarkdownBody text={state.text} truncated={state.truncated} />;
  }

  return <TextBody text={state.text} truncated={state.truncated} />;
}

export function AttachmentHoverPreview({
  displayName,
  filename,
  size,
  contentType,
  kind,
  imageUrl,
  state,
  footer,
}: AttachmentHoverPreviewProps): ReactElement {
  return (
    <div className="bg-popover text-popover-foreground">
      <AttachmentHeader displayName={displayName} filename={filename} size={size} />
      <AttachmentBody
        kind={kind}
        imageUrl={imageUrl}
        state={state}
        displayName={displayName}
        filename={filename}
        contentType={contentType}
      />
      {footer != null ? (
        <div className="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground">
          <MessageSquare className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{footer}</span>
        </div>
      ) : null}
    </div>
  );
}
