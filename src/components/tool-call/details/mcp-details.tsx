import type { ToolResultBlock, ToolUseBlock } from '@/types';
import {
  isSetFilePreviewToolName,
  isSetPreviewToolName,
  parseMcpToolName,
} from '../mcp-utils';
import { GenericDetails } from './generic-details';
import { DetailRow, ProjectDetailRow } from './shared';

interface McpDetailsProps {
  tool: ToolUseBlock;
  result?: ToolResultBlock;
}

function getMcpProjectInput(input?: Record<string, unknown>): Record<string, unknown> | undefined {
  const args = input?.arguments;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return input;
}

export function McpDetails({ tool, result }: McpDetailsProps) {
  const parts = parseMcpToolName(tool.name);
  const isInternalPreviewTool =
    isSetPreviewToolName(tool.name) || isSetFilePreviewToolName(tool.name);

  return (
    <div className="space-y-1">
      {parts && <DetailRow label="MCP Server:" value={parts.displayServer} />}
      {isInternalPreviewTool ? (
        <ProjectDetailRow input={getMcpProjectInput(tool.input)} />
      ) : null}
      <GenericDetails tool={tool} result={result} showProject={false} />
    </div>
  );
}
