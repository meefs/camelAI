import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TaskDetails, getTaskActivities } from '@/components/tool-call/details/task-details';
import type { ToolResultBlock, ToolUseBlock } from '@/types';

function progress(content: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'oracle-1',
    content,
    isTaskUpdate: true,
  };
}

describe('TaskDetails agent progress', () => {
  it('turns streamed updates into a concise, deduplicated activity timeline', () => {
    expect(getTaskActivities([
      progress('Oracle started.Running Read...Running Read...Running Edit...'),
    ])).toEqual([
      'Reviewing the problem',
      'Inspecting the workspace',
      'Making changes',
    ]);
  });

  it('uses persisted activity metadata and renders the final response as markdown', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'oracle-1',
      name: 'Oracle',
      input: { question: 'Find and fix the race condition.' },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'oracle-1',
      content: '**Fixed** the race condition.',
      status: 'succeeded',
      details: {
        activities: ['Reviewing the problem', 'Inspecting the workspace', 'Making changes'],
        durationMs: 65_000,
        toolUseCount: 3,
      },
    };

    render(<TaskDetails tool={tool} result={result} results={[result]} status="complete" />);

    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('Making changes')).toBeInTheDocument();
    expect(screen.getByText('Fixed', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Completed in 1m 5s · 3 actions')).toBeInTheDocument();
  });
});
