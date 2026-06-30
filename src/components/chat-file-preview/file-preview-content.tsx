'use client';

import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PREVIEW_INITIAL_MAX_LINES } from '@/lib/file-preview-limits';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { CodePreview, SourcePreview } from './code-preview';
import { getPreviewType, isBinarySpreadsheet } from './file-type-utils';
import { NotebookPreview } from './notebook-preview';
import type { NotebookFile } from './notebook-preview';
import { PreviewTruncationFooter } from './preview-truncation-footer';
import type { SpreadsheetToolbarState } from './spreadsheet';

const HTML_PREVIEW_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const HTML_SOURCE_CACHE_LIMIT = 20;
const htmlSourceCache = new Map<
  string,
  { text: string; lineInfo: PreviewLineInfo }
>();
const SpreadsheetPreview = lazy(() =>
  import('./spreadsheet').then((module) => ({ default: module.SpreadsheetPreview }))
);

type PreviewLayout = 'dialog' | 'panel';

type TextStatus = 'idle' | 'loading' | 'ready' | 'error';
type FullLoadStatus = 'idle' | 'loading' | 'error' | 'unavailable';
type PreviewTruncationReason = 'lines' | 'bytes';

interface PreviewLineInfo {
  truncated: boolean;
  truncatedBy?: PreviewTruncationReason;
  totalLines: number | null;
  maxLines: number;
  sizeBytes?: number;
}

interface TextPreviewResponse {
  text: string;
  truncated: boolean;
  truncatedBy?: PreviewTruncationReason;
  totalLines: number | null;
  maxLines: number;
  contentType?: string;
  size?: number;
}

type FormattedTextResult =
  | { ok: true; text: string; truncated: boolean; totalLines: number }
  | { ok: false; message: string };

function createInitialLineInfo(): PreviewLineInfo {
  return {
    truncated: false,
    totalLines: 0,
    maxLines: PREVIEW_INITIAL_MAX_LINES,
  };
}

