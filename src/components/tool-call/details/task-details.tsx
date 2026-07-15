"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';
import { CopyButton, DetailRow } from './shared';
import { getResultText } from '../tool-utils';

interface TaskDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  results?: ToolResultBlock[];
  status?: 'running' | 'complete' | 'error';
}

export interface TaskToolActivity {
  toolName: string;
  label: string;
  status: 'running' | 'complete' | 'error';
}

function friendlyLegacyActivity(line: string): string {
  const trimmed = line.trim();
  if (/^(Agent|Explore|Research|Oracle) started\.?$/i.test(trimmed)) return '';
  if (/^Starting (agent|exploration|research|Oracle)\.?$/i.test(trimmed)) return '';

  const running = trimmed.match(/^Running\s+(.+?)\.{2,}$/i);
  if (running?.[1]) return running[1].trim();
  return trimmed.replace(/[.]+$/, '');
}

export function getTaskActivities(results: ToolResultBlock[]): string[] {
  const activities: string[] = [];
  const append = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = friendlyLegacyActivity(value);
    if (normalized) activities.push(normalized);
  };

  for (const result of results) {
    if (Array.isArray(result.details?.activities)) {
      for (const activity of result.details.activities) append(activity);
    }
    if (!result.isTaskUpdate) continue;
    const text = getResultText(result)
      .replace(/((?:Agent|Explore|Research|Oracle) started\.)/gi, '$1\n')
      .replace(/(Running\s+[^\n.]+\.{2,})/gi, '$1\n');
    for (const line of text.split(/\r?\n/)) append(line);
  }

  return activities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeActivityStatus(value: unknown): TaskToolActivity['status'] {
  if (value === 'running' || value === 'error') return value;
  return 'complete';
}

export function getTaskToolActivities(results: ToolResultBlock[]): TaskToolActivity[] {
  for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const raw = results[resultIndex]?.details?.toolActivities;
    if (!Array.isArray(raw)) continue;
    return raw.flatMap((value) => {
      if (!isRecord(value) || typeof value.toolName !== 'string' || !value.toolName.trim()) return [];
      const toolName = value.toolName.trim();
      const label = typeof value.label === 'string' && value.label.trim()
        ? value.label.trim()
        : toolName;
      return [{
        toolName,
        label,
        status: normalizeActivityStatus(value.status),
      }];
    });
  }

  const streamedActivities = getTaskActivities(results);
  if (streamedActivities.length > 0) return streamedActivities.map((label) => {
    const [candidate = '', ...rest] = label.split(/\s+·\s+/);
    const looksLikeToolName = /^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate);
    return {
      toolName: looksLikeToolName ? candidate : '',
      label: rest.length > 0 ? rest.join(' · ') : label,
      status: 'complete' as const,
    };
  });

  for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const raw = results[resultIndex]?.details?.childToolsUsed;
    if (!Array.isArray(raw)) continue;
    return raw.flatMap((value) => typeof value === 'string' && value.trim()
      ? [{ toolName: value.trim(), label: value.trim(), status: 'complete' as const }]
      : []);
  }

  return [];
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

function unwrapTextEnvelope(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (
    (type === 'text' || type === 'inputText' || type === 'outputText') &&
    typeof value.text === 'string'
  ) {
    return value.text;
  }
  return null;
}

/**
 * Older dynamic-agent results serialized Pi text content items and appended
 * their completed status. Keep those durable transcripts readable while new
 * results arrive as plain text from pi-tool-builders.
 */
