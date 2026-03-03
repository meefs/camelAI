import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@/types';
import { getToolSummary, getToolSummaryParts } from '@/components/tool-call/tool-summary';

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

function makeReadTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_read',
    name: 'Read',
    input,
  };
}

function makeWriteTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_write',
    name: 'Write',
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

describe('getToolSummaryParts tense follows status', () => {
  it('uses present tense while running even when file path is known', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    const summary = getToolSummaryParts(tool, undefined, true, 'running');
    expect(summary.action).toBe('Reading');
    expect(summary.filename).toBe('app.tsx');
  });

  it('uses past tense when complete even if streaming flag remains true', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    const summary = getToolSummaryParts(tool, undefined, true, 'complete');
    expect(summary.action).toBe('Read');
    expect(summary.filename).toBe('app.tsx');
  });

  it('uses present tense while running even when streaming flag is false', () => {
    const tool = makeWriteTool({ file_path: '/workspace/src/new-file.ts' });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');
    expect(summary.action).toBe('Creating');
    expect(summary.filename).toBe('new-file.ts');
  });
});

describe('getToolSummary', () => {
  it('uses provided status when building summary text', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    expect(getToolSummary(tool, undefined, 'running', true)).toBe('Reading app.tsx');
    expect(getToolSummary(tool, undefined, 'complete', true)).toBe('Read app.tsx');
  });
});
