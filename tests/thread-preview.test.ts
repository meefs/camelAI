import { describe, expect, it } from 'vitest';
import {
  normalizeThreadCompletionSummary,
  normalizeThreadPreviewUserMessage,
  normalizeThreadUserMessageText,
  truncateThreadPreviewText,
} from '@/lib/thread-preview';
import { appendAttachmentReferences } from '@/lib/chat-attachment-refs';

describe('normalizeThreadPreviewUserMessage', () => {
  it('strips author prefixes with name and email', () => {
    const content = '[Illiana Reed (illiana@example.com)]: Build me a dashboard';
    expect(normalizeThreadPreviewUserMessage(content)).toBe('Build me a dashboard');
  });

  it('strips simple author prefixes', () => {
    const content = '[illiana@example.com]: Build me a dashboard';
    expect(normalizeThreadPreviewUserMessage(content)).toBe('Build me a dashboard');
  });

  it('strips camelai system message tags', () => {
    const content = '<camelai system message>hidden</camelai system message>\n\nHello there';
    expect(normalizeThreadPreviewUserMessage(content)).toBe('Hello there');
  });

  it('strips connection mention annotations', () => {
    const content = 'Hello @camel ⟦ref: other "Camel" id=conn_123⟧';
    expect(normalizeThreadPreviewUserMessage(content)).toBe('Hello @camel');
  });

  it('strips upload metadata annotations from previews', () => {
    const content = appendAttachmentReferences('Use this transcript', [
      {
        path: 'uploads/planning-chat-transcript.md',
        kind: 'generated_transcript',
        sourceThreadId: 'thread_source',
      },
    ]);

    expect(normalizeThreadPreviewUserMessage(content)).toBe(
      'Use this transcript\n\n(user uploaded file to uploads/planning-chat-transcript.md)',
    );
  });

  it('returns null for system-only content', () => {
    const content = '<camelai system message>hidden</camelai system message>';
    expect(normalizeThreadPreviewUserMessage(content)).toBeNull();
  });

  it('truncates to 500 characters', () => {
    const content = 'a'.repeat(800);
    expect(normalizeThreadPreviewUserMessage(content)?.length).toBe(500);
  });
});

describe('normalizeThreadUserMessageText', () => {
  it('normalizes user-authored text without truncating it', () => {
    const content = `[Illiana Reed (illiana@example.com)]: <camelai system message>hidden</camelai system message>\n\n${'a'.repeat(800)}`;
    expect(normalizeThreadUserMessageText(content)).toBe('a'.repeat(800));
  });

  it('does not retain upload metadata annotations in metadata source text', () => {
    const content = appendAttachmentReferences('', [
      {
        path: 'uploads/planning-chat-transcript.md',
        kind: 'generated_transcript',
        sourceThreadId: 'thread_source',
      },
    ]);

    expect(normalizeThreadUserMessageText(content)).toBe(
      '(user uploaded file to uploads/planning-chat-transcript.md)',
    );
  });
});

describe('truncateThreadPreviewText', () => {
  it('truncates preview text to the requested limit', () => {
    expect(truncateThreadPreviewText('a'.repeat(800), 300)).toBe('a'.repeat(300));
  });

  it('returns null for blank text', () => {
    expect(truncateThreadPreviewText('  \n\t  ')).toBeNull();
  });
});

describe('normalizeThreadCompletionSummary', () => {
  it('collapses whitespace and removes simple operational wrappers', () => {
    expect(
      normalizeThreadCompletionSummary('Final answer:\n\nFound the root cause.'),
    ).toBe('Found the root cause.');
  });

  it('returns null for blank summaries', () => {
    expect(normalizeThreadCompletionSummary('  \n\t  ')).toBeNull();
  });

  it('truncates summaries to 240 characters', () => {
    expect(normalizeThreadCompletionSummary('a'.repeat(400))?.length).toBe(240);
  });
});
