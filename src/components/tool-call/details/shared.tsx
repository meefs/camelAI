"use client";

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

export function CopyButton({ value, label = 'Copy', className }: CopyButtonProps) {
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
            "h-5 w-5 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100",
            className
          )}
          onClick={handleCopy}
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
  mono?: boolean;
  className?: string;
  tooltipThreshold?: number;
}

export function DetailRow({
  label,
  value,
  copyValue,
  mono = false,
  className,
  tooltipThreshold = 48,
}: DetailRowProps) {
  if (value === undefined || value === null || value === '') return null;

  const renderValue =
    typeof value === 'string' ? (
      value.length > tooltipThreshold ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("truncate block", mono && "font-mono")}>{value}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs break-words">
            {value}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className={cn("truncate block", mono && "font-mono")}>{value}</span>
      )
    ) : (
      value
    );

  return (
    <div className={cn("flex items-start gap-2 group py-0.5", className)}>
      <span className="shrink-0 text-muted-foreground/60">{label}</span>
      <div className="min-w-0 flex-1">{renderValue}</div>
      {copyValue ? <CopyButton value={copyValue} /> : null}
    </div>
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

  return (
    <div className={cn("mt-2", className)}>
      {(label || copyValue) && (
        <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground/60 mb-1 group">
          <span>{label}</span>
          {copyValue ? <CopyButton value={copyValue} label="Copy output" /> : null}
        </div>
      )}
      <div className="mt-2 font-mono text-xs bg-muted/30 rounded p-2 max-h-32 overflow-auto">
        <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground/80">{value}</pre>
      </div>
    </div>
  );
}
