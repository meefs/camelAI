import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolCall } from '@/components/tool-call/tool-call';
import type { ToolResultBlock, ToolUseBlock } from '@/types';

function makeTool(): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool-1',
    name: 'Bash',
    input: { command: 'echo ok' },
  };
}

function makeResult(overrides: Partial<ToolResultBlock>): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'done',
    ...overrides,
  };
}

describe('ToolCall status dot rendering', () => {
  it('renders a red dot for failed results', () => {
    const { container } = render(
      <ToolCall
        tool={makeTool()}
        result={makeResult({ status: 'failed' })}
        isStreaming={false}
      />,
    );

    expect(container.querySelector('.tool-call__dot')).toHaveClass('bg-red-500');
  });

  it('renders a green dot for succeeded results', () => {
    const { container } = render(
      <ToolCall
        tool={makeTool()}
        result={makeResult({ status: 'succeeded' })}
        isStreaming={false}
      />,
    );

    expect(container.querySelector('.tool-call__dot')).toHaveClass('bg-green-500');
  });
});
