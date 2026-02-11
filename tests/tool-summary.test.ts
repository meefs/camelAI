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

function makeAskUserQuestionTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_ask_user_question',
    name: 'AskUserQuestion',
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

describe('getToolSummaryParts AskUserQuestion', () => {
  it('shows waiting copy while running with no result', () => {
    const tool = makeAskUserQuestionTool({
      questions: [{ question: 'Preferred auth method?', header: 'Auth method' }],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');
    expect(summary.action).toBe('Waiting for your input');
  });

  it('uses the question header for single-question prompts', () => {
    const tool = makeAskUserQuestionTool({
      questions: [{ question: 'Preferred auth method?', header: 'Auth method' }],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Auth method');
  });

  it('shows question count when multiple questions are asked', () => {
    const tool = makeAskUserQuestionTool({
      questions: [
        { question: 'Question 1', header: 'One' },
        { question: 'Question 2', header: 'Two' },
      ],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Asked 2 questions');
  });

  it('falls back to generic copy when no usable questions are present', () => {
    const tool = makeAskUserQuestionTool();
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Asked a question');
  });
});
