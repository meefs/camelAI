"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow } from './shared';
import { getResultText } from '../tool-utils';

interface TeamCreateDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

export function TeamCreateDetails({ tool, result }: TeamCreateDetailsProps) {
  const input = tool?.input ?? {};
  const teamName = typeof input.team_name === 'string' ? input.team_name : '';
  const description = typeof input.description === 'string' ? input.description : '';

  let leadAgentId = '';
  let configPath = '';
  if (result) {
    const text = getResultText(result);
    try {
      const parsed = JSON.parse(text);
      leadAgentId = typeof parsed.lead_agent_id === 'string' ? parsed.lead_agent_id : '';
      configPath = typeof parsed.team_file_path === 'string' ? parsed.team_file_path : '';
    } catch {
      // Result isn't JSON - ignore
    }
  }

  const configFilename = configPath ? configPath.split('/').pop() || configPath : '';

  return (
    <div className="space-y-1">
      {teamName && <DetailRow label="Team:" value={teamName} />}
      {description && <DetailRow label="Description:" value={description} />}
      {leadAgentId && <DetailRow label="Lead agent:" value={leadAgentId} mono />}
      {configPath && (
        <DetailRow
          label="Config:"
          value={configFilename}
          asFileLink
          filePath={configPath}
          copyValue={configPath}
        />
      )}
    </div>
  );
}
