import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { isSubAgentTool } from './tool-utils';

export type ToolStatus = 'running' | 'complete' | 'error';

export function ratchetToolStatus(previous: ToolStatus | undefined, next: ToolStatus): ToolStatus {
  if ((previous === 'complete' || previous === 'error') && next === 'running') {
    return previous;
  }
  return next;
}

export function ratchetToolStatusForIdentity(
  previousStatus: ToolStatus | undefined,
  previousIdentity: string | undefined,
  nextStatus: ToolStatus,
  nextIdentity: string
): ToolStatus {
  if (previousIdentity !== nextIdentity) {
    return nextStatus;
  }
  return ratchetToolStatus(previousStatus, nextStatus);
}

export function getToolStatus(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  results?: ToolResultBlock[],
  agentContinued?: boolean
): ToolStatus {
  if (isSubAgentTool(tool?.name)) {
    const finalResult = results?.find(block => !block.isTaskUpdate) ??
      (result && !result.isTaskUpdate ? result : undefined);
    if (finalResult && (finalResult as { is_error?: boolean }).is_error) return 'error';
    if (finalResult) return 'complete';
    return 'running';
  }

  if (result && (result as { is_error?: boolean }).is_error) return 'error';
  if (result) return 'complete';
  // No result object, but the agent produced content after this tool call —
  // the tool must have completed since the agent can't continue without its result.
  if (agentContinued) return 'complete';
  return 'running';
}
