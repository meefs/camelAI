import type { ToolResultBlock, ToolUseBlock } from '@/types';

export type ToolStatus = 'running' | 'complete' | 'error';

export function getToolStatus(
  _tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean
): ToolStatus {
  if (isStreaming && !result) return 'running';
  if (result && (result as { is_error?: boolean }).is_error) return 'error';
  if (result) return 'complete';
  return tool ? 'running' : 'running';
}
