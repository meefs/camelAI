"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  defaultExpanded?: boolean;
  label?: string;
  summaries?: string[];
}

export function ThinkingBlock({
  thinking,
  defaultExpanded = false,
  label = 'Thinking',
  summaries = [],
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "thinking-block group/thinking flex w-full items-center gap-2 text-sm text-muted-foreground/60 italic",
            "hover:bg-muted/20 rounded px-2 -mx-2 cursor-pointer text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          )}
        >
          <span className="flex-1 truncate">{label}...</span>
          <ChevronRight
            className={cn(
              "ml-auto h-4 w-4 text-muted-foreground/40 opacity-0 transition-all duration-150",
              "group-hover/thinking:opacity-100",
              isExpanded && "opacity-100 rotate-90"
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
          <div className="pl-4 mt-1 space-y-3 text-xs text-muted-foreground/60 border-l border-border/40 ml-1">
            {summaries.length > 0 ? (
              <div className="space-y-2">
                {summaries.map((summary, index) => (
                  <div key={`${label}-summary-${index}`} className="rounded-md bg-muted/30 px-3 py-2 text-muted-foreground/80">
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60 not-italic">
                      Reasoning Summary {summaries.length > 1 ? index + 1 : ''}
                    </div>
                    <div className="whitespace-pre-wrap not-italic">{summary}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {thinking ? (
              <div className="whitespace-pre-wrap">
                {thinking}
              </div>
            ) : null}
          </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