function truncateTextLines(text: string, maxLines = PREVIEW_INITIAL_MAX_LINES) {
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

function lineInfoFromTextPreview(data: TextPreviewResponse): PreviewLineInfo {
  return {
    truncated: data.truncated,
    ...(data.truncatedBy ? { truncatedBy: data.truncatedBy } : {}),
    totalLines: data.totalLines,
    maxLines: data.maxLines || PREVIEW_INITIAL_MAX_LINES,
    sizeBytes: data.size,
  };
}

function lineInfoFromTruncation(
  result: ReturnType<typeof truncateTextLines>,
  maxLines = PREVIEW_INITIAL_MAX_LINES
): PreviewLineInfo {
  return {
    truncated: result.truncated,
    ...(result.truncated ? { truncatedBy: 'lines' as const } : {}),
    totalLines: result.totalLines,
    maxLines,
  };
}

function getTextLineCount(text: string): number {
  return text.split('\n').length;
}

function cacheHtmlSource(
  previewUrl: string,
  entry: { text: string; lineInfo: PreviewLineInfo }
) {
  htmlSourceCache.delete(previewUrl);
  htmlSourceCache.set(previewUrl, entry);
  if (htmlSourceCache.size > HTML_SOURCE_CACHE_LIMIT) {
    const firstKey = htmlSourceCache.keys().next().value;
    if (firstKey) htmlSourceCache.delete(firstKey);
  }
}

function formatJsonPreview(
  raw: string,
  maxLines: number | null = PREVIEW_INITIAL_MAX_LINES
): FormattedTextResult {
  try {
    const formatted = JSON.stringify(JSON.parse(raw), null, 2);
    const text = formatted ?? 'null';
    return {
      ok: true,
      ...(maxLines == null
        ? { text, truncated: false, totalLines: getTextLineCount(text) }
        : truncateTextLines(text, maxLines)),
    };
  } catch {
    return { ok: false, message: 'Invalid JSON. Showing raw source.' };
  }
}

function formatJsonLinesPreview(
  raw: string,
  maxLines: number | null = PREVIEW_INITIAL_MAX_LINES
): FormattedTextResult {
  const formattedValues: string[] = [];
  const lines = raw.split('\n');

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const formatted = JSON.stringify(JSON.parse(line), null, 2);
      formattedValues.push(formatted ?? 'null');
    } catch {
      return {
        ok: false,
        message: `Invalid JSONL on line ${index + 1}. Showing raw source.`,
      };
    }
  }

  const text = formattedValues.join('\n\n');
  return {
    ok: true,
    ...(maxLines == null
      ? { text, truncated: false, totalLines: getTextLineCount(text) }
      : truncateTextLines(text, maxLines)),
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

  useLayoutEffect(() => {
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

function HtmlPreview({
  src,
  title,
  layout,
}: {
  src: string;
  title: string;
  layout: PreviewLayout;
}) {
  return (
    <div className="relative h-full min-h-[240px]">
      <iframe
        src={src}
        title={title}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        className={cn(
          'w-full bg-white',
          layout === 'panel' ? 'h-full' : 'h-[60vh]'
        )}
      />
    </div>
  );
}

export interface FilePreviewContentProps {
  filename: string;
  previewUrl: string;
  fileTextPreviewUrl?: string;
  fileFullTextPreviewUrl?: string;
  contentType?: string;
  layout?: PreviewLayout;
  notebookViewMode?: 'report' | 'notebook';
  fileViewMode?: 'preview' | 'source';
  onNotebookStateChange?: (state: NotebookPreviewLoadState) => void;
  onSpreadsheetToolbarStateChange?: (state: SpreadsheetToolbarState | null) => void;
}

export interface NotebookPreviewLoadState {
  notebook: NotebookFile | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

function FilePreviewContentComponent({
  filename,
  previewUrl,
  fileTextPreviewUrl,
  fileFullTextPreviewUrl,
  contentType,
  layout = 'dialog',
  notebookViewMode,
  fileViewMode,
  onNotebookStateChange,
  onSpreadsheetToolbarStateChange,
}: FilePreviewContentProps) {
  const previewType = useMemo(
    () => getPreviewType(filename, contentType),
    [filename, contentType]
  );

  const [textPreview, setTextPreview] = useState('');
  const [spreadsheetBinary, setSpreadsheetBinary] = useState<ArrayBuffer | null>(null);
  const [textStatus, setTextStatus] = useState<TextStatus>('idle');
  const [textErrorMessage, setTextErrorMessage] = useState('Unable to preview this file.');
  const [formattedTextPreview, setFormattedTextPreview] = useState('');
  const [formattedTextError, setFormattedTextError] = useState<string | null>(null);
  const [formattedLineInfo, setFormattedLineInfo] =
    useState<PreviewLineInfo>(createInitialLineInfo);
  const [fullLoadStatus, setFullLoadStatus] = useState<FullLoadStatus>('idle');
  const [loadedFull, setLoadedFull] = useState(false);
  const [notebook, setNotebook] = useState<NotebookFile | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [lineInfo, setLineInfo] = useState<PreviewLineInfo>(createInitialLineInfo);
  const notebookStateChangeRef = useRef(onNotebookStateChange);
  const fullLoadControllerRef = useRef<AbortController | null>(null);
  const binarySpreadsheet = useMemo(
    () => previewType === 'spreadsheet' && isBinarySpreadsheet(filename, contentType),
    [contentType, filename, previewType]
  );
  const currentFileViewMode = fileViewMode ?? 'preview';
  const canLoadFull = Boolean(fileFullTextPreviewUrl) && lineInfo.truncated && !loadedFull;

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

  useLayoutEffect(() => {
    const shouldFetchText =
      previewType === 'text' ||
      previewType === 'code' ||
      previewType === 'spreadsheet' ||
      previewType === 'notebook' ||
      previewType === 'markdown' ||
      (previewType === 'html' && currentFileViewMode === 'source') ||
      (previewType === 'svg' && currentFileViewMode === 'source') ||
      previewType === 'json' ||
      previewType === 'jsonl';
    if (!shouldFetchText) return;

    const controller = new AbortController();
    let cancelled = false;
    const shouldUseTextPreviewRoute = Boolean(
      fileTextPreviewUrl &&
        previewType !== 'notebook' &&
        !(previewType === 'spreadsheet' && binarySpreadsheet)
    );
    const fetchUrl = shouldUseTextPreviewRoute ? fileTextPreviewUrl! : previewUrl;

    fullLoadControllerRef.current?.abort();
    fullLoadControllerRef.current = null;
    setTextStatus('loading');
    setTextErrorMessage(getPreviewErrorMessage(previewType));
    setTextPreview('');
    setSpreadsheetBinary(null);
    setLineInfo(createInitialLineInfo());
    setFormattedTextPreview('');
    setFormattedTextError(null);
    setFormattedLineInfo(createInitialLineInfo());
    setFullLoadStatus('idle');
    setLoadedFull(false);
    setNotebook(null);
    if (previewType === 'notebook') {
      notebookStateChangeRef.current?.({ notebook: null, status: 'loading' });
    }

    if (previewType === 'html') {
      const cached = htmlSourceCache.get(fetchUrl);
      if (cached) {
        setTextPreview(cached.text);
        setLineInfo(cached.lineInfo);
        setTextStatus('ready');
      }
    }

    fetch(fetchUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const error = new Error('Failed to load preview') as Error & { status?: number };
          error.status = response.status;
          throw error;
        }

        if (shouldUseTextPreviewRoute) {
          const data = (await response.json()) as TextPreviewResponse;
          if (cancelled) return;
          const nextLineInfo = lineInfoFromTextPreview(data);
          setTextPreview(data.text);
          setLineInfo(nextLineInfo);
          if (previewType === 'html') {
            cacheHtmlSource(fetchUrl, {
              text: data.text,
              lineInfo: nextLineInfo,
            });
          }
          if ((previewType === 'json' || previewType === 'jsonl') && !data.truncated) {
            const formatted =
              previewType === 'json'
                ? formatJsonPreview(data.text)
                : formatJsonLinesPreview(data.text);
            if (formatted.ok) {
              setFormattedTextPreview(formatted.text);
              setFormattedLineInfo(lineInfoFromTruncation(formatted));
              setFormattedTextError(null);
            } else {
              setFormattedTextPreview('');
              setFormattedLineInfo(createInitialLineInfo());
              setFormattedTextError(formatted.message);
            }
          }
          setTextStatus('ready');
          return;
        }

        if (previewType === 'spreadsheet' && binarySpreadsheet) {
          const bodyBuffer = await response.arrayBuffer();
          if (cancelled) return;
          setSpreadsheetBinary(bodyBuffer);
          setTextStatus('ready');
          return;
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
          const truncated = truncateTextLines(
            bodyText,
            PREVIEW_INITIAL_MAX_LINES
          );
          setTextPreview(truncated.text);
          setLineInfo(lineInfoFromTruncation(truncated, PREVIEW_INITIAL_MAX_LINES));
          setTextStatus('ready');
          return;
        }

        if (cancelled) return;
        const truncated = truncateTextLines(bodyText);
        setTextPreview(truncated.text);
        setLineInfo(lineInfoFromTruncation(truncated));
        if (previewType === 'html') {
          cacheHtmlSource(fetchUrl, {
            text: truncated.text,
            lineInfo: lineInfoFromTruncation(truncated),
          });
        }
        if (previewType === 'json' || previewType === 'jsonl') {
          const formatted =
            previewType === 'json'
              ? formatJsonPreview(bodyText)
              : formatJsonLinesPreview(bodyText);
          if (formatted.ok) {
            setFormattedTextPreview(formatted.text);
            setFormattedLineInfo(lineInfoFromTruncation(formatted));
            setFormattedTextError(null);
          } else {
            setFormattedTextPreview('');
            setFormattedLineInfo(createInitialLineInfo());
            setFormattedTextError(formatted.message);
          }
        }
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
      fullLoadControllerRef.current?.abort();
      fullLoadControllerRef.current = null;
    };
  }, [
    binarySpreadsheet,
    currentFileViewMode,
    fileFullTextPreviewUrl,
    fileTextPreviewUrl,
    previewType,
    previewUrl,
  ]);

  const handleLoadFull = useCallback(async () => {
    if (!fileFullTextPreviewUrl) return;

    fullLoadControllerRef.current?.abort();
    const controller = new AbortController();
    fullLoadControllerRef.current = controller;
    setFullLoadStatus('loading');

    try {
      const response = await fetch(fileFullTextPreviewUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error('Failed to load full preview'), {
          unavailable: response.status === 413 || response.status === 415,
        });
      }

      const data = (await response.json()) as TextPreviewResponse;
      if (controller.signal.aborted) return;

      setTextPreview(data.text);
      setLineInfo({
        ...lineInfoFromTextPreview(data),
        truncated: false,
      });

      if (previewType === 'json' || previewType === 'jsonl') {
        const formatted =
          previewType === 'json'
            ? formatJsonPreview(data.text, null)
            : formatJsonLinesPreview(data.text, null);
        if (formatted.ok) {
          setFormattedTextPreview(formatted.text);
          setFormattedLineInfo({
            truncated: false,
            totalLines: formatted.totalLines,
            maxLines: PREVIEW_INITIAL_MAX_LINES,
            sizeBytes: data.size,
          });
          setFormattedTextError(null);
        } else {
          setFormattedTextPreview('');
          setFormattedLineInfo(createInitialLineInfo());
          setFormattedTextError(formatted.message);
        }
      }

      setLoadedFull(true);
      setFullLoadStatus('idle');
    } catch (error) {
      if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
      setFullLoadStatus((error as { unavailable?: boolean })?.unavailable ? 'unavailable' : 'error');
    } finally {
      if (fullLoadControllerRef.current === controller) {
        fullLoadControllerRef.current = null;
      }
    }
  }, [fileFullTextPreviewUrl, previewType]);

  useLayoutEffect(() => {
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

      {previewType === 'html' && (
        <div
          className={cn(
            layout === 'panel' &&
              (currentFileViewMode === 'preview' ? 'h-full overflow-hidden' : 'h-full overflow-auto')
          )}
        >
          {currentFileViewMode === 'preview' ? (
            <HtmlPreview src={previewUrl} title={filename} layout={layout} />
          ) : (
            <>
              {(textStatus === 'loading' || textStatus === 'idle') && (
                <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
              )}
              {textStatus === 'error' && (
                <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
              )}
              {textStatus === 'ready' && (
                <SourcePreview
                  code={textPreview}
                  filename={filename}
                  layout={layout}
                  truncated={lineInfo.truncated}
                  truncatedBy={lineInfo.truncatedBy}
                  totalLines={lineInfo.totalLines}
                  maxLines={lineInfo.maxLines}
                  languageOverride="html"
                  onLoadFull={handleLoadFull}
                  loadFullStatus={fullLoadStatus}
                  canLoadFull={canLoadFull}
                  sizeBytes={lineInfo.sizeBytes}
                  downloadUrl={previewUrl}
                  downloadFilename={filename}
                />
              )}
            </>
          )}
        </div>
      )}

      {previewType === 'svg' && (
        <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
          {currentFileViewMode === 'source' && (textStatus === 'loading' || textStatus === 'idle') && (
            <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
          )}
          {currentFileViewMode === 'source' && textStatus === 'error' && (
            <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {currentFileViewMode === 'preview' ? (
            <div className={cn(layout === 'panel' && 'p-3')}>
              <ImagePreview src={previewUrl} alt={filename} layout={layout} />
            </div>
          ) : (
            textStatus === 'ready' && (
              <SourcePreview
                code={textPreview}
                filename={filename}
                layout={layout}
                truncated={lineInfo.truncated}
                truncatedBy={lineInfo.truncatedBy}
                totalLines={lineInfo.totalLines}
                maxLines={lineInfo.maxLines}
                languageOverride="html"
                onLoadFull={handleLoadFull}
                loadFullStatus={fullLoadStatus}
                canLoadFull={canLoadFull}
                sizeBytes={lineInfo.sizeBytes}
                downloadUrl={previewUrl}
                downloadFilename={filename}
              />
            )
          )}
        </div>
      )}

      {(previewType === 'json' || previewType === 'jsonl') && (
        <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' &&
            (currentFileViewMode === 'preview' ? (
              lineInfo.truncated ? (
                <SourcePreview
                  code={textPreview}
                  filename={filename}
                  layout={layout}
                  truncated={lineInfo.truncated}
                  truncatedBy={lineInfo.truncatedBy}
                  totalLines={lineInfo.totalLines}
                  maxLines={lineInfo.maxLines}
                  languageOverride="json"
                  onLoadFull={handleLoadFull}
                  loadFullStatus={fullLoadStatus}
                  canLoadFull={canLoadFull}
                  sizeBytes={lineInfo.sizeBytes}
                  downloadUrl={previewUrl}
                  downloadFilename={filename}
                />
              ) : formattedTextError ? (
                <>
                  <p className="p-3 text-sm text-muted-foreground">{formattedTextError}</p>
                  <SourcePreview
                    code={textPreview}
                    filename={filename}
                    layout={layout}
                    truncated={lineInfo.truncated}
                    truncatedBy={lineInfo.truncatedBy}
                    totalLines={lineInfo.totalLines}
                    maxLines={lineInfo.maxLines}
                    languageOverride="json"
                    onLoadFull={handleLoadFull}
                    loadFullStatus={fullLoadStatus}
                    canLoadFull={canLoadFull}
                    sizeBytes={lineInfo.sizeBytes}
                    downloadUrl={previewUrl}
                    downloadFilename={filename}
                  />
                </>
              ) : (
                <SourcePreview
                  code={formattedTextPreview}
                  filename={filename}
                  layout={layout}
                  truncated={formattedLineInfo.truncated}
                  truncatedBy={formattedLineInfo.truncatedBy}
                  totalLines={formattedLineInfo.totalLines}
                  maxLines={formattedLineInfo.maxLines}
                  languageOverride="json"
                  onLoadFull={handleLoadFull}
                  loadFullStatus={fullLoadStatus}
                  canLoadFull={canLoadFull}
                  sizeBytes={formattedLineInfo.sizeBytes ?? lineInfo.sizeBytes}
                  downloadUrl={previewUrl}
                  downloadFilename={filename}
                />
              )
            ) : (
              <SourcePreview
                code={textPreview}
                filename={filename}
                layout={layout}
                truncated={lineInfo.truncated}
                truncatedBy={lineInfo.truncatedBy}
                totalLines={lineInfo.totalLines}
                maxLines={lineInfo.maxLines}
                languageOverride="json"
                onLoadFull={handleLoadFull}
                loadFullStatus={fullLoadStatus}
                canLoadFull={canLoadFull}
                sizeBytes={lineInfo.sizeBytes}
                downloadUrl={previewUrl}
                downloadFilename={filename}
              />
            ))}
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
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
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
        <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && (
            <SourcePreview
              code={textPreview}
              filename={filename}
              layout={layout}
              truncated={lineInfo.truncated}
              truncatedBy={lineInfo.truncatedBy}
              totalLines={lineInfo.totalLines}
              maxLines={lineInfo.maxLines}
              onLoadFull={handleLoadFull}
              loadFullStatus={fullLoadStatus}
              canLoadFull={canLoadFull}
              sizeBytes={lineInfo.sizeBytes}
              downloadUrl={previewUrl}
              downloadFilename={filename}
            />
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
              truncatedBy={lineInfo.truncatedBy}
              totalLines={lineInfo.totalLines}
              maxLines={lineInfo.maxLines}
              onLoadFull={handleLoadFull}
              loadFullStatus={fullLoadStatus}
              canLoadFull={canLoadFull}
              sizeBytes={lineInfo.sizeBytes}
              downloadUrl={previewUrl}
              downloadFilename={filename}
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
          {textStatus === 'ready' && currentFileViewMode === 'source' && !binarySpreadsheet ? (
            <SourcePreview
              code={textPreview}
              filename={filename}
              layout={layout}
              truncated={lineInfo.truncated}
              truncatedBy={lineInfo.truncatedBy}
              totalLines={lineInfo.totalLines}
              maxLines={lineInfo.maxLines}
              onLoadFull={handleLoadFull}
              loadFullStatus={fullLoadStatus}
              canLoadFull={canLoadFull}
              sizeBytes={lineInfo.sizeBytes}
              downloadUrl={previewUrl}
              downloadFilename={filename}
            />
          ) : textStatus === 'ready' ? (
            <Suspense
              fallback={
                <div className="flex min-h-[200px] items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <SpreadsheetPreview
                content={spreadsheetBinary ?? textPreview}
                filename={filename}
                contentType={contentType}
                layout={layout}
                onToolbarStateChange={onSpreadsheetToolbarStateChange}
              />
            </Suspense>
          ) : null}
          {textStatus === 'ready' &&
            currentFileViewMode === 'preview' &&
            !binarySpreadsheet &&
            lineInfo.truncated && (
            <PreviewTruncationFooter
              shownLines={lineInfo.maxLines}
              totalLines={lineInfo.totalLines}
              truncatedBy={lineInfo.truncatedBy}
              canLoadFull={false}
              status="idle"
              onLoadFull={() => {}}
              hint="Switch to source or download for all rows."
            />
          )}
        </div>
      )}

      {previewType === 'markdown' && (
        <div
          className={cn(
            currentFileViewMode === 'preview'
              ? layout === 'panel'
                ? 'h-full overflow-auto'
                : 'max-h-[60vh] overflow-auto'
              : layout === 'panel' && 'h-full overflow-auto'
          )}
        >
          {(textStatus === 'loading' || textStatus === 'idle') && (
            <p className="text-sm text-muted-foreground">Loading preview...</p>
          )}
          {textStatus === 'error' && (
            <p className="text-sm text-muted-foreground">{textErrorMessage}</p>
          )}
          {textStatus === 'ready' && (
            currentFileViewMode === 'preview' ? (
              <>
                <div className="px-6 py-6">
                  <MarkdownRenderer content={textPreview} />
                </div>
                {lineInfo.truncated && (
                  <PreviewTruncationFooter
                    shownLines={lineInfo.maxLines}
                    totalLines={lineInfo.totalLines}
                    truncatedBy={lineInfo.truncatedBy}
                    canLoadFull={canLoadFull}
                    status={fullLoadStatus}
                    onLoadFull={handleLoadFull}
                    sizeBytes={lineInfo.sizeBytes}
                    downloadUrl={previewUrl}
                    downloadFilename={filename}
                  />
                )}
              </>
            ) : (
              <SourcePreview
                code={textPreview}
                filename={filename}
                layout={layout}
                truncated={lineInfo.truncated}
                truncatedBy={lineInfo.truncatedBy}
                totalLines={lineInfo.totalLines}
                maxLines={lineInfo.maxLines}
                languageOverride="markdown"
                onLoadFull={handleLoadFull}
                loadFullStatus={fullLoadStatus}
                canLoadFull={canLoadFull}
                sizeBytes={lineInfo.sizeBytes}
                downloadUrl={previewUrl}
                downloadFilename={filename}
              />
            )
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
    prev.fileTextPreviewUrl === next.fileTextPreviewUrl &&
    prev.fileFullTextPreviewUrl === next.fileFullTextPreviewUrl &&
    prev.contentType === next.contentType &&
    prev.layout === next.layout &&
    prev.notebookViewMode === next.notebookViewMode &&
    prev.fileViewMode === next.fileViewMode &&
    prev.onSpreadsheetToolbarStateChange === next.onSpreadsheetToolbarStateChange
  );
}

export const FilePreviewContent = memo(
  FilePreviewContentComponent,
  areFilePreviewContentPropsEqual
);
