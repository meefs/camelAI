import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('@/lib/wait-until', () => ({
  waitUntil: vi.fn(),
}));

const { generateHelpSubject } = await import('@/routes/api/help');

describe('generateHelpSubject', () => {
  it('generates a trimmed subject from description', async () => {
    const run = vi.fn().mockResolvedValue({
      response: '  Agent freezes on large file upload  ',
    });

    const subject = await generateHelpSubject(
      { AI: { run } },
      'The agent freezes when I upload files larger than 50MB.',
      'Bug report'
    );

    expect(subject).toBe('Agent freezes on large file upload');
    expect(run).toHaveBeenCalledWith(
      '@cf/google/gemma-3-12b-it',
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content:
              'Summarize the following support request into a short subject line (under 80 characters). Respond with only the subject line, no quotes or extra punctuation.',
          }),
        ]),
        temperature: 0.3,
        max_tokens: 30,
      })
    );
  });

  it('truncates AI responses to 100 characters', async () => {
    const longSubject = 'a'.repeat(140);
    const subject = await generateHelpSubject(
      {
        AI: {
          run: vi.fn().mockResolvedValue({
            response: longSubject,
          }),
        },
      },
      'Description',
      'Question'
    );

    expect(subject).toHaveLength(100);
    expect(subject).toBe('a'.repeat(100));
  });

  it('falls back to category label when AI returns empty', async () => {
    const subject = await generateHelpSubject(
      {
        AI: {
          run: vi.fn().mockResolvedValue({
            response: '   ',
          }),
        },
      },
      'Description',
      'Feature request'
    );

    expect(subject).toBe('Feature request');
  });

  it('falls back to category label when AI throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const subject = await generateHelpSubject(
      {
        AI: {
          run: vi.fn().mockRejectedValue(new Error('AI unavailable')),
        },
      },
      'Description',
      'Bug report'
    );

    expect(subject).toBe('Bug report');
    errorSpy.mockRestore();
  });
});
