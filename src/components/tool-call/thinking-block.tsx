"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({ thinking, defaultExpanded = false }: ThinkingBlockProps) {
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
          <span className="flex-1 truncate">Thinking...</span>
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
        <div className="pl-4 mt-1 text-xs text-muted-foreground/60 border-l border-border/40 ml-1 whitespace-pre-wrap">
          {thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
