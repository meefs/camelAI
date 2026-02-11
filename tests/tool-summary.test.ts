import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@/types';
import { getToolSummaryParts } from '@/components/tool-call/tool-summary';

function makeTeamCreateTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_team_create',
    name: 'TeamCreate',
    input,
  };
}

describe('getToolSummaryParts TeamCreate', () => {
  it('shows running copy while creating a team', () => {
    const tool = makeTeamCreateTool({ team_name: 'Alpha' });
    const summary = getToolSummaryParts(tool, undefined, true, 'running');
    expect(summary.action).toBe('Creating team Alpha...');
  });

  it('shows error copy when team creation fails', () => {
    const tool = makeTeamCreateTool({ team_name: 'Alpha' });
    const summary = getToolSummaryParts(tool, undefined, false, 'error');
    expect(summary.action).toBe('Failed to create team Alpha');
  });

  it('falls back to generic error copy when name is missing', () => {
    const tool = makeTeamCreateTool();
    const summary = getToolSummaryParts(tool, undefined, false, 'error');
    expect(summary.action).toBe('Failed to create team');
  });

  it('shows success copy only for complete status', () => {
    const tool = makeTeamCreateTool({ team_name: 'Alpha' });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Created team Alpha');
  });
});