export function normalizeTaskResultText(value: string): string {
  const withoutCompletionMetadata = value
    .replace(/(?:\r?\n\s*)+(?:success:\s*true\s*(?:\r?\n\s*)+)?status:\s*(?:completed|succeeded)\s*$/i, '')
    .trim();
  if (!withoutCompletionMetadata) return '';

  try {
    const parsed = JSON.parse(withoutCompletionMetadata) as unknown;
    const singleText = unwrapTextEnvelope(parsed);
    if (singleText !== null) return singleText.trim();
    if (Array.isArray(parsed)) {
      const textParts = parsed.map(unwrapTextEnvelope);
      if (textParts.every((part): part is string => part !== null)) {
        return textParts.map((part) => part.trim()).filter(Boolean).join('\n\n');
      }
    }
  } catch {
    // Ordinary Markdown is expected to fail JSON parsing.
  }

  return withoutCompletionMetadata;
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
  const finalResultText = finalResult ? normalizeTaskResultText(getResultText(finalResult)) : '';
  const activities = getTaskToolActivities(resolvedResults);
  const visibleActivities = activities.slice(-10);
  const hiddenActivityCount = Math.max(0, activities.length - visibleActivities.length);
  const duration = formatDuration(finalResult?.details?.durationMs);
  const toolUseCount = typeof finalResult?.details?.toolUseCount === 'number'
    ? finalResult.details.toolUseCount
    : null;
  const hasConcreteToolNames = activities.some((activity) => activity.toolName);
  const isLegacyToolSet = !resolvedResults.some((block) => Array.isArray(block.details?.toolActivities)) &&
    resolvedResults.some((block) => Array.isArray(block.details?.childToolsUsed));
  const emptyActivityText = status === 'running'
    ? 'Waiting for the first tool call...'
    : status === 'error'
      ? 'No tool activity was recorded before this run stopped.'
      : 'Detailed tool activity was not recorded for this earlier run.';

  return (
    <div className="space-y-1">
      {description && description !== request ? <DetailRow label="Task:" value={description} /> : null}
      {agent ? <DetailRow label="Agent:" value={agent} /> : null}
      {model ? <DetailRow label="Model:" value={model} /> : null}
      {request ? (
        <DetailRow
          label="Request:"
          value={<span className="whitespace-pre-wrap break-words text-foreground/80">{request}</span>}
        />
      ) : null}

      <div className="mt-2">
        <div className="mb-1 text-[0.7rem] text-muted-foreground/60">
          {isLegacyToolSet ? 'Tools used' : hasConcreteToolNames ? 'Tool calls' : 'Activity'}
        </div>
        {hiddenActivityCount > 0 ? (
          <div className="mb-1 text-[0.7rem] text-muted-foreground/50">
            {hiddenActivityCount} earlier {hiddenActivityCount === 1 ? 'call' : 'calls'}
          </div>
        ) : null}
        {visibleActivities.length > 0 ? (
          <div className="space-y-1" aria-live="polite">
            {visibleActivities.map((activity, index) => {
              const isLatest = index === visibleActivities.length - 1;
              const activityStatus = status === 'running' && isLatest && activity.status !== 'error'
                ? 'running'
                : activity.status;
              const summary = activity.toolName && activity.label.startsWith(`${activity.toolName} · `)
                ? activity.label.slice(activity.toolName.length + 3)
                : activity.label;
              return (
                <div key={`${activity.toolName}-${activity.label}-${index}`} className="flex min-w-0 items-center gap-2">
                  <span className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40",
                    activityStatus === 'running' && "animate-pulse bg-blue-500 motion-reduce:animate-none",
                    activityStatus === 'error' && "bg-red-500",
                  )} />
                  {activity.toolName ? (
                    <span className="shrink-0 font-mono text-[0.7rem] text-foreground/75">{activity.toolName}</span>
                  ) : null}
                  {summary && summary !== activity.toolName ? (
                    <span className="min-w-0 truncate text-muted-foreground/70">{summary}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-muted-foreground/60">{emptyActivityText}</div>
        )}
      </div>

      {finalResultText ? (
        <div className="group/agent-result mt-2">
          <div className="mb-1 flex items-center justify-between text-[0.7rem] text-muted-foreground/60">
            <span>{resultLabel(tool?.name)}</span>
            <CopyButton
              value={finalResultText}
              label="Copy response"
              hoverClassName="group-hover/agent-result:opacity-100"
            />
          </div>
          <div className="max-h-72 overflow-auto rounded bg-muted/30 p-2 text-sm text-foreground/90">
            <MarkdownRenderer content={finalResultText} />
          </div>
        </div>
      ) : null}

      {duration ? <DetailRow label="Duration:" value={duration} /> : null}
      {toolUseCount !== null ? <DetailRow label="Tool calls:" value={String(toolUseCount)} /> : null}
    </div>
  );
}
