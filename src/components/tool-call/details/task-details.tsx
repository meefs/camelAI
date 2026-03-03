"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface TaskDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  results?: ToolResultBlock[];
  progressCount?: number;
}

function getResultSummary(text: string): string {
  if (!text) return '';
  const firstLine = text.split(/\r?\n/).find(line => line.trim()) ?? '';
  const trimmed = firstLine.trim();
  if (!trimmed) return '';
  const max = 72;
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function ResultItem({ index, text }: { index: number; text: string }) {
  const [open, setOpen] = useState(false);
  const summary = getResultSummary(text);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group/result flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/30"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90"
            )}
          />
          <span className="shrink-0">{`Result ${index}`}</span>
          {summary ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{summary}</span>
          ) : null}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-6 pt-1">
        <div className="rounded bg-muted/30 p-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground/80">{text}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TaskDetails({ tool, result, results, progressCount }: TaskDetailsProps) {
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const input = tool?.input ?? {};
  const description = typeof input.description === 'string' ? input.description : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const agent = typeof input.agent === 'string' ? input.agent : '';
  const model = typeof input.model === 'string' ? input.model : '';
  const resolvedResults = results ?? (result ? [result] : []);
  const totalResults = typeof progressCount === 'number' ? progressCount : resolvedResults.length;
  const finalResult = resolvedResults.find((block) => !block.isTaskUpdate);
  const finalResultText = finalResult ? getResultText(finalResult) : '';
  const hasHeaderDetails = Boolean(agent || model || description || prompt);
  const isAgent = tool?.name === 'Task' || tool?.name === 'Agent';
  const showProgress = isAgent && totalResults > 0;
  const showResultsList = isAgent && resolvedResults.length > 0;

  return (
    <div className="space-y-2">
      {agent ? <DetailRow label="Agent:" value={agent} /> : null}
      {model ? <DetailRow label="Model:" value={model} /> : null}
      {description ? <DetailRow label="Description:" value={description} /> : null}
      {prompt ? <DetailRow label="Prompt:" value={prompt} copyValue={prompt} /> : null}
      {(hasHeaderDetails && (showProgress || finalResultText)) ? <Separator className="my-2" /> : null}
      {showResultsList ? (
        <Collapsible open={resultsExpanded} onOpenChange={setResultsExpanded}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group/results flex w-full items-center gap-2 rounded px-1 py-0.5 text-xs text-muted-foreground/70 hover:bg-muted/30"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground/60 transition-transform",
                  resultsExpanded && "rotate-90"
                )}
              />
              <span className="text-muted-foreground/60">Results:</span>
              <span className="text-muted-foreground/80">{`${totalResults} total`}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pl-5 pt-1">
            <div className="space-y-1">
              {resolvedResults.map((entry, index) => {
                const text = getResultText(entry);
                return (
                  <ResultItem
                    key={`${entry.tool_use_id}-${index}`}
                    index={index + 1}
                    text={text}
                  />
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {finalResultText ? (
        <OutputBlock
          value={finalResultText}
          label={totalResults > 1 ? 'Final result' : 'Result'}
          copyValue={finalResultText}
        />
      ) : null}
    </div>
  );
}
