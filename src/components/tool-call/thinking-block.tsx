"use client";

import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  /** True only while the agent is actively streaming this thinking block. */
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  label?: string;
  summaries?: string[];
}

function getLeadingIndentLength(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
}

function normalizeThinkingMarkdown(thinking: string): string {
  const lines = thinking.replace(/\r\n?/g, '\n').split('\n');
  const outputLines: string[] = [];
  const dedentCandidateLines: string[] = [];
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const markerChar = marker[0] as '`' | '~';
      if (!inFence) {
        inFence = true;
        fenceChar = markerChar;
        fenceLength = marker.length;
        outputLines.push(trimmedStart);
        continue;
      }
      if (markerChar === fenceChar && marker.length >= fenceLength) {
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
        outputLines.push(trimmedStart);
        continue;
      }
    }

    if (inFence) {
      outputLines.push(line);
      continue;
    }

    if (trimmedStart.length > 0) {
      dedentCandidateLines.push(line);
    }
    outputLines.push(line);
  }

  if (dedentCandidateLines.length === 0) {
    return outputLines.join('\n');
  }

  const commonIndentLength = Math.min(
    ...dedentCandidateLines.map(getLeadingIndentLength),
  );
  const hasSignificantCommonIndent =
    commonIndentLength >= 4 ||
    dedentCandidateLines.every(line => line.startsWith('\t'));

  if (!hasSignificantCommonIndent) {
    return outputLines.join('\n');
  }

  inFence = false;
  fenceChar = null;
  fenceLength = 0;

  return outputLines.map((line) => {
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const markerChar = marker[0] as '`' | '~';
      if (!inFence) {
        inFence = true;
        fenceChar = markerChar;
        fenceLength = marker.length;
        return line;
      }
      if (markerChar === fenceChar && marker.length >= fenceLength) {
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
        return line;
      }
    }

    if (inFence || trimmedStart.length === 0) {
      return line;
    }

    return line.slice(commonIndentLength);
  }).join('\n');
}

export function ThinkingBlock({
  thinking,
  isStreaming = false,
  defaultExpanded = false,
  label,
  summaries = [],
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const normalizedThinking = useMemo(() => normalizeThinkingMarkdown(thinking), [thinking]);
  const isDefaultThinkingLabel = label === undefined || label === 'Thinking';
  const baseLabel = isDefaultThinkingLabel ? 'Thought' : label;
  const displayLabel = isStreaming
    ? `${isDefaultThinkingLabel ? 'Thinking' : baseLabel}…`
    : baseLabel;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "thinking-block group/thinking flex w-full items-center gap-2 py-1 text-sm text-muted-foreground",
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
          <span
            className={cn(
              "thinking-block__dot w-1.5 h-1.5 rounded-full shrink-0",
              isStreaming
                ? "bg-blue-500 animate-pulse motion-reduce:animate-none"
                : "bg-green-500"
            )}
          />
          <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
          <ChevronRight
            className={cn(
              "thinking-block__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover/thinking:opacity-100",
              isExpanded && "opacity-100 rotate-90"
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
        <div className="pl-4 mt-1 space-y-3 text-xs text-muted-foreground/80 border-l border-border/40 ml-1">
          {summaries.length > 0 ? (
            <div className="space-y-2">
              {summaries.map((summary, index) => (
                <div
                  key={`thinking-summary-${index}`}
                  className="rounded-md bg-muted/30 px-3 py-2 text-muted-foreground/90"
                >
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                    Summary {summaries.length > 1 ? index + 1 : ''}
                  </div>
                  <div className="whitespace-pre-wrap">{summary}</div>
                </div>
              ))}
            </div>
          ) : null}
          {normalizedThinking.trim().length > 0 ? (
            <div className="thinking-block__markdown">
              <MarkdownRenderer content={normalizedThinking} isStreaming={isStreaming} />
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
