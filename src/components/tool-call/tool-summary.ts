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

export function getToolSummaryParts(tool?: ToolUseBlock, result?: ToolResultBlock): ToolSummaryParts {
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
      return {
        action: 'Edited',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }
    case 'Bash': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
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
      return { action: `Searching for "${truncate(pattern || 'pattern', 20)}"...` };
    }
    case 'Task': {
      if (result) return { action: 'Agent completed task' };
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      return { action: `Agent: ${description || 'working...'}` };
    }
    case 'WebFetch': {
      const url = typeof inputRecord.url === 'string' ? inputRecord.url : '';
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

export function getToolSummary(tool?: ToolUseBlock, result?: ToolResultBlock): string {
  const parts = getToolSummaryParts(tool, result);
  if (parts.filename) {
    return `${parts.action} ${parts.filename}`;
  }
  return parts.action;
}
