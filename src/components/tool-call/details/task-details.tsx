"use client";

import { Check, Circle, LoaderCircle, X } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';
import { CopyButton } from './shared';
import { getResultText } from '../tool-utils';

interface TaskDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  results?: ToolResultBlock[];
  status?: 'running' | 'complete' | 'error';
}

function friendlyLegacyActivity(line: string): string {
  const trimmed = line.trim();
  const started = trimmed.match(/^(Agent|Explore|Research|Oracle) started\.?$/i);
  if (started) {
    switch (started[1]?.toLowerCase()) {
      case 'explore': return 'Mapping the workspace';
      case 'research': return 'Planning the research';
      case 'oracle': return 'Reviewing the problem';
      default: return 'Reviewing the task';
    }
  }

  const running = trimmed.match(/^Running\s+(.+?)\.{2,}$/i);
  if (!running) return trimmed.replace(/[.]+$/, '');
  const toolName = running[1]?.toLowerCase() ?? '';
  if (['read', 'ls', 'find', 'grep', 'glob'].includes(toolName)) return 'Inspecting the workspace';
  if (['write', 'edit'].includes(toolName)) return 'Making changes';
  if (['bash', 'javascript', 'js_exec', 'build_project', 'run_notebook'].includes(toolName)) {
    return 'Running and verifying the work';
  }
  if (['websearch', 'web_search'].includes(toolName)) return 'Searching the web';
  if (['webfetch', 'web_fetch'].includes(toolName)) return 'Reading and comparing sources';
  return `Using ${running[1]}`;
}

export function getTaskActivities(results: ToolResultBlock[]): string[] {
  const activities: string[] = [];
  const append = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = friendlyLegacyActivity(value);
    if (!normalized || activities[activities.length - 1] === normalized) return;
    activities.push(normalized);
  };

  for (const result of results) {
    if (Array.isArray(result.details?.activities)) {
      for (const activity of result.details.activities) append(activity);
    }
    if (!result.isTaskUpdate) continue;
    const text = getResultText(result)
      // Old streamed updates did not include newlines. Split their recognizable
      // boundaries so historical in-flight cards remain readable.
      .replace(/((?:Agent|Explore|Research|Oracle) started\.)/gi, '$1\n')
      .replace(/(Running\s+[^\n.]+\.{2,})/gi, '$1\n');
    for (const line of text.split(/\r?\n/)) append(line);
  }

  return activities;
}

function formatDuration(durationMs: unknown): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function resultLabel(name?: string): string {
  switch (name) {
    case 'Oracle': return 'Oracle response';
    case 'Research': return 'Research report';
    case 'Explore':
    case 'explore': return 'Exploration result';
    default: return 'Agent result';
  }
}

export function TaskDetails({ tool, result, results, status = 'running' }: TaskDetailsProps) {
  const input = tool?.input ?? {};
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const request = question || prompt || description;
  const resolvedResults = results ?? (result ? [result] : []);
  const finalResult = resolvedResults.find((block) => !block.isTaskUpdate);
  const finalResultText = finalResult ? getResultText(finalResult) : '';
  const activities = getTaskActivities(resolvedResults);
  const visibleActivities = activities.slice(-6);
  const hiddenActivityCount = Math.max(0, activities.length - visibleActivities.length);
  const duration = formatDuration(finalResult?.details?.durationMs);
  const toolUseCount = typeof finalResult?.details?.toolUseCount === 'number'
    ? finalResult.details.toolUseCount
    : null;
  const statusLabel = status === 'running'
    ? 'In progress'
    : status === 'error'
      ? 'Needs attention'
      : 'Complete';

  return (
    <div className="space-y-3">
      {(description && description !== request) || agent || model ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {description && description !== request ? (
            <span className="font-medium text-foreground/80">{description}</span>
          ) : null}
          {agent ? <span>Agent: {agent}</span> : null}
          {model ? <span>Model: {model}</span> : null}
        </div>
      ) : null}

      {request ? (
        <div className="rounded-md bg-muted/35 px-3 py-2.5">
          <div className="mb-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground/70">
            Request
          </div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">{request}</p>
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[0.7rem] font-medium text-muted-foreground">Activity</span>
          <Badge
            variant={status === 'error' ? 'destructive' : status === 'running' ? 'secondary' : 'outline'}
            className={cn(status === 'running' && 'text-blue-600 dark:text-blue-400')}
          >
            {statusLabel}
          </Badge>
        </div>
        <div className="space-y-1.5" aria-live="polite">
          {hiddenActivityCount > 0 ? (
            <div className="pl-6 text-[0.7rem] text-muted-foreground/60">
              {hiddenActivityCount} earlier {hiddenActivityCount === 1 ? 'step' : 'steps'}
            </div>
          ) : null}
          {(visibleActivities.length > 0
            ? visibleActivities
            : [status === 'running' ? 'Starting' : status === 'error' ? 'Task stopped' : 'Work completed']
          ).map((activity, index, list) => {
            const isCurrent = index === list.length - 1;
            const isActive = status === 'running' && isCurrent;
            const isFailed = status === 'error' && isCurrent;
            const Icon = isActive ? LoaderCircle : isFailed ? X : status === 'complete' || !isCurrent ? Check : Circle;
            return (
              <div
                key={`${activity}-${index}`}
                className={cn(
                  "flex items-start gap-2 text-xs",
                  isCurrent ? "text-foreground/85" : "text-muted-foreground/70",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    isActive && "animate-spin text-blue-500 motion-reduce:animate-none",
                    isFailed && "text-destructive",
                    !isActive && !isFailed && "text-muted-foreground/60",
                  )}
                />
                <span className="leading-relaxed">{activity}</span>
              </div>
            );
          })}
        </div>
      </div>

      {finalResultText ? (
        <>
          <Separator />
          <div className="group/agent-result">
            <div className="mb-1.5 flex items-center justify-between text-[0.7rem] font-medium text-muted-foreground">
              <span>{resultLabel(tool?.name)}</span>
              <CopyButton
                value={finalResultText}
                label="Copy response"
                hoverClassName="group-hover/agent-result:opacity-100"
              />
            </div>
            <div className="max-h-72 overflow-auto rounded-md border border-border/60 bg-background px-3 py-2.5 text-sm text-foreground/90">
              <MarkdownRenderer content={finalResultText} />
            </div>
          </div>
        </>
      ) : null}

      {(duration || toolUseCount !== null) ? (
        <div className="text-[0.65rem] text-muted-foreground/60">
          {duration ? `${status === 'error' ? 'Stopped after' : 'Completed in'} ${duration}` : null}
          {duration && toolUseCount !== null ? ' · ' : null}
          {toolUseCount !== null ? `${toolUseCount} ${toolUseCount === 1 ? 'action' : 'actions'}` : null}
        </div>
      ) : null}
    </div>
  );
}
