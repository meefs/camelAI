"use client";

import { useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ToolCallDetails } from './tool-details';
import { FileLink } from './file-link';
import { getToolStatus, ratchetToolStatusForIdentity, type ToolStatus } from './tool-status';
import { getToolSummaryParts } from './tool-summary';
import { isSubAgentTool } from './tool-utils';

export interface ToolCallProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  results?: ToolResultBlock[];
  /** Stable identity for the current rendered tool row; changing this resets local status ratchet state. */
  callIdentity?: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  skillSheet?: string;
  progressCount?: number;
  /** True when the message contains text or tool_result blocks after this tool call,
   *  indicating the agent moved past this tool's execution. */
  agentContinued?: boolean;
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

function ToolCallSummary({
  tool,
  result,
  isStreaming,
  status,
}: {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  isStreaming?: boolean;
  status: ToolStatus;
}) {
  const parts = useMemo(
    () => getToolSummaryParts(tool, result, isStreaming, status),
    [tool, result, isStreaming, status]
  );

  if (!parts.path || !parts.filename) {
    if (parts.filename && !parts.path) {
      return (
        <span className="tool-call__text min-w-0 flex-1 truncate">
          {parts.action}{' '}
          <span className="truncate">{parts.filename}</span>
        </span>
      );
    }

    return (
      <span className="tool-call__text min-w-0 flex-1 truncate">
        {parts.action}
      </span>
    );
  }

  return (
    <span className="tool-call__text min-w-0 flex-1 truncate">
      {parts.action}{' '}
      <FileLink path={parts.path} className="inline-flex max-w-full min-w-0">
        <span className="truncate">{parts.filename}</span>
      </FileLink>
    </span>
  );
}

export function ToolCall({
  tool,
  result,
  results,
  callIdentity,
  isStreaming,
  defaultExpanded = false,
  skillSheet,
  progressCount,
  agentContinued,
}: ToolCallProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const statusRef = useRef<ToolStatus>('running');
  const callIdentityRef = useRef<string>('');
  const resolvedResults = results ?? (result ? [result] : []);
  const rawStatus = getToolStatus(tool, result, resolvedResults, agentContinued);
  const resolvedCallIdentity = callIdentity ?? tool?.id ?? result?.tool_use_id ?? 'tool-call';
  const status = ratchetToolStatusForIdentity(
    statusRef.current,
    callIdentityRef.current,
    rawStatus,
    resolvedCallIdentity
  );
  callIdentityRef.current = resolvedCallIdentity;
  statusRef.current = status;
  const resolvedProgressCount = typeof progressCount === 'number'
    ? progressCount
    : resolvedResults.length;
  const showResultCount = isSubAgentTool(tool?.name) && resolvedProgressCount > 0;
  const resultCountLabel = showResultCount
    ? `${resolvedProgressCount} result${resolvedProgressCount === 1 ? '' : 's'}`
    : null;

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
          <span className={cn("tool-call__dot w-1.5 h-1.5 rounded-full shrink-0", getStatusClass(status))} />
          <ToolCallSummary tool={tool} result={result} isStreaming={isStreaming} status={status} />
          <div className="ml-auto flex items-center gap-2">
            {resultCountLabel ? (
              <span className="text-xs text-muted-foreground/70">{resultCountLabel}</span>
            ) : null}
            <ChevronRight
              className={cn(
                "tool-call__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
                "group-hover/toolcall:opacity-100",
                isExpanded && "opacity-100 rotate-90"
              )}
            />
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "group/details overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
        <ToolCallDetails
          tool={tool}
          result={result}
          results={results}
          skillSheet={skillSheet}
          progressCount={resolvedProgressCount}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
