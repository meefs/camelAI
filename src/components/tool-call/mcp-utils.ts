const MCP_PREFIX = 'mcp__';
const LEGACY_ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
const SET_PREVIEW_TOOL = 'set_preview';
const SET_FILE_PREVIEW_TOOL = 'set_file_preview';
const SET_APP_PREVIEW_TOOL = 'set_app_preview';

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

export interface McpToolParts {
  serverName: string;
  toolName: string;
  displayServer: string;
  displayTool: string;
}

export function parseMcpToolName(name: string): McpToolParts | null {
  if (!isMcpTool(name)) return null;
  const withoutPrefix = name.slice(MCP_PREFIX.length);
  const separatorIdx = withoutPrefix.indexOf('__');
  if (separatorIdx === -1) return null;
  const serverName = withoutPrefix.slice(0, separatorIdx);
  const toolName = withoutPrefix.slice(separatorIdx + 2);
  return {
    serverName,
    toolName,
    displayServer: titleCase(serverName),
    displayTool: toolName.replace(/_/g, ' '),
  };
}

export function isAskUserQuestionToolName(name?: string): boolean {
  if (!name) return false;
  return name === LEGACY_ASK_USER_QUESTION_TOOL;
}

export function isSetFilePreviewToolName(name?: string): boolean {
  if (!name) return false;
  if (name === SET_FILE_PREVIEW_TOOL) return true;
  return parseMcpToolName(name)?.toolName === SET_FILE_PREVIEW_TOOL;
}

export function isSetAppPreviewToolName(name?: string): boolean {
  if (!name) return false;
  if (name === SET_APP_PREVIEW_TOOL) return true;
  return parseMcpToolName(name)?.toolName === SET_APP_PREVIEW_TOOL;
}

export function isSetPreviewToolName(name?: string): boolean {
  if (!name) return false;
  if (name === SET_PREVIEW_TOOL) return true;
  return parseMcpToolName(name)?.toolName === SET_PREVIEW_TOOL;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
