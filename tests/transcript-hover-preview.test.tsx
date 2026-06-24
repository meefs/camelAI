import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptHoverPreview } from '@/components/welcome-screen/transcript-hover-preview';

describe('TranscriptHoverPreview', () => {
  it('renders upload references as muted user annotations without stripping paths', () => {
    render(
      <TranscriptHoverPreview
        state={{
          status: 'ready',
          transcript: {
            threadId: 'thread_1',
            title: 'Planning chat',
            turns: [
              {
                user: 'Build it\n\n(user uploaded file to uploads/report.md)',
                assistantFinal: 'Done',
                omittedCount: 1,
              },
            ],
          },
        }}
      />,
    );

    const message = screen.getByText('Build it');
    const uploadRef = screen.getByText('(user uploaded file to uploads/report.md)');

    expect(message).toHaveClass('text-sm');
    expect(uploadRef).toHaveClass('text-xs', 'italic', 'text-muted-foreground');
  });

  it('falls back to raw malformed upload markers instead of throwing', () => {
    expect(() =>
      render(
        <TranscriptHoverPreview
          state={{
            status: 'ready',
            transcript: {
              threadId: 'thread_1',
              title: 'Planning chat',
              turns: [
                {
                  user: 'Check this\n\n(user uploaded file to uploads/../foo.txt)',
                  assistantFinal: 'Done',
                  omittedCount: 0,
                },
              ],
            },
          }}
        />,
      ),
    ).not.toThrow();

    expect(
      screen.getByText('(user uploaded file to uploads/../foo.txt)'),
    ).toHaveClass('text-xs', 'italic', 'text-muted-foreground');
  });
});
