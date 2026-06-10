import { memo, useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PreviewTarget } from '@/types';
import { getFileExtension } from '@/components/chat-file-preview/file-type-utils';
import type { NotebookPreviewLoadState } from '@/components/chat-file-preview';
import {
  getTabIcon,
  getToolbarFileType,
  supportsPreviewSourceToggle,
} from './preview-utils';
import { PreviewSourceToggle, type PreviewSourceMode } from './preview-source-toggle';

export type OpenElsewhereKind = 'app';

interface PreviewToolbarProps {
  activeTarget: PreviewTarget;
  vanityUrl?: string;
  vanityHost?: string;
  onRefresh: () => void;
  openElsewhereKind: OpenElsewhereKind | null;
  onOpenElsewhere: () => void;
  appShareButton?: ReactNode;
  notebookViewMode?: 'report' | 'notebook';
  onNotebookViewModeChange?: (mode: 'report' | 'notebook') => void;
  fileViewMode?: PreviewSourceMode;
  onFileViewModeChange?: (mode: PreviewSourceMode) => void;
  filePreviewOpenUrl?: string;
  notebookState?: NotebookPreviewLoadState;
  isNotebookPdfExporting?: boolean;
  onNotebookReportPdfDownload?: () => void | Promise<void>;
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
          aria-label={tooltip}
          {...props}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function OpenElsewhereButton({
  kind,
  onClick,
}: {
  kind: OpenElsewhereKind | null;
  onClick: () => void;
}) {
  if (kind === null) return null;

  return <ToolbarButton icon={ExternalLink} tooltip="Open live app" onClick={onClick} />;
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          className="group/url flex max-w-[300px] min-w-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-xs font-mono transition-colors hover:bg-muted"
        >
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{displayHost}</span>
          <span
            className={cn(
              'flex h-3 w-8 shrink-0 items-center justify-center',
              !copied && 'opacity-0 transition-opacity group-hover/url:opacity-100'
            )}
            aria-live="polite"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-green-500" aria-hidden="true" />
                <span className="sr-only">Copied to clipboard</span>
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground/60" aria-hidden="true">
                Copy
              </span>
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Live app link</TooltipContent>
    </Tooltip>
  );
}

function getFileDisplayName(target: Extract<PreviewTarget, { kind: 'file' }>) {
  return target.filename || target.path.split('/').filter(Boolean).pop() || 'file';
}

