import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { PromptInput } from '@/components/prompt-input';
import type { Integration } from '@/types';

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

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const connection: Integration = {
  id: 'integration-1',
  integration_type: 'postgres',
  name: 'Customers DB',
  category: 'databases',
  auth_method: 'api_key',
  config: {},
  created_by: 'user-1',
  created_at: 1,
  updated_at: 1,
  has_credentials: true,
};

function ControlledPromptInput({ mentionMenuSide }: { mentionMenuSide?: 'top' | 'bottom' }) {
  const [value, setValue] = useState('');

  return (
    <PromptInput
      value={value}
      onChange={setValue}
      onSubmit={vi.fn()}
      enableVoiceRecording={false}
      mentionableConnections={[connection]}
      mentionMenuSide={mentionMenuSide}
    />
  );
}

describe('PromptInput mentions', () => {
  it('can render the mention menu below the composer', async () => {
    const user = userEvent.setup();
    render(<ControlledPromptInput mentionMenuSide="bottom" />);

    await user.type(screen.getByRole('textbox'), '@');

    expect(await screen.findByText('Customers DB')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('[data-slot="popover-content"]')).toHaveAttribute(
        'data-side',
        'bottom',
      );
    });
  });
});
