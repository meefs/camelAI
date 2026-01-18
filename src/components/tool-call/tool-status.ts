import type { ToolResultBlock, ToolUseBlock } from '@/types';

export type ToolStatus = 'running' | 'complete' | 'error';

export function getToolStatus(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean,
  results?: ToolResultBlock[]
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
  return 'running';
}