function ClickToCopyFileChip({
  target,
}: {
  target: Extract<PreviewTarget, { kind: 'file' }>;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayName = getFileDisplayName(target);
  const FileIcon = getTabIcon(target);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(target.path);
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          className="group/file flex max-w-[300px] min-w-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-xs font-mono transition-colors hover:bg-muted"
          title={target.path}
        >
          <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{displayName}</span>
          <span
            className={cn(
              'flex h-3 w-8 shrink-0 items-center justify-center',
              !copied && 'opacity-0 transition-opacity group-hover/file:opacity-100'
            )}
            aria-live="polite"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-green-500" aria-hidden="true" />
                <span className="sr-only">Copied to clipboard</span>
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground/60" aria-hidden="true">
                Copy
              </span>
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Copy file path</TooltipContent>
    </Tooltip>
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

type DownloadOption =
  | { id: string; kind: 'direct'; label: string; filename: string; url: string }
  | {
      id: string;
      kind: 'action';
      label: string;
      disabled?: boolean;
      pending?: boolean;
      onSelect: () => void | Promise<void>;
    };

function getDownloadOptions({
  target,
  filePreviewOpenUrl,
  notebookState,
  isNotebookPdfExporting,
  onNotebookReportPdfDownload,
}: {
  target: PreviewTarget;
  filePreviewOpenUrl?: string;
  notebookState?: NotebookPreviewLoadState;
  isNotebookPdfExporting?: boolean;
  onNotebookReportPdfDownload?: () => void | Promise<void>;
}): DownloadOption[] {
  if (target.kind !== 'file' || !filePreviewOpenUrl) return [];

  const ext = getFileExtension(target.path);
  const fallbackName = target.path.split('/').filter(Boolean).pop() || 'file';
  const name = target.filename || fallbackName;
  const directOption = (id: string, label: string, filename = name): DownloadOption => ({
    id,
    kind: 'direct',
    label,
    filename,
    url: filePreviewOpenUrl,
  });

  switch (ext) {
    case 'ipynb':
      return [
        directOption('notebook', 'Download notebook (.ipynb)'),
        {
          id: 'report-pdf',
          kind: 'action',
          label: 'Download report as PDF',
          disabled:
            notebookState?.status !== 'ready' ||
            !notebookState.notebook ||
            !onNotebookReportPdfDownload,
          pending: isNotebookPdfExporting,
          onSelect: () => {
            void onNotebookReportPdfDownload?.();
          },
        },
      ];
    case 'md':
      return [directOption('markdown', 'Download markdown (.md)')];
    case 'csv':
      return [directOption('csv', 'Download CSV')];
    case 'tsv':
      return [directOption('tsv', 'Download TSV')];
    case 'xlsx':
    case 'xls':
      return [directOption('spreadsheet', 'Download spreadsheet')];
    case 'json':
    case 'jsonl':
      return [directOption('json', 'Download JSON')];
    case 'pdf':
      return [directOption('pdf', 'Download PDF')];
    case 'svg':
      return [directOption('svg', 'Download SVG')];
    default:
      return [directOption('file', 'Download')];
  }
}

function DownloadButton({
  activeTarget,
  filePreviewOpenUrl,
  notebookState,
  isNotebookPdfExporting,
  onNotebookReportPdfDownload,
}: {
  activeTarget: PreviewTarget;
  filePreviewOpenUrl?: string;
  notebookState?: NotebookPreviewLoadState;
  isNotebookPdfExporting?: boolean;
  onNotebookReportPdfDownload?: () => void | Promise<void>;
}) {
  if (activeTarget.kind !== 'file' || !filePreviewOpenUrl) return null;

  const options = getDownloadOptions({
    target: activeTarget,
    filePreviewOpenUrl,
    notebookState,
    isNotebookPdfExporting,
    onNotebookReportPdfDownload,
  });
  if (!options.length) return null;

  const handleOptionSelect = (option: DownloadOption) => {
    if (option.kind === 'direct') {
      triggerDownload(option.url, option.filename);
      return;
    }
    if (option.disabled) return;
    void option.onSelect();
  };

  if (options.length === 1 && options[0].kind === 'direct') {
    return (
      <ToolbarButton
        icon={Download}
        tooltip="Download"
        onClick={() => handleOptionSelect(options[0])}
      />
    );
  }

  const isNotebookMenu = getFileExtension(activeTarget.path) === 'ipynb';
  const hasPendingAction = options.some(
    (option) => option.kind === 'action' && option.pending
  );

  return (
    <DropdownMenu>
      {isNotebookMenu ? (
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 gap-1.5 rounded-md border px-2 text-xs font-medium',
              'border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            {hasPendingAction ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {hasPendingAction ? 'Exporting…' : 'Download'}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
      ) : (
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
      )}
      <DropdownMenuContent align="start" className={isNotebookMenu ? 'w-60' : undefined}>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            disabled={option.kind === 'action' ? option.disabled : undefined}
            onClick={() => handleOptionSelect(option)}
          >
            {option.kind === 'action' && option.pending ? (
              <Loader2 className="mr-2 size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <Download className="mr-2 size-3.5 text-muted-foreground" />
            )}
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PreviewToolbarComponent({
  activeTarget,
  vanityUrl,
  vanityHost,
  onRefresh,
  openElsewhereKind,
  onOpenElsewhere,
  appShareButton,
  notebookViewMode,
  onNotebookViewModeChange,
  fileViewMode,
  onFileViewModeChange,
  filePreviewOpenUrl,
  notebookState,
  isNotebookPdfExporting,
  onNotebookReportPdfDownload,
}: PreviewToolbarProps) {
  const fileType = getToolbarFileType(activeTarget);
  const isRuntimeArtifact = activeTarget.kind === 'runtime_artifact';

  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
      {!isRuntimeArtifact ? (
        <ToolbarButton icon={RefreshCw} tooltip="Refresh" onClick={onRefresh} />
      ) : null}
      {!isRuntimeArtifact && fileType === 'notebook' ? (
        <PreviewSourceToggle
          target={activeTarget}
          value={notebookViewMode === 'notebook' ? 'source' : 'preview'}
          onChange={(mode) => {
            onNotebookViewModeChange?.(mode === 'source' ? 'notebook' : 'report');
          }}
        />
      ) : !isRuntimeArtifact && supportsPreviewSourceToggle(activeTarget) ? (
        <PreviewSourceToggle
          target={activeTarget}
          value={fileViewMode ?? 'preview'}
          onChange={(mode) => {
            onFileViewModeChange?.(mode);
          }}
        />
      ) : null}

      <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />

      <div className="flex min-w-0 flex-1 items-center">
        {activeTarget.kind === 'app' ? (
          <ClickToCopyUrlBar url={vanityUrl ?? ''} displayHost={vanityHost ?? ''} />
        ) : activeTarget.kind === 'runtime_artifact' ? (
          <span className="truncate text-xs font-medium text-muted-foreground">
            {activeTarget.artifact.title}
          </span>
        ) : (
          <ClickToCopyFileChip target={activeTarget} />
        )}
      </div>

      <OpenElsewhereButton kind={openElsewhereKind} onClick={onOpenElsewhere} />
      {activeTarget.kind === 'app' ? appShareButton : null}
      {activeTarget.kind === 'file' ? (
        <DownloadButton
          activeTarget={activeTarget}
          filePreviewOpenUrl={filePreviewOpenUrl}
          notebookState={notebookState}
          isNotebookPdfExporting={isNotebookPdfExporting}
          onNotebookReportPdfDownload={onNotebookReportPdfDownload}
        />
      ) : null}
    </div>
  );
}

export const PreviewToolbar = memo(PreviewToolbarComponent);
