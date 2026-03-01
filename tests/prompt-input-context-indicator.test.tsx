import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode, SVGProps } from 'react';
import { PromptInput } from '@/components/prompt-input';

const { arrowUpRenderSpy } = vi.hoisted(() => ({
  arrowUpRenderSpy: vi.fn(),
}));

vi.mock('lucide-react', () => {
  function makeIcon(testId: string, onRender?: () => void) {
    return function Icon(props: SVGProps<SVGSVGElement>) {
      onRender?.();
      return <svg data-testid={testId} {...props} />;
    };
  }

  return {
    ArrowUp: makeIcon('icon-arrow-up', arrowUpRenderSpy),
    Square: makeIcon('icon-square'),
    Loader2: makeIcon('icon-loader'),
    Plus: makeIcon('icon-plus'),
    Mic: makeIcon('icon-mic'),
  };
});

vi.mock('@/hooks/use-voice-recording', () => ({
  useVoiceRecording: () => ({
    state: 'idle',
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    isSupported: false,
    analyser: null,
    recordingStartTime: null,
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('PromptInput context indicator', () => {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onCompact = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPrompt(contextUsedPercent: number | null) {
    return render(
      <PromptInput
        value="hello"
        onChange={onChange}
        onSubmit={onSubmit}
        enableVoiceRecording={false}
        contextUsedPercent={contextUsedPercent}
        onCompact={onCompact}
      />
    );
  }

  it('hides the context indicator below 50%', () => {
    renderPrompt(49);
    expect(screen.queryByLabelText(/context used/i)).not.toBeInTheDocument();
  });

  it('shows the context indicator at 50% and above', () => {
    renderPrompt(50);
    expect(screen.getByLabelText(/50% context used/i)).toBeInTheDocument();
  });

  it('hides the context indicator when contextUsedPercent is null', () => {
    renderPrompt(null);
    expect(screen.queryByLabelText(/context used/i)).not.toBeInTheDocument();
  });

  it('does not re-render the send icon when only context usage changes', () => {
    const { rerender } = renderPrompt(55);
    const initialArrowRenderCount = arrowUpRenderSpy.mock.calls.length;

    rerender(
      <PromptInput
        value="hello"
        onChange={onChange}
        onSubmit={onSubmit}
        enableVoiceRecording={false}
        contextUsedPercent={60}
        onCompact={onCompact}
      />
    );

    expect(arrowUpRenderSpy.mock.calls.length).toBe(initialArrowRenderCount);
  });
});
