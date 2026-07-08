"use client";

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import {
  formatCopyFilePath,
  type CopyFilePathTarget,
} from '@/lib/file-path-copy';
import type { FilePreviewLinkTarget } from '@/lib/file-preview-target';
import { FileLink } from '../file-link';
import { stripAnsi } from '../tool-utils';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  hoverClassName?: string;
}

export function CopyButton({ value, label = 'Copy', className, hoverClassName }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard errors for a silent UX.
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            "h-5 w-5 text-muted-foreground/70 opacity-0 transition-opacity",
            hoverClassName ?? "group-hover/details:opacity-100",
            className
          )}
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : label}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{copied ? 'Copied!' : label}</TooltipContent>
    </Tooltip>
  );
}

interface DetailRowProps {
  label: string;
  value?: React.ReactNode;
  copyValue?: string;
  copyFileTarget?: CopyFilePathTarget;
  copyLabel?: string;
  mono?: boolean;
  className?: string;
  tooltipThreshold?: number;
  asFileLink?: boolean;
  filePath?: string;
  filePreview?: FilePreviewLinkTarget | null;
}

export function DetailRow({
  label,
  value,
  copyValue,
  copyFileTarget,
  copyLabel,
  mono = false,
  className,
  tooltipThreshold = 48,
  asFileLink = false,
  filePath,
  filePreview,
}: DetailRowProps) {
  const previewContext = useChatPreviewContext();
  const formattedCopyValue = copyFileTarget
    ? previewContext?.formatFilePathForCopy?.(copyFileTarget) ??
      formatCopyFilePath(copyFileTarget, { fallbackProjectMention: true })
    : copyValue;

  if (value === undefined || value === null || value === '') return null;

  const renderValue = (() => {
    if (typeof value !== 'string') return value;

    if (asFileLink) {
      const linkNode = filePreview === null ? (
        <span className={cn("truncate block", mono && "font-mono")}>{value}</span>
      ) : (
        <FileLink
          path={filePath ?? value}
          previewTarget={filePreview}
          mono={mono}
          className="truncate block"
        >
          {value}
        </FileLink>
      );
      if (value.length > tooltipThreshold) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              {linkNode}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs break-words">
              {value}
            </TooltipContent>
          </Tooltip>
        );
      }
      return linkNode;
    }

    if (value.length > tooltipThreshold) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("truncate block", mono && "font-mono")}>{value}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs break-words">
            {value}
          </TooltipContent>
        </Tooltip>
      );
    }

    return <span className={cn("truncate block", mono && "font-mono")}>{value}</span>;
  })();

  return (
    <div className={cn("flex items-start gap-2 group/row py-0.5", className)}>
      <span className="shrink-0 text-muted-foreground/60">{label}</span>
      <div className="min-w-0 flex-1">{renderValue}</div>
      {formattedCopyValue ? (
        <CopyButton
          value={formattedCopyValue}
          label={copyLabel}
          hoverClassName="group-hover/details:opacity-100"
        />
      ) : null}
    </div>
  );
}

export function getToolInputProject(input?: Record<string, unknown>): string {
  if (!input) return '';
  return typeof input.project === 'string' ? input.project.trim() : '';
}

export function ProjectDetailRow({ input }: { input?: Record<string, unknown> }) {
  const project = getToolInputProject(input);
  if (!project) return null;
  return (
    <DetailRow
      label="Project:"
      value={project}
      copyValue={project}
      copyLabel="Copy project name"
      mono
    />
  );
}

interface OutputBlockProps {
  value?: string;
  label?: string;
  copyValue?: string;
  className?: string;
}

export function OutputBlock({ value, label, copyValue, className }: OutputBlockProps) {
  if (!value) return null;

  const displayValue = stripAnsi(value);
  const cleanCopyValue = copyValue ? stripAnsi(copyValue) : undefined;

  return (
    <div className={cn("mt-2", className)}>
      {(label || cleanCopyValue) && (
        <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground/60 mb-1 group/output">
          <span>{label}</span>
          {cleanCopyValue ? (
            <CopyButton
              value={cleanCopyValue}
              label="Copy output"
              hoverClassName="group-hover/details:opacity-100"
            />
          ) : null}
        </div>
      )}
      <div className="mt-2 font-mono text-xs bg-muted/30 rounded p-2 max-h-32 overflow-auto">
        <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground/80">{displayValue}</pre>
      </div>
    </div>
  );
}
