'use client';

import type { RefObject } from 'react';
import { ChevronDown, Download, Maximize2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  exportAsPng,
  exportAsSvg,
  exportDataAsCsv,
  hasExtractableData,
  hasSvgExportSupport,
} from './chart-export-utils';

interface OutputActionBarProps {
  kind: 'vegalite' | 'plotly';
  containerRef: RefObject<HTMLDivElement | null>;
  spec: Record<string, unknown>;
  title: string;
  onExpand?: () => void;
  className?: string;
}

export function OutputActionBar({
  kind,
  containerRef,
  spec,
  title,
  onExpand,
  className,
}: OutputActionBarProps) {
  const canExportCsv = hasExtractableData(kind, spec);
  const canExportSvg = hasSvgExportSupport(kind, spec);

  return (
    <div className={cn('output-action-bar mt-1.5 flex items-center justify-end text-xs text-muted-foreground/60', className)}>
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          className={cn(
            'mr-2 inline-flex shrink-0 items-center gap-1 text-xs transition-colors',
            'text-muted-foreground/70 hover:text-foreground'
          )}
          aria-label="Expand chart"
        >
          <Maximize2 className="size-3" />
        </button>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Download chart"
            className={cn(
              'inline-flex shrink-0 items-center gap-1 text-xs transition-colors',
              'text-muted-foreground/70 hover:text-foreground'
            )}
          >
            <Download className="size-3" />
            <ChevronDown className="size-2.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => { void exportAsSvg(kind, containerRef, title); }}
            disabled={!canExportSvg}
          >
            <Download className="mr-2 size-3.5 text-muted-foreground" />
            Download as SVG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { void exportAsPng(kind, containerRef, title); }}>
            <Download className="mr-2 size-3.5 text-muted-foreground" />
            Download as PNG
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => exportDataAsCsv(kind, spec, title)}
            disabled={!canExportCsv}
          >
            <Download className="mr-2 size-3.5 text-muted-foreground" />
            Download data (CSV)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
