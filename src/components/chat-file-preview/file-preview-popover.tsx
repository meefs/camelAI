'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Copy, Download, FileText, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FilePreviewContent } from './file-preview-content';
import type { SpreadsheetToolbarState } from './spreadsheet';

export interface FilePreviewPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  previewUrl: string;
  contentType?: string;
  textPreviewUrl?: string;
  fullTextPreviewUrl?: string;
}

export function FilePreviewPopover({
  open,
  onOpenChange,
  filename,
  previewUrl,
  contentType,
  textPreviewUrl,
  fullTextPreviewUrl,
}: FilePreviewPopoverProps) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [filenameCopied, setFilenameCopied] = useState(false);
  const [spreadsheetToolbarState, setSpreadsheetToolbarState] =
    useState<SpreadsheetToolbarState | null>(null);
  const filenameCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (filenameCopyTimeoutRef.current) {
      clearTimeout(filenameCopyTimeoutRef.current);
      filenameCopyTimeoutRef.current = null;
    }
    setFilenameCopied(false);
    setSpreadsheetToolbarState(null);
  }, [contentType, filename, fullTextPreviewUrl, previewUrl, textPreviewUrl]);

  useEffect(() => {
    return () => {
      if (filenameCopyTimeoutRef.current) {
        clearTimeout(filenameCopyTimeoutRef.current);
        filenameCopyTimeoutRef.current = null;
      }
    };
  }, []);

  const handleToolbarStateChange = useCallback((state: SpreadsheetToolbarState | null) => {
    setSpreadsheetToolbarState(state);
  }, []);

  const handleFilenameCopy = async () => {
    try {
      await navigator.clipboard.writeText(filename);
      setFilenameCopied(true);
      if (filenameCopyTimeoutRef.current) {
        clearTimeout(filenameCopyTimeoutRef.current);
      }
      filenameCopyTimeoutRef.current = setTimeout(() => {
        setFilenameCopied(false);
        filenameCopyTimeoutRef.current = null;
      }, 1500);
    } catch {
      setFilenameCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[calc(100%-2rem)] p-0 sm:max-w-3xl"
      >
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <DialogTitle className="sr-only">{filename}</DialogTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh preview"
                onClick={() => {
                  setSpreadsheetToolbarState(null);
                  setRefreshVersion((current) => current + 1);
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void handleFilenameCopy()}
                className={cn(
                  'group/filename flex min-w-0 max-w-[300px] items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs transition-colors',
                  filenameCopied ? 'bg-green-500/10' : 'bg-muted/50 hover:bg-muted',
                )}
              >
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate text-muted-foreground">
                  {filenameCopied ? 'Copied!' : filename}
                </span>
                {!filenameCopied ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground/60 opacity-0 transition-opacity group-hover/filename:opacity-100">
                    Copy
                  </span>
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent>File name</TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />
          {spreadsheetToolbarState && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy selection"
                  disabled={!spreadsheetToolbarState.canCopySelection}
                  onClick={() => void spreadsheetToolbarState.copySelection()}
                >
                  {spreadsheetToolbarState.copiedSelection ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy selection</TooltipContent>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center gap-1">
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
          <FilePreviewContent
            key={`${previewUrl}:${refreshVersion}`}
            filename={filename}
            previewUrl={previewUrl}
            fileTextPreviewUrl={textPreviewUrl}
            fileFullTextPreviewUrl={fullTextPreviewUrl}
            contentType={contentType}
            layout="dialog"
            onSpreadsheetToolbarStateChange={handleToolbarStateChange}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
