import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
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

function makeCustomAskUserQuestionTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_custom_ask_user_question',
    name: 'mcp__camelai_ui__ask_user_question',
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

function makeMcpTool(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: `tool_${name}`,
    name,
    input,
  };
}

function makeToolResult(content: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool_result',
    content,
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

  it('uses the same summary copy for the custom ask_user_question MCP tool', () => {
    const tool = makeCustomAskUserQuestionTool({
      questions: [{ question: 'Preferred auth method?', header: 'Auth method' }],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Auth method');
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

describe('getToolSummaryParts set-preview MCP tools', () => {
  it('renders unified set_preview with a file path as a clickable file summary source', () => {
    const tool = makeMcpTool('set_preview', {
      path: '/home/claude/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'app.tsx',
      path: '/home/claude/src/app.tsx',
    });
  });

  it('renders unified set_preview with an app preview target when is_public is parseable', () => {
    const tool = makeMcpTool('set_preview', {
      script_name: 'my-todo-app',
    });
    const result = makeToolResult(JSON.stringify({
      success: true,
      target: {
        kind: 'app',
        scriptName: 'my-todo-app',
        isPublic: false,
      },
    }));
    const summary = getToolSummaryParts(tool, result, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app', isPublic: false },
    });
  });

  it('shows generic opening copy while set_file_preview is running without a path', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview');
    const summary = getToolSummaryParts(tool, undefined, false, 'running');

    expect(summary).toEqual({
      action: 'Opening preview...',
    });
  });

  it('shows the filename while set_file_preview is running with a path', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      path: '/home/claude/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');

    expect(summary).toEqual({
      action: 'Opening preview',
      filename: 'app.tsx',
      path: '/home/claude/src/app.tsx',
    });
  });

  it('renders set_file_preview as a clickable file summary source', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      path: '/home/claude/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'app.tsx',
      path: '/home/claude/src/app.tsx',
    });
  });

  it('shows file preview error copy with the filename', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      path: '/home/claude/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'error');

    expect(summary).toEqual({
      action: 'Failed to preview',
      filename: 'app.tsx',
      path: '/home/claude/src/app.tsx',
    });
  });

  it('shows the script name while set_app_preview is running', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_app_preview', {
      script_name: 'my-todo-app',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');

    expect(summary).toEqual({
      action: 'Opening preview',
      filename: 'my-todo-app',
    });
  });

  it('renders set_app_preview with an app preview target when is_public is parseable', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_app_preview', {
      script_name: 'my-todo-app',
    });
    const result = makeToolResult(JSON.stringify({
      success: true,
      app: {
        name: 'my-todo-app',
        url: 'https://my-todo-app.camelai.app',
        is_public: true,
      },
    }));
    const summary = getToolSummaryParts(tool, result, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app', isPublic: true },
    });
  });

  it('shows app preview error copy with the script name', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_app_preview', {
      script_name: 'my-todo-app',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'error');

    expect(summary).toEqual({
      action: 'Failed to preview',
      filename: 'my-todo-app',
    });
  });

  it('leaves set_app_preview plain when is_public cannot be determined', () => {
    const tool = makeMcpTool('set_app_preview', {
      script_name: 'my-private-app',
    });
    const summary = getToolSummaryParts(tool, makeToolResult('not json'), false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-private-app',
    });
  });
});

describe('getToolSummary', () => {
  it('uses provided status when building summary text', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    expect(getToolSummary(tool, undefined, 'running', true)).toBe('Reading app.tsx');
    expect(getToolSummary(tool, undefined, 'complete', true)).toBe('Read app.tsx');
  });
});
