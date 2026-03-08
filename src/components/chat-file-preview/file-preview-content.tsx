'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { CodePreview } from './code-preview';
import { getPreviewType } from './file-type-utils';
import { NotebookPreview } from './notebook-preview';
import type { NotebookFile } from './notebook-preview';
import { SpreadsheetPreview } from './spreadsheet-preview';

const MAX_TEXT_LINES = 500;
const MAX_SPREADSHEET_LINES = 500;

type PreviewLayout = 'dialog' | 'panel';

type TextStatus = 'idle' | 'loading' | 'ready' | 'error';

function truncateTextLines(text: string, maxLines = MAX_TEXT_LINES) {
  const lines = text.split('\n');
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { text, truncated: false, totalLines };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    totalLines,
  };
}

function getFilenameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function getPreviewErrorMessage(previewType: string, status?: number): string {
  if (status === 404 || status === 410) {
    return 'This file no longer exists in the workspace.';
  }
  if (previewType === 'notebook') {
    return 'Unable to preview this notebook.';
  }
  return 'Unable to preview this file.';
}

function ImagePreview({
  src,
  alt,
  layout,
}: {
  src: string;
  alt: string;
  layout: PreviewLayout;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [src]);

  return (
    <div className="relative flex min-h-[200px] items-center justify-center">
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <p className="text-sm text-muted-foreground">Failed to load image.</p>
      )}
      {!error && (
        <img
          src={src}
          alt={alt}
          className={cn(
            'w-full object-contain transition-opacity duration-150',
            layout === 'panel' ? 'max-h-full h-full' : 'max-h-[60vh]',
            loaded ? 'opacity-100' : 'opacity-0'
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
}

export interface FilePreviewContentProps {
  filename: string;
  previewUrl: string;
  contentType?: string;
  layout?: PreviewLayout;
  notebookViewMode?: 'report' | 'notebook';
  markdownViewMode?: 'rendered' | 'source';
  onNotebookStateChange?: (state: NotebookPreviewLoadState) => void;
}

export interface NotebookPreviewLoadState {
  notebook: NotebookFile | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

function FilePreviewContentComponent({
  filename,
  previewUrl,
  contentType,
  layout = 'dialog',
  notebookViewMode,
  markdownViewMode,
  onNotebookStateChange,
}: FilePreviewContentProps) {
  const previewType = useMemo(
    () => getPreviewType(filename, contentType),
    [filename, contentType]
  );

  const [textPreview, setTextPreview] = useState('');
  const [textStatus, setTextStatus] = useState<TextStatus>('idle');
  const [textErrorMessage, setTextErrorMessage] = useState('Unable to preview this file.');
  const [notebook, setNotebook] = useState<NotebookFile | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [lineInfo, setLineInfo] = useState<{ truncated: boolean; totalLines: number }>({
    truncated: false,
    totalLines: 0,
  });
  const notebookStateChangeRef = useRef(onNotebookStateChange);

  useEffect(() => {
    notebookStateChangeRef.current = onNotebookStateChange;
  }, [onNotebookStateChange]);

  useEffect(() => {
    const notifyNotebookStateChange = notebookStateChangeRef.current;
    if (!notifyNotebookStateChange) return;
    if (previewType !== 'notebook') {
      notifyNotebookStateChange({ notebook: null, status: 'idle' });
    }
  }, [previewType]);

  useEffect(() => {
    const shouldFetchText =
      previewType === 'text' ||
      previewType === 'code' ||
      previewType === 'spreadsheet' ||
      previewType === 'notebook' ||
      previewType === 'markdown';
    if (!shouldFetchText) return;

    const controller = new AbortController();
    let cancelled = false;

    setTextStatus('loading');
    setTextErrorMessage(getPreviewErrorMessage(previewType));
    setNotebook(null);
    if (previewType === 'notebook') {
      notebookStateChangeRef.current?.({ notebook: null, status: 'loading' });
    }

    fetch(previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const error = new Error('Failed to load preview') as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
        const bodyText = await response.text();
        if (previewType === 'notebook') {
          let parsed: NotebookFile | null = null;
          try {
            parsed = JSON.parse(bodyText) as NotebookFile;
          } catch {
            throw new Error('Invalid notebook JSON');
          }
          if (cancelled) return;
          setNotebook(parsed);
          setTextStatus('ready');
          notebookStateChangeRef.current?.({ notebook: parsed, status: 'ready' });
          return;
        }

        if (previewType === 'spreadsheet') {
          if (cancelled) return;
          const { text: truncatedText, truncated, totalLines } = truncateTextLines(
            bodyText,
            MAX_SPREADSHEET_LINES
          );
          setTextPreview(truncatedText);
          setLineInfo({ truncated, totalLines });
          setTextStatus('ready');
          return;
        }

        if (cancelled) return;
        const { text: truncatedText, truncated, totalLines } = truncateTextLines(bodyText);
        setTextPreview(truncatedText);
        setLineInfo({ truncated, totalLines });
        setTextStatus('ready');
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') return;
        const status = typeof error?.status === 'number' ? error.status : undefined;
        setTextErrorMessage(getPreviewErrorMessage(previewType, status));
        setTextStatus('error');
        if (previewType === 'notebook') {
          notebookStateChangeRef.current?.({ notebook: null, status: 'error' });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [previewType, previewUrl]);

  useEffect(() => {
    if (previewType === 'pdf' || previewType === 'audio' || previewType === 'video') {
      setMediaLoading(true);
      setMediaError(false);
    } else {
      setMediaLoading(false);
      setMediaError(false);
    }
  }, [previewType, previewUrl]);

  return (
    <div className={cn('overflow-hidden', layout === 'panel' && 'h-full')}>
      {previewType === 'image' && (
        <div className={cn(layout === 'panel' && 'p-3')}>
          <ImagePreview src={previewUrl} alt={filename} layout={layout} />
        </div>
      )}

      {previewType === 'pdf' && (
        <div className={cn('relative min-h-[200px]', layout === 'panel' ? 'h-full p-3' : 'h-full')}>
          {mediaLoading && !mediaError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {mediaError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Failed to load preview.</p>
            </div>
          )}
          <iframe
            src={previewUrl}
            title={filename}
            className={cn(
              'w-full rounded-md border',
              layout === 'panel' ? 'h-full min-h-[320px]' : 'h-[60vh]',
              mediaLoading && 'opacity-0'
            )}
            onLoad={() => setMediaLoading(false)}
          />
        </div>
      )}

      {previewType === 'audio' && (
        <div className={cn('relative min-h-[80px]', layout === 'panel' && 'p-3')}>
          {mediaLoading && !mediaError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {mediaError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Failed to load preview.</p>
            </div>
          )}
          <audio
            controls
            className="w-full"
            onLoadedData={() => setMediaLoading(false)}
            onError={() => {
              setMediaLoading(false);
              setMediaError(true);
            }}
          >
            <source src={previewUrl} />
            Your browser does not support the audio element.
          </audio>
        </div>
      )}

      {previewType === 'video' && (
        <div className={cn('relative min-h-[200px]', layout === 'panel' && 'p-3')}>
          {mediaLoading && !mediaError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {mediaError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Failed to load preview.</p>
            </div>
          )}
          <video
            controls
            className={cn('w-full rounded-md', layout === 'panel' ? 'h-full min-h-[320px]' : 'max-h-[60vh]')}
            onLoadedData={() => setMediaLoading(false)}
            onError={() => {
              setMediaLoading(false);
              setMediaError(true);
            }}
          >
            <source src={previewUrl} />
            Your browser does not support the video tag.
          </video>
        </div>
      )}

      {previewType === 'text' && (
        <div>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && (
            <>
              <pre
                className={cn(
                  'w-full min-w-0 overflow-auto text-xs',
                  layout === 'panel'
                    ? 'h-full max-h-full p-4'
                    : 'max-h-[60vh] rounded-md border bg-muted/30 p-3',
                  textPreview ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {textPreview || 'No preview content available.'}
              </pre>
              {lineInfo.truncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing first {MAX_TEXT_LINES} of {lineInfo.totalLines} lines.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {previewType === 'code' && (
        <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && (
            <CodePreview
              code={textPreview}
              filename={filename}
              layout={layout}
              truncated={lineInfo.truncated}
              totalLines={lineInfo.totalLines}
              maxLines={MAX_TEXT_LINES}
            />
          )}
        </div>
      )}

      {previewType === 'spreadsheet' && (
        <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && (
            <SpreadsheetPreview
              content={textPreview}
              filename={filename}
              contentType={contentType}
              layout={layout}
            />
          )}
          {textStatus === 'ready' && lineInfo.truncated && (
            <p className="mt-2 px-4 text-xs text-muted-foreground">
              Showing first {MAX_SPREADSHEET_LINES} of {lineInfo.totalLines} lines.
            </p>
          )}
        </div>
      )}

      {previewType === 'markdown' && (
        <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && (
            (markdownViewMode ?? 'rendered') === 'rendered' ? (
              <div
                className={cn(
                  layout === 'panel'
                    ? 'h-full overflow-auto'
                    : 'max-h-[60vh] overflow-auto'
                )}
              >
                <div className="mx-auto max-w-3xl px-6 py-6">
                  <MarkdownRenderer content={textPreview} />
                </div>
              </div>
            ) : (
              <pre
                className={cn(
                  'w-full min-w-0 overflow-auto whitespace-pre-wrap text-xs',
                  layout === 'panel'
                    ? 'h-full max-h-full'
                    : 'max-h-[60vh] rounded-md border bg-muted/30 p-3',
                  textPreview ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {textPreview || 'No preview content available.'}
              </pre>
            )
          )}
          {lineInfo.truncated && (
            <p className="mt-2 px-3 text-xs text-muted-foreground">
              Showing first {MAX_TEXT_LINES} of {lineInfo.totalLines} lines.
            </p>
          )}
        </div>
      )}

      {previewType === 'notebook' && (
        <div className={cn(layout === 'panel' && 'h-full')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="text-sm text-muted-foreground">Loading notebook...</p>
          )}
          {textStatus === 'error' && (
            <p className="text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && notebook && (
            <NotebookPreview
              notebook={notebook}
              layout={layout}
              viewMode={notebookViewMode ?? (layout === 'panel' ? 'report' : 'notebook')}
            />
          )}
        </div>
      )}

      {previewType === 'other' && (
        <div className={cn('flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-sm text-muted-foreground', layout === 'panel' && 'm-3')}>
          <span>No preview available for {getFilenameFromPath(filename)}.</span>
        </div>
      )}
    </div>
  );
}

function areFilePreviewContentPropsEqual(
  prev: FilePreviewContentProps,
  next: FilePreviewContentProps
): boolean {
  return (
    prev.filename === next.filename &&
    prev.previewUrl === next.previewUrl &&
    prev.contentType === next.contentType &&
    prev.layout === next.layout &&
    prev.notebookViewMode === next.notebookViewMode &&
    prev.markdownViewMode === next.markdownViewMode
  );
}

export const FilePreviewContent = memo(
  FilePreviewContentComponent,
  areFilePreviewContentPropsEqual
);
