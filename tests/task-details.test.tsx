import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  TaskDetails,
  getTaskActivities,
  getTaskToolActivities,
} from '@/components/tool-call/details/task-details';
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
  it('preserves the actual child tool calls from legacy streamed updates', () => {
    expect(getTaskActivities([
      progress('Oracle started.Running Read...Running Read...Running Edit...'),
    ])).toEqual([
      'Read',
      'Read',
      'Edit',
    ]);
  });

  it('uses structured child tool calls and renders the final response as markdown', () => {
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
        activities: ['read · public/main.js', 'edit · public/main.js', 'js_exec · Run checks'],
        toolActivities: [
          { toolCallId: 'child-1', toolName: 'read', label: 'read · public/main.js', status: 'complete' },
          { toolCallId: 'child-2', toolName: 'edit', label: 'edit · public/main.js', status: 'complete' },
          { toolCallId: 'child-3', toolName: 'js_exec', label: 'js_exec · Run checks', status: 'complete' },
        ],
        durationMs: 65_000,
        toolUseCount: 3,
      },
    };

    render(<TaskDetails tool={tool} result={result} results={[result]} status="complete" />);

    expect(getTaskToolActivities([result])).toHaveLength(3);
    expect(screen.getByText('Tool calls')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.getAllByText('public/main.js')).toHaveLength(2);
    expect(screen.getByText('Run checks')).toBeInTheDocument();
    expect(screen.getByText('Fixed', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('explains why an older completed run has no detailed activity', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'oracle-old',
      name: 'Oracle',
      input: { question: 'Investigate this.' },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'oracle-old',
      content: 'Done.',
      status: 'succeeded',
    };

    render(<TaskDetails tool={tool} result={result} results={[result]} status="complete" />);

    expect(screen.getByText('Detailed tool activity was not recorded for this earlier run.')).toBeInTheDocument();
  });

  it('shows the concrete unique tool names retained by older Oracle results', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'oracle-legacy',
      name: 'Oracle',
      input: { question: 'Investigate this.' },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'oracle-legacy',
      content: 'Done.',
      status: 'succeeded',
      details: {
        childToolsUsed: ['read', 'edit', 'js_exec'],
        toolUseCount: 12,
      },
    };

    render(<TaskDetails tool={tool} result={result} results={[result]} status="complete" />);

    expect(screen.getByText('Tools used')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.getByText('js_exec')).toBeInTheDocument();
    expect(screen.queryByText('Detailed tool activity was not recorded for this earlier run.')).not.toBeInTheDocument();
  });
});
