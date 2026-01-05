"use client";

import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ToolCallDetails } from './tool-details';
import { getToolStatus, type ToolStatus } from './tool-status';
import { getToolSummary } from './tool-summary';

export interface ToolCallProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}

function getStatusClass(status: ToolStatus) {
  switch (status) {
    case 'running':
      return "bg-blue-500 animate-pulse motion-reduce:animate-none";
    case 'complete':
      return "bg-green-500";
    case 'error':
      return "bg-red-500";
    default:
      return "bg-muted-foreground";
  }
}

export function ToolCall({ tool, result, isStreaming, defaultExpanded = false }: ToolCallProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const summary = useMemo(() => getToolSummary(tool, result), [tool, result]);
  const status = getToolStatus(tool, result, isStreaming);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "tool-call group flex w-full items-center gap-2 py-1 text-sm text-muted-foreground",
            "hover:bg-muted/30 rounded px-2 -mx-2 cursor-pointer text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          )}
        >
          <span className={cn("tool-call__dot w-1.5 h-1.5 rounded-full shrink-0", getStatusClass(status))} />
          <span className="tool-call__text min-w-0 flex-1 truncate">{summary}</span>
          <ChevronRight
            className={cn(
              "tool-call__chevron ml-auto h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover:opacity-100",
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
        <ToolCallDetails tool={tool} result={result} />
      </CollapsibleContent>
    </Collapsible>
  );
}
