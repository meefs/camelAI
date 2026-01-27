const MCP_PREFIX = 'mcp__';

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

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
