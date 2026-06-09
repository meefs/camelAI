"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  formatTurnDuration,
  formatTurnDurationForScreenReader,
} from "@/lib/turn-utils";

interface TurnSummaryBarProps {
  durationMs: number;
  stepCount: number;
  children: ReactNode;
  defaultExpanded?: boolean;
  animateOnMount?: boolean;
  onAutoCollapseScheduled?: () => void;
  /** Show the "worked for <time> ·" prefix. */
  showDuration?: boolean;
  /** Render the trailing separator that precedes a final answer. */
  showSeparator?: boolean;
}

export function TurnSummaryBar({
  durationMs,
  stepCount,
  children,
  defaultExpanded = false,
  animateOnMount = false,
  onAutoCollapseScheduled,
  showDuration = true,
  showSeparator = true,
}: TurnSummaryBarProps) {
  const animateOnMountRef = useRef(animateOnMount);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || animateOnMount);
  const timeLabel = formatTurnDuration(durationMs);
  const stepLabel = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  const toggleLabel = isExpanded ? "hide work" : "show work";
  const a11yLabel = showDuration
    ? `${isExpanded ? "Hide" : "Show"} work, ${stepLabel}, ${formatTurnDurationForScreenReader(durationMs)}`
    : `${isExpanded ? "Hide" : "Show"} work, ${stepLabel}`;

  useEffect(() => {
    if (!animateOnMountRef.current) return;
    const id = requestAnimationFrame(() => {
      setIsExpanded(false);
      onAutoCollapseScheduled?.();
    });
    return () => cancelAnimationFrame(id);
    // Latched at mount: a later animateOnMount=false must not cancel an
    // in-flight collapse when multiple summary bars animate together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={a11yLabel}
          className={cn(
            "turn-summary group/turn-summary flex w-full cursor-pointer items-center gap-1.5 rounded py-1 text-left",
            "font-mono text-xs text-muted-foreground/60 transition-colors duration-150",
            "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
            "motion-reduce:transition-none",
          )}
        >
          {showDuration ? (
            <>
              <span>worked for</span>
              <span className="text-muted-foreground/80">{timeLabel}</span>
              <span className="text-muted-foreground/30">·</span>
            </>
          ) : null}
          <span className="text-muted-foreground/80">{stepLabel}</span>
          <span className="text-muted-foreground/30">·</span>
          <span>{toggleLabel}</span>
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/40 transition-transform duration-[250ms] ease-out",
              "motion-reduce:transition-none",
              isExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "overflow-hidden data-[state=open]:animate-turn-trace-down data-[state=closed]:animate-turn-trace-up",
          "motion-reduce:animate-none",
        )}
      >
        <div className="space-y-1 py-2">
          {children}
        </div>
      </CollapsibleContent>

      {showSeparator ? (
        <hr className="my-2 border-t border-border/40" />
      ) : null}
    </Collapsible>
  );
}
