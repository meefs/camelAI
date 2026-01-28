import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { parseMcpToolName } from '../mcp-utils';
import { GenericDetails } from './generic-details';
import { DetailRow } from './shared';

interface McpDetailsProps {
  tool: ToolUseBlock;
  result?: ToolResultBlock;
}

export function McpDetails({ tool, result }: McpDetailsProps) {
  const parts = parseMcpToolName(tool.name);

  return (
    <div className="space-y-1">
      {parts && <DetailRow label="MCP Server:" value={parts.displayServer} />}
      <GenericDetails tool={tool} result={result} />
    </div>
  );
}
