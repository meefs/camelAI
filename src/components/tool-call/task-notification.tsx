"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { DetailRow } from './details/shared';

interface TaskNotificationProps {
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}

function getStatusClass(status: string): string {
  if (status === 'completed' || status === 'success') {
    return "bg-green-500";
  }
  if (status === 'failed' || status === 'error') {
    return "bg-red-500";
  }
  return "bg-muted-foreground";
}

function getSummaryText(summary: string, status: string): string {
  const trimmedSummary = summary.trim();
  if (trimmedSummary) return trimmedSummary;
  return status ? `Task ${status}` : 'Task update';
}

export function TaskNotification({ taskId, outputFile, status, summary }: TaskNotificationProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const normalizedStatus = status.trim().toLowerCase();
  const summaryText = getSummaryText(summary, normalizedStatus);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "tool-call group/toolcall flex w-full items-center gap-2 py-1 text-sm text-muted-foreground",
            "hover:bg-muted/30 rounded px-2 -mx-2 cursor-pointer text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded(prev => !prev);
            }
          }}
        >
          <span className={cn("tool-call__dot w-1.5 h-1.5 rounded-full shrink-0", getStatusClass(normalizedStatus))} />
          <span className="tool-call__text min-w-0 flex-1 truncate">{summaryText}</span>
          <ChevronRight
            className={cn(
              "tool-call__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover/toolcall:opacity-100",
              isExpanded && "opacity-100 rotate-90"
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "group/details overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
        <div className="pl-4 mt-1 text-xs text-muted-foreground/80 border-l border-border/50 ml-1">
          <div className="space-y-2">
            <DetailRow label="Status:" value={normalizedStatus || 'unknown'} />
            <DetailRow label="Task ID:" value={taskId} mono copyValue={taskId} />
            <DetailRow
              label="Output file:"
              value={outputFile}
              mono
              asFileLink
              filePath={outputFile}
              copyValue={outputFile}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
