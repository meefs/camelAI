import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { getResultText } from './tool-utils';

function getFilename(path: string): string {
  const trimmed = path.trim();
  return trimmed.split('/').pop() || trimmed;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function parseCountFromResult(result?: ToolResultBlock): number | null {
  if (!result) return null;
  const content = getResultText(result);
  const match = content.match(/Found\s+(\d+)\s+(files|matches)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

export interface ToolSummaryParts {
  action: string;
  filename?: string;
  path?: string;
}

export function getToolSummaryParts(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean
): ToolSummaryParts {
  if (!tool) return { action: result ? 'Result' : 'Tool call' };

  const { name, input } = tool;
  const inputRecord = input || {};

  switch (name) {
    case 'Read': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isStreaming && !path) {
        return { action: 'Reading file...' };
      }
      return {
        action: 'Read',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }
    case 'Write': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isStreaming && !path) {
        return { action: 'Creating file...' };
      }
      return {
        action: 'Created',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }
    case 'Edit': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isStreaming && !path) {
        return { action: 'Editing file...' };
      }
      return {
        action: 'Edited',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }
    case 'Bash': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
      if (isStreaming && !description && !command) {
        return { action: 'Running command...' };
      }
      return {
        action: description
          ? `Ran ${description}`
          : `Ran ${truncate(command || 'command', 30)}`,
      };
    }
    case 'Glob': {
      const count = parseCountFromResult(result);
      return { action: count !== null ? `Found ${count} files` : 'Searching for files...' };
    }
    case 'Grep': {
      const count = parseCountFromResult(result);
      if (count !== null) return { action: `Found ${count} matches` };
      const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isStreaming && !pattern) {
        return { action: 'Searching...' };
      }
      return { action: `Searching for "${truncate(pattern || 'pattern', 20)}"...` };
    }
    case 'Task': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      const summary = description || (isStreaming ? 'working...' : 'task');
      return { action: `Agent: ${summary}` };
    }
    case 'Skill': {
      const skill = typeof inputRecord.skill === 'string' ? inputRecord.skill : '';
      if (isStreaming) {
        return { action: 'Reading skill...' };
      }
      const path = skill ? `/home/claude/.claude/skills/${skill}/SKILL.md` : '';
      return {
        action: 'Read skill',
        filename: skill || 'skill',
        path: path || undefined,
      };
    }
    case 'WebFetch': {
      const url = typeof inputRecord.url === 'string' ? inputRecord.url : '';
      if (isStreaming && !url) {
        return { action: 'Fetching page...' };
      }
      return { action: `Fetched ${url ? getHostname(url) : 'web page'}` };
    }
    case 'WebSearch':
      return { action: 'Searched web' };
    case 'TodoWrite':
      return { action: 'Updated tasks' };
    case 'NotebookEdit':
      return { action: 'Edited notebook cell' };
    case 'KillShell':
      return { action: 'Stopped background task' };
    case 'TaskOutput':
      return { action: 'Retrieved task output' };
    default:
      return { action: name };
  }
}

export function getToolSummary(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean
): string {
  const parts = getToolSummaryParts(tool, result, isStreaming);
  if (parts.filename) {
    return `${parts.action} ${parts.filename}`;
  }
  return parts.action;
}
