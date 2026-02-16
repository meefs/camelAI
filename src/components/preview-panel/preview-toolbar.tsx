import { memo, useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bug, Download, ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PreviewTarget } from '@/types';
import { getFileExtension } from '@/components/chat-file-preview/file-type-utils';
import { getToolbarFileType } from './preview-utils';

interface PreviewToolbarProps {
  activeTarget: PreviewTarget;
  vanityUrl?: string;
  vanityHost?: string;
  onRefresh: () => void;
  onOpenExternal: () => void;
  onBugReport?: () => void;
  appShareButton?: ReactNode;
  notebookViewMode?: 'report' | 'notebook';
  onNotebookViewModeChange?: (mode: 'report' | 'notebook') => void;
  markdownViewMode?: 'rendered' | 'source';
  onMarkdownViewModeChange?: (mode: 'rendered' | 'source') => void;
  filePreviewOpenUrl?: string;
}

function ToolbarButton({
  icon: Icon,
  tooltip,
  onClick,
  className,
  ...props
}: {
  icon: LucideIcon;
  tooltip: string;
  onClick: () => void;
  className?: string;
} & Omit<ComponentProps<typeof Button>, 'onClick'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          className={className}
          {...props}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ClickToCopyUrlBar({
  url,
  displayHost,
}: {
  url: string;
  displayHost: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 1500);
    } catch {
      // Clipboard access can fail in unsupported browser contexts.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'group/url flex max-w-[300px] items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono transition-colors',
        copied ? 'bg-green-500/10' : 'bg-muted/50 hover:bg-muted'
      )}
      title={url}
    >
      <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground">
        {copied ? 'Copied!' : displayHost}
      </span>
      {!copied ? (
        <span className="shrink-0 text-[10px] text-muted-foreground/60 opacity-0 transition-opacity group-hover/url:opacity-100">
          Copy
        </span>
      ) : null}
    </button>
  );
}

function triggerDownload(url: string, filename?: string) {
  const link = document.createElement('a');
  link.href = url;
  if (filename) {
    link.download = filename;
  }
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  requestAnimationFrame(() => {
    link.remove();
  });
}

function getDownloadFormats(target: PreviewTarget): { label: string; filename: string }[] {
  if (target.kind === 'app') return [];

  const ext = getFileExtension(target.path);
  const fallbackName = target.path.split('/').filter(Boolean).pop() || 'file';
  const name = target.filename || fallbackName;

  switch (ext) {
    case 'ipynb':
      return [{ label: 'Download notebook (.ipynb)', filename: name }];
    case 'md':
      return [{ label: 'Download markdown (.md)', filename: name }];
    case 'csv':
      return [{ label: 'Download CSV', filename: name }];
    case 'tsv':
      return [{ label: 'Download TSV', filename: name }];
    case 'xlsx':
    case 'xls':
      return [{ label: 'Download spreadsheet', filename: name }];
    case 'json':
    case 'jsonl':
      return [{ label: 'Download JSON', filename: name }];
    case 'pdf':
      return [{ label: 'Download PDF', filename: name }];
    case 'svg':
      return [{ label: 'Download SVG', filename: name }];
    default:
      return [{ label: 'Download', filename: name }];
  }
}

