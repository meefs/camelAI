'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPreviewType } from './file-type-utils';
import { NotebookPreview } from './notebook-preview';
import type { NotebookFile } from './notebook-preview';

const MAX_TEXT_LINES = 500;

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
}

function FilePreviewContentComponent({
  filename,
  previewUrl,
  contentType,
  layout = 'dialog',
  notebookViewMode,
}: FilePreviewContentProps) {
  const previewType = useMemo(
    () => getPreviewType(filename, contentType),
    [filename, contentType]
  );

  const [textPreview, setTextPreview] = useState('');
  const [textStatus, setTextStatus] = useState<TextStatus>('idle');
  const [notebook, setNotebook] = useState<NotebookFile | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [lineInfo, setLineInfo] = useState<{ truncated: boolean; totalLines: number }>({
    truncated: false,
    totalLines: 0,
  });

  useEffect(() => {
    const shouldFetchText = previewType === 'text' || previewType === 'notebook';
    if (!shouldFetchText) return;

    const controller = new AbortController();
    let cancelled = false;

    setTextStatus('loading');
    setNotebook(null);

    fetch(previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load preview');
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
        setTextStatus('error');
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
        <ImagePreview src={previewUrl} alt={filename} layout={layout} />
      )}

      {previewType === 'pdf' && (
        <div className="relative min-h-[200px] h-full">
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
        <div className="relative min-h-[80px]">
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
        <div className="relative min-h-[200px]">
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
            <p className="text-sm text-muted-foreground">Unable to preview this file.</p>
          )}
          {textStatus === 'ready' && (
            <>
              <pre
                className={cn(
                  'w-full min-w-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs',
                  layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]',
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

      {previewType === 'notebook' && (
        <div className={cn(layout === 'panel' && 'h-full')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="text-sm text-muted-foreground">Loading notebook...</p>
          )}
          {textStatus === 'error' && (
            <p className="text-sm text-muted-foreground">Unable to preview this notebook.</p>
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-sm text-muted-foreground">
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
    prev.notebookViewMode === next.notebookViewMode
  );
}

export const FilePreviewContent = memo(
  FilePreviewContentComponent,
  areFilePreviewContentPropsEqual
);
