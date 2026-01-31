'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getPreviewType } from './file-type-utils';

const MAX_TEXT_LINES = 500;

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

function ImagePreview({ src, alt }: { src: string; alt: string }) {
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
            "max-h-[60vh] w-full object-contain transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
}

export interface FilePreviewPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  previewUrl: string;
  contentType?: string;
}

export function FilePreviewPopover({
  open,
  onOpenChange,
  filename,
  previewUrl,
  contentType,
}: FilePreviewPopoverProps) {
  const previewType = useMemo(
    () => getPreviewType(filename, contentType),
    [filename, contentType]
  );
  const [textPreview, setTextPreview] = useState('');
  const [textStatus, setTextStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [lineInfo, setLineInfo] = useState<{ truncated: boolean; totalLines: number }>({
    truncated: false,
    totalLines: 0,
  });

  useEffect(() => {
    if (!open || previewType !== 'text') return;

    const controller = new AbortController();
    let cancelled = false;

    setTextStatus('loading');

    fetch(previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load preview');
        return response.text();
      })
      .then((text) => {
        if (cancelled) return;
        const { text: truncatedText, truncated, totalLines } = truncateTextLines(text);
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
  }, [open, previewType, previewUrl]);

  useEffect(() => {
    if (!open) {
      setMediaLoading(false);
      setMediaError(false);
      return;
    }

    if (previewType === 'pdf' || previewType === 'audio' || previewType === 'video') {
      setMediaLoading(true);
      setMediaError(false);
    } else {
      setMediaLoading(false);
      setMediaError(false);
    }
  }, [open, previewType, previewUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[calc(100%-2rem)] p-0 sm:max-w-3xl"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <DialogTitle className="truncate text-sm font-medium">{filename}</DialogTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={previewUrl}
                download={filename}
                aria-label={`Download ${filename}`}
              >
                <Download className="h-4 w-4" />
              </a>
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close preview">
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
        </div>
        <div className="overflow-hidden p-4">
          {previewType === 'image' && (
            <ImagePreview src={previewUrl} alt={filename} />
          )}

          {previewType === 'pdf' && (
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
              <iframe
                src={previewUrl}
                title={filename}
                className={cn(
                  "h-[60vh] w-full rounded-md border",
                  mediaLoading && "opacity-0"
                )}
                onLoad={() => setMediaLoading(false)}
                onError={() => {
                  setMediaLoading(false);
                  setMediaError(true);
                }}
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
                className="max-h-[60vh] w-full rounded-md"
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
                      'w-full min-w-0 max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs',
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

          {previewType === 'other' && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-sm text-muted-foreground">
              <span>No preview available.</span>
              <Button variant="secondary" asChild>
                <a href={previewUrl} download={filename}>
                  Download File
                </a>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
