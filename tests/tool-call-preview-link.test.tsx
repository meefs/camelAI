import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { ToolCall } from '@/components/tool-call/tool-call';
import type { ToolResultBlock, ToolUseBlock } from '@/types';

const { mockUseAuthData } = vi.hoisted(() => ({
  mockUseAuthData: vi.fn(),
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => mockUseAuthData(),
}));

function makePreviewTool(input: Record<string, unknown>): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_preview',
    name: 'set_preview',
    input,
  };
}

function makeTool(name: string, input: Record<string, unknown>): ToolUseBlock {
  return {
    type: 'tool_use',
    id: `tool_${name}`,
    name,
    input,
  };
}

function makeResult(content: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool_result',
    content,
  };
}

describe('ToolCall Preview links', () => {
  beforeEach(() => {
    mockUseAuthData.mockReset();
    mockUseAuthData.mockReturnValue({
      currentWorkspace: { id: 'other-ws' },
    });
  });

  it('resolves unknown visibility before opening completed app previews', async () => {
    const openPreviewTarget = vi.fn();
    const resolveAppVisibility = vi.fn().mockResolvedValue(true);
    const tool = makePreviewTool({ app_name: 'my-todo-app' });

    render(
      <ChatPreviewProvider
        value={{
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
          resolveAppVisibility,
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    const previewTag = screen.getByRole('button', { name: 'my-todo-app' });

    expect(previewTag).toHaveClass(
      'inline-flex',
      'min-w-0',
      'max-w-full',
      'items-center',
      'gap-1',
      'hover:underline',
      'text-foreground/80',
      'hover:text-foreground',
    );

    fireEvent.click(previewTag);

    await waitFor(() => {
      expect(openPreviewTarget).toHaveBeenCalledWith({
        kind: 'app',
        scriptName: 'my-todo-app',
        isPublic: true,
      });
    });
    expect(resolveAppVisibility).toHaveBeenCalledWith('my-todo-app');
  });

  it('uses known visibility without resolving it again', () => {
    const openPreviewTarget = vi.fn();
    const resolveAppVisibility = vi.fn();
    const tool = makePreviewTool({ app_name: 'my-todo-app', is_public: false });

    render(
      <ChatPreviewProvider
        value={{
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
          resolveAppVisibility,
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'my-todo-app' }));

    expect(resolveAppVisibility).not.toHaveBeenCalled();
    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'app',
      scriptName: 'my-todo-app',
      isPublic: false,
    });
  });

  it('opens read project file tags with project metadata', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('read', {
      location: 'project',
      project: 'demo-app',
      path: '/src/App.tsx',
    });

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'App.tsx' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'project',
      workspaceId: 'thread-ws',
      project: 'demo-app',
      path: '/src/App.tsx',
      filename: 'App.tsx',
    });
  });

  it('opens write output tags without double-prefixing outputs', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('write', {
      location: 'r2',
      path: 'outputs/report.html',
      content: '<h1>Report</h1>',
    });

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'report.html' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'output',
      workspaceId: 'thread-ws',
      path: 'report.html',
      filename: 'report.html',
    });
  });

  it('opens read upload tags through the upload source', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('read', {
      location: 'r2',
      path: 'uploads/data.csv',
    });

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'data.csv' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'upload',
      workspaceId: 'thread-ws',
      path: 'data.csv',
      filename: 'data.csv',
    });
  });

  it('opens edit workspace tags through the workspace source', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('edit', {
      location: 'workspace',
      path: '/notes.md',
      edits: [{ old_string: 'old', new_string: 'new' }],
    });

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'workspace',
      workspaceId: 'thread-ws',
      path: '/notes.md',
      filename: 'notes.md',
    });
  });

  it('opens set_preview project file tags with normalized paths', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('set_preview', {
      location: 'project',
      project: 'demo-app',
      path: 'index.html',
    });

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'index.html' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'project',
      workspaceId: 'thread-ws',
      project: 'demo-app',
      path: '/index.html',
      filename: 'index.html',
    });
  });

  it('uses completed set_file_preview result targets before input fallback', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('set_file_preview', {
      location: 'workspace',
      path: '/wrong.md',
    });
    const result = makeResult(JSON.stringify({
      success: true,
      target: {
        kind: 'file',
        source: 'output',
        path: 'plot.png',
      },
    }));

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} result={result} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'plot.png' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'output',
      workspaceId: 'thread-ws',
      path: 'plot.png',
      filename: 'plot.png',
    });
  });

  it('does not render non-previewable R2 tmp paths as clickable tags', () => {
    const openPreviewTarget = vi.fn();
    const tool = makeTool('read', {
      location: 'r2',
      path: 'tmp/private.txt',
    });

    render(
      <ChatPreviewProvider
        value={{
          workspaceId: 'thread-ws',
          openPreviewTarget,
          clearPreviewTarget: vi.fn(),
        }}
      >
        <ToolCall tool={tool} isStreaming={false} />
      </ChatPreviewProvider>,
    );

    expect(screen.getByText('private.txt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'private.txt' })).toBeNull();
    expect(openPreviewTarget).not.toHaveBeenCalled();
  });
});
