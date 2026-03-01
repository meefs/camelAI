'use client';

import { memo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ContextIndicatorProps {
  usedPercent: number;
  onCompact: () => void;
  className?: string;
}

function describeWedgePath(pct: number, cx = 10, cy = 10, r = 8): string {
  if (pct <= 0) return '';
  if (pct >= 100) {
    // Full circle needs two arcs; one arc cannot represent 360 degrees.
    return [
      `M ${cx} ${cy}`,
      `m -${r},0`,
      `a ${r},${r} 0 1,0 ${2 * r},0`,
      `a ${r},${r} 0 1,0 -${2 * r},0`,
    ].join(' ');
  }

  const angle = (pct / 100) * 360 - 90; // Start at 12 o'clock.
  const radians = (angle * Math.PI) / 180;
  const x = cx + r * Math.cos(radians);
  const y = cy + r * Math.sin(radians);
  const largeArc = pct > 50 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`;
}

export const ContextIndicator = memo(function ContextIndicator({
  usedPercent,
  onCompact,
  className,
}: ContextIndicatorProps) {
  const pct = Math.max(0, Math.min(100, Math.round(usedPercent)));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCompact}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-full px-1.5 text-muted-foreground transition-colors hover:bg-muted',
            className
          )}
          aria-label={`${pct}% context used. Click to compact.`}
        >
          <svg viewBox="0 0 20 20" className="size-4 shrink-0" aria-hidden="true">
            <circle
              cx={10}
              cy={10}
              r={8}
              className="fill-muted-foreground/30"
            />
            {pct > 0 && (
              <path
                d={describeWedgePath(pct)}
                className="fill-muted-foreground/60 transition-all duration-300 ease-out"
              />
            )}
          </svg>
          <span className="text-xs text-muted-foreground">{pct}% used</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">{pct}% of context used before auto-compaction</p>
        <p className="text-[11px] text-muted-foreground">Click to compact</p>
      </TooltipContent>
    </Tooltip>
  );
});
