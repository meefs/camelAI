import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BashDetails } from '@/components/tool-call/details/bash-details';
import { GenericDetails } from '@/components/tool-call/details/generic-details';
import { McpDetails } from '@/components/tool-call/details/mcp-details';
import { ReadDetails } from '@/components/tool-call/details/read-details';
import { buildToolUseFromPiItem, type PiThreadItem } from '@/lib/pi-tool-builders';
import type { ToolUseBlock } from '@/types';

const { mockUseAuthData } = vi.hoisted(() => ({
  mockUseAuthData: vi.fn(),
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => mockUseAuthData(),
}));

function makeTool(name: string, input: Record<string, unknown>): ToolUseBlock {
  return {
    type: 'tool_use',
    id: `tool_${name}`,
    name,
    input,
  };
}

function makeToolFromPiItem(item: PiThreadItem): ToolUseBlock {
  const toolUse = buildToolUseFromPiItem(item);
  if (!toolUse) throw new Error(`Expected tool use for ${item.type}`);
  return {
    type: 'tool_use',
    id: item.id,
    name: toolUse.name,
    input: toolUse.input,
  };
}

describe('tool detail project rows', () => {
  beforeEach(() => {
    mockUseAuthData.mockReset();
    mockUseAuthData.mockReturnValue({
      currentWorkspace: { id: 'thread-ws' },
    });
  });

  it('shows and copies the raw project name for file tools', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    render(
      <ReadDetails
        tool={makeTool('read', {
          location: 'vm',
          project: ' menu-app ',
          path: '/src/index.html',
        })}
      />,
    );

    expect(screen.getByText('Project:')).toBeInTheDocument();
    expect(screen.getByText('menu-app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy project name' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('menu-app');
    });
  });

  it('places the project row after the command row for bash', () => {
    const { container } = render(
      <BashDetails
        tool={makeToolFromPiItem({
          id: 'tool-bash',
          type: 'commandExecution',
          command: 'bun run build',
          project: 'menu-app',
          description: 'Build the app',
          status: 'running',
        })}
      />,
    );

    expect(container.textContent).toContain(
      'Command:bun run buildProject:menu-appDescription:Build the app',
    );
  });

  it('surfaces project metadata before generic JSON blocks', () => {
    const { container } = render(
      <GenericDetails
        tool={makeTool('delete_project', {
          project: 'menu-app',
        })}
      />,
    );

    expect(container.textContent).toContain('Project:menu-appInput');
  });

  it('only shows MCP project rows for internal preview tools', () => {
    const { rerender } = render(
      <McpDetails
        tool={makeToolFromPiItem({
          id: 'tool-mcp-preview',
          type: 'mcpToolCall',
          server: 'internal',
          tool: 'set_file_preview',
          arguments: {
            project: 'menu-app',
            path: '/index.html',
          },
          status: 'completed',
          durationMs: 42,
        })}
      />,
    );

    expect(screen.getByText('Project:')).toBeInTheDocument();
    expect(screen.getByText('menu-app')).toBeInTheDocument();

    rerender(
      <McpDetails
        tool={makeToolFromPiItem({
          id: 'tool-mcp-analytics',
          type: 'mcpToolCall',
          server: 'analytics',
          tool: 'query',
          arguments: {
            project: 'analytics-prod',
            sql: 'select 1',
          },
          status: 'completed',
        })}
      />,
    );

    expect(screen.queryByText('Project:')).not.toBeInTheDocument();
  });
});
