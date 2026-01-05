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

export function getToolSummary(tool?: ToolUseBlock, result?: ToolResultBlock): string {
  if (!tool) return result ? 'Result' : 'Tool call';

  const { name, input } = tool;
  const inputRecord = input || {};

  switch (name) {
    case 'Read': {
      const path = typeof inputRecord.file_path === 'string' ? inputRecord.file_path : '';
      return `Read ${path ? getFilename(path) : 'file'}`;
    }
    case 'Write': {
      const path = typeof inputRecord.file_path === 'string' ? inputRecord.file_path : '';
      return `Created ${path ? getFilename(path) : 'file'}`;
    }
    case 'Edit': {
      const path = typeof inputRecord.file_path === 'string' ? inputRecord.file_path : '';
      return `Edited ${path ? getFilename(path) : 'file'}`;
    }
    case 'Bash': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
      return description
        ? `Ran ${description}`
        : `Ran ${truncate(command || 'command', 30)}`;
    }
    case 'Glob': {
      const count = parseCountFromResult(result);
      return count !== null ? `Found ${count} files` : 'Searching for files...';
    }
    case 'Grep': {
      const count = parseCountFromResult(result);
      if (count !== null) return `Found ${count} matches`;
      const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      return `Searching for "${truncate(pattern || 'pattern', 20)}"...`;
    }
    case 'Task': {
      if (result) return 'Agent completed task';
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      return `Agent: ${description || 'working...'}`;
    }
    case 'WebFetch': {
      const url = typeof inputRecord.url === 'string' ? inputRecord.url : '';
      return `Fetched ${url ? getHostname(url) : 'web page'}`;
    }
    case 'WebSearch':
      return 'Searched web';
    case 'TodoWrite':
      return 'Updated tasks';
    case 'NotebookEdit':
      return 'Edited notebook cell';
    case 'KillShell':
      return 'Stopped background task';
    case 'TaskOutput':
      return 'Retrieved task output';
    default:
      return name;
  }
}
