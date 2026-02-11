import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { AskUserQuestionDetails } from '@/components/tool-call/details/ask-user-question-details';

function makeTool(question: string): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_ask_user_question',
    name: 'AskUserQuestion',
    input: {
      questions: [{ question }],
    },
  };
}

function makeResult(question: string, answer: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool_ask_user_question',
    content: `"${question}"="${answer}"`,
  };
}

describe('AskUserQuestionDetails', () => {
  it('preserves literal backslash sequences in answers', () => {
    const tool = makeTool('Path?');
    const result = makeResult('Path?', 'C:\\\\new');

    render(<AskUserQuestionDetails tool={tool} result={result} />);

    expect(screen.getByText('C:\\new')).toBeInTheDocument();
  });

  it('still decodes escaped control characters', () => {
    const tool = makeTool('Notes?');
    const result = makeResult('Notes?', 'line1\\nline2');

    render(<AskUserQuestionDetails tool={tool} result={result} />);

    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'P' && element.textContent === 'line1\nline2'
      )
    ).toBeInTheDocument();
  });
});