function DownloadButton({
  activeTarget,
  filePreviewOpenUrl,
}: {
  activeTarget: PreviewTarget;
  filePreviewOpenUrl?: string;
}) {
  if (activeTarget.kind !== 'file' || !filePreviewOpenUrl) return null;

  const formats = getDownloadFormats(activeTarget);
  if (!formats.length) return null;

  if (formats.length === 1) {
    return (
      <ToolbarButton
        icon={Download}
        tooltip="Download"
        onClick={() => triggerDownload(filePreviewOpenUrl, formats[0].filename)}
      />
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm">
              <Download className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {formats.map((format) => (
          <DropdownMenuItem
            key={format.label}
            onClick={() => triggerDownload(filePreviewOpenUrl, format.filename)}
          >
            {format.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppToolbarActions({
  vanityUrl,
  vanityHost,
  onBugReport,
  appShareButton,
}: Pick<PreviewToolbarProps, 'vanityUrl' | 'vanityHost' | 'onBugReport' | 'appShareButton'>) {
  return (
    <>
      <ClickToCopyUrlBar url={vanityUrl ?? ''} displayHost={vanityHost ?? ''} />
      {appShareButton}
      {onBugReport ? (
        <>
          <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />
          <ToolbarButton icon={Bug} tooltip="Report a bug" onClick={onBugReport} />
        </>
      ) : null}
    </>
  );
}

function NotebookToolbarActions({
  notebookViewMode,
  onNotebookViewModeChange,
  activeTarget,
  filePreviewOpenUrl,
}: Pick<
  PreviewToolbarProps,
  'notebookViewMode' | 'onNotebookViewModeChange' | 'activeTarget' | 'filePreviewOpenUrl'
>) {
  return (
    <>
      <Tabs
        value={notebookViewMode ?? 'report'}
        onValueChange={(value) => {
          if (value === 'report' || value === 'notebook') {
            onNotebookViewModeChange?.(value);
          }
        }}
        className="shrink-0 gap-0"
      >
        <TabsList variant="outline" className="h-7">
          <TabsTrigger value="report" className="h-6 px-3 text-xs">
            Report
          </TabsTrigger>
          <TabsTrigger value="notebook" className="h-6 px-3 text-xs">
            Notebook
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />
      <DownloadButton activeTarget={activeTarget} filePreviewOpenUrl={filePreviewOpenUrl} />
    </>
  );
}

function MarkdownToolbarActions({
  markdownViewMode,
  onMarkdownViewModeChange,
  activeTarget,
  filePreviewOpenUrl,
}: Pick<
  PreviewToolbarProps,
  'markdownViewMode' | 'onMarkdownViewModeChange' | 'activeTarget' | 'filePreviewOpenUrl'
>) {
  return (
    <>
      <Tabs
        value={markdownViewMode ?? 'rendered'}
        onValueChange={(value) => {
          if (value === 'rendered' || value === 'source') {
            onMarkdownViewModeChange?.(value);
          }
        }}
        className="shrink-0 gap-0"
      >
        <TabsList variant="outline" className="h-7">
          <TabsTrigger value="rendered" className="h-6 px-3 text-xs">
            Rendered
          </TabsTrigger>
          <TabsTrigger value="source" className="h-6 px-3 text-xs">
            Source
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />
      <DownloadButton activeTarget={activeTarget} filePreviewOpenUrl={filePreviewOpenUrl} />
    </>
  );
}

function PreviewToolbarComponent({
  activeTarget,
  vanityUrl,
  vanityHost,
  onRefresh,
  onOpenExternal,
  onBugReport,
  appShareButton,
  notebookViewMode,
  onNotebookViewModeChange,
  markdownViewMode,
  onMarkdownViewModeChange,
  filePreviewOpenUrl,
}: PreviewToolbarProps) {
  const fileType = getToolbarFileType(activeTarget);

  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
      <ToolbarButton icon={RefreshCw} tooltip="Refresh" onClick={onRefresh} />

      <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />

      {fileType === 'app' ? (
        <AppToolbarActions
          vanityUrl={vanityUrl}
          vanityHost={vanityHost}
          onBugReport={onBugReport}
          appShareButton={appShareButton}
        />
      ) : fileType === 'notebook' ? (
        <NotebookToolbarActions
          notebookViewMode={notebookViewMode}
          onNotebookViewModeChange={onNotebookViewModeChange}
          activeTarget={activeTarget}
          filePreviewOpenUrl={filePreviewOpenUrl}
        />
      ) : fileType === 'markdown' ? (
        <MarkdownToolbarActions
          markdownViewMode={markdownViewMode}
          onMarkdownViewModeChange={onMarkdownViewModeChange}
          activeTarget={activeTarget}
          filePreviewOpenUrl={filePreviewOpenUrl}
        />
      ) : (
        <DownloadButton activeTarget={activeTarget} filePreviewOpenUrl={filePreviewOpenUrl} />
      )}

      <div className="flex-1" />

      <ToolbarButton icon={ExternalLink} tooltip="Open in new tab" onClick={onOpenExternal} />
    </div>
  );
}

export const PreviewToolbar = memo(PreviewToolbarComponent);
