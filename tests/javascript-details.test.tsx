import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JavaScriptDetails } from '@/components/tool-call/details/javascript-details';
import type { ToolResultBlock, ToolUseBlock } from '@/types';

describe('JavaScriptDetails', () => {
  it('shows the tool description when provided', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_js_exec',
      name: 'JavaScript',
      input: {
        description: 'checking database connection',
        code: 'return await env.CONNECTIONS.test("postgres");',
      },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_js_exec',
      content: 'ok',
    };

    render(<JavaScriptDetails tool={tool} result={result} />);

    expect(screen.getByText('Description:')).toBeInTheDocument();
    expect(screen.getByText('checking database connection')).toBeInTheDocument();
  });
});
