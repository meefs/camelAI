import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { isMcpTool, parseMcpToolName } from './mcp-utils';
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
  isStreaming?: boolean,
  status?: 'running' | 'complete' | 'error'
): ToolSummaryParts {
  if (!tool) return { action: result ? 'Result' : 'Tool call' };

  const { name, input } = tool;
  const inputRecord = input || {};
  const isRunning = status === 'running' || (status == null && isStreaming && !result);
  const isError = status === 'error';

  if (isMcpTool(name)) {
    const mcpParts = parseMcpToolName(name);
    if (mcpParts) {
      if (isRunning) {
        return { action: `Calling ${mcpParts.displayTool} on ${mcpParts.displayServer}...` };
      }
      if (isError) {
        return { action: `Failed to call ${mcpParts.displayTool} on ${mcpParts.displayServer}` };
      }
      return { action: `Called ${mcpParts.displayTool} on ${mcpParts.displayServer}` };
    }
  }

  switch (name) {
    case 'Read': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isRunning) {
        if (!path) return { action: 'Reading file...' };
        return {
          action: 'Reading',
          filename: getFilename(path),
          path,
        };
      }
      if (isError) {
        return {
          action: 'Failed to read',
          filename: path ? getFilename(path) : undefined,
          path: path || undefined,
        };
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
      if (isRunning) {
        if (!path) return { action: 'Creating file...' };
        return {
          action: 'Creating',
          filename: getFilename(path),
          path,
        };
      }
      if (isError) {
        return {
          action: 'Failed to create',
          filename: path ? getFilename(path) : undefined,
          path: path || undefined,
        };
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
      if (isRunning) {
        if (!path) return { action: 'Editing file...' };
        return {
          action: 'Editing',
          filename: getFilename(path),
          path,
        };
      }
      if (isError) {
        return {
          action: 'Failed to edit',
          filename: path ? getFilename(path) : undefined,
          path: path || undefined,
        };
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
      const label = description || truncate(command || 'command', 30);
      if (isRunning) {
        if (!description && !command) return { action: 'Running command...' };
        return { action: `Running ${label}...` };
      }
      if (isError) {
        return { action: `Failed to run ${label}` };
      }
      return { action: `Ran ${label}` };
    }
    case 'Glob': {
      const globPattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isRunning) {
        if (!globPattern) return { action: 'Searching for files...' };
        return { action: `Searching for "${truncate(globPattern, 20)}"...` };
      }
      if (isError) {
        return { action: 'Failed to search files' };
      }
      const count = parseCountFromResult(result);
      if (count !== null) return { action: `Found ${count} files` };
      if (result) {
        const text = getResultText(result).trim();
        if (!text || text === 'No files found' || text === 'No files found.') {
          return { action: 'No files found' };
        }
        return { action: 'Searched files' };
      }
      return { action: 'Searched files' };
    }
    case 'Grep': {
      const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isRunning) {
        if (!pattern) return { action: 'Searching...' };
        return { action: `Searching for "${truncate(pattern, 20)}"...` };
      }
      if (isError) {
        return { action: 'Failed to search codebase' };
      }
      const count = parseCountFromResult(result);
      if (count !== null) return { action: `Found ${count} matches` };
      if (result) {
        const text = getResultText(result).trim();
        if (!text || text === 'No matches found' || text === 'No matches found.') {
          return { action: 'No matches found' };
        }
        return { action: 'Searched codebase' };
      }
      return { action: 'Searched codebase' };
    }
    case 'Task':
    case 'Agent': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      if (isRunning) {
        const summary = description || 'working...';
        return { action: `Agent: ${summary}` };
      }
      if (isError) {
        const summary = description || 'task';
        return { action: `Agent failed: ${summary}` };
      }
      return { action: `Agent: ${description || 'task'}` };
    }
    case 'AskUserQuestion': {
      const questions = Array.isArray(inputRecord.questions) ? inputRecord.questions : [];

      if (isRunning && !result) {
        return { action: 'Waiting for your input' };
      }

      if (questions.length === 1) {
        const first = questions[0];
        if (first && typeof first === 'object') {
          const header = (first as { header?: unknown }).header;
          if (typeof header === 'string' && header.trim()) {
            return { action: header.trim() };
          }
        }
      }

      if (questions.length > 1) {
        return { action: `Asked ${questions.length} questions` };
      }

      return { action: 'Asked a question' };
    }
    case 'TeamCreate': {
      const teamName = typeof inputRecord.team_name === 'string' ? inputRecord.team_name : '';
      if (isRunning) {
        if (!teamName) return { action: 'Creating team...' };
        return { action: `Creating team ${teamName}...` };
      }
      if (isError) {
        if (!teamName) return { action: 'Failed to create team' };
        return { action: `Failed to create team ${teamName}` };
      }
      return { action: `Created team ${teamName || 'team'}` };
    }
    case 'Skill': {
      const skill = typeof inputRecord.skill === 'string' ? inputRecord.skill : '';
      if (isRunning) {
        if (!skill) return { action: 'Reading skill...' };
        return { action: `Reading skill ${skill}...` };
      }
      if (isError) {
        if (!skill) return { action: 'Failed to read skill' };
        return { action: `Failed to read skill ${skill}` };
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
      if (isRunning) {
        if (!url) return { action: 'Fetching page...' };
        return { action: `Fetching ${getHostname(url)}...` };
      }
      if (isError) {
        return { action: `Failed to fetch ${url ? getHostname(url) : 'web page'}` };
      }
      return { action: `Fetched ${url ? getHostname(url) : 'web page'}` };
    }
    case 'WebSearch':
      if (isRunning) return { action: 'Searching web...' };
      if (isError) return { action: 'Failed to search web' };
      return { action: 'Searched web' };
    case 'TodoWrite':
      if (isRunning) return { action: 'Updating tasks...' };
      if (isError) return { action: 'Failed to update tasks' };
      return { action: 'Updated tasks' };
    case 'NotebookEdit':
      if (isRunning) return { action: 'Editing notebook cell...' };
      if (isError) return { action: 'Failed to edit notebook cell' };
      return { action: 'Edited notebook cell' };
    case 'KillShell':
      if (isRunning) return { action: 'Stopping background task...' };
      if (isError) return { action: 'Failed to stop background task' };
      return { action: 'Stopped background task' };
    case 'TaskOutput':
      if (isRunning) return { action: 'Retrieving task output...' };
      if (isError) return { action: 'Failed to retrieve task output' };
      return { action: 'Retrieved task output' };
    case 'CodexFileChange': {
      const changes = Array.isArray(inputRecord.changes) ? inputRecord.changes : [];
      const firstPath = changes.find((change): change is { path: string } => (
        Boolean(change) &&
        typeof change === 'object' &&
        typeof (change as { path?: unknown }).path === 'string'
      ))?.path;
      if (isRunning) {
        return firstPath
          ? { action: 'Updating', filename: getFilename(firstPath), path: firstPath }
          : { action: 'Applying file changes...' };
      }
      if (isError) {
        return firstPath
          ? { action: 'Failed to update', filename: getFilename(firstPath), path: firstPath }
          : { action: 'Failed to apply file changes' };
      }
      return firstPath
        ? { action: 'Updated', filename: getFilename(firstPath), path: firstPath }
        : { action: 'Applied file changes' };
    }
    case 'CodexReviewMode':
      if (isRunning) return { action: 'Updating review mode...' };
      if (isError) return { action: 'Failed to update review mode' };
      return { action: 'Updated review mode' };
    case 'CodexContextCompaction':
      if (isRunning) return { action: 'Compacting context...' };
      if (isError) return { action: 'Failed to compact context' };
      return { action: 'Compacted context' };
    case 'CodexImageView': {
      const path = typeof inputRecord.path === 'string' ? inputRecord.path : '';
      if (isRunning) {
        return path
          ? { action: 'Viewing', filename: getFilename(path), path }
          : { action: 'Viewing image...' };
      }
      if (isError) {
        return path
          ? { action: 'Failed to view', filename: getFilename(path), path }
          : { action: 'Failed to view image' };
      }
      return path
        ? { action: 'Viewed', filename: getFilename(path), path }
        : { action: 'Viewed image' };
    }
    case 'CodexImageGeneration':
      if (isRunning) return { action: 'Generating image...' };
      if (isError) return { action: 'Failed to generate image' };
      return { action: 'Generated image' };
    default:
      if (isRunning) return { action: `${name || 'Tool'}...` };
      if (isError) return { action: `Failed ${name || 'tool'}` };
      return { action: name || (result ? 'Result' : 'Tool call') };
  }
}

export function getToolSummary(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  status?: 'running' | 'complete' | 'error',
  isStreaming?: boolean
): string {
  const parts = getToolSummaryParts(tool, result, isStreaming, status);
  if (parts.filename) {
    return `${parts.action} ${parts.filename}`;
  }
  return parts.action;
}
