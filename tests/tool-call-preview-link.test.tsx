import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { ToolCall } from '@/components/tool-call/tool-call';
import type { ToolUseBlock } from '@/types';

function makePreviewTool(input: Record<string, unknown>): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_preview',
    name: 'set_preview',
    input,
  };
}

describe('ToolCall Preview links', () => {
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
});
