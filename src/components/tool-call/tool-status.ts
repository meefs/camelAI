import type { ToolResultBlock, ToolUseBlock } from '@/types';

export type ToolStatus = 'running' | 'complete' | 'error';

export function getToolStatus(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean,
  results?: ToolResultBlock[],
  agentContinued?: boolean
): ToolStatus {
  if (tool?.name === 'Task') {
    const finalResult = results?.find(block => !block.isTaskUpdate) ??
      (result && !result.isTaskUpdate ? result : undefined);
    if (finalResult && (finalResult as { is_error?: boolean }).is_error) return 'error';
    if (finalResult) return 'complete';
    return 'running';
  }

  if (result && (result as { is_error?: boolean }).is_error) return 'error';
  if (isStreaming && !result) return 'running';
  if (result) return 'complete';
  // No result object, but the agent produced content after this tool call —
  // the tool must have completed since the agent can't continue without its result.
  if (agentContinued) return 'complete';
  return 'running';
}
