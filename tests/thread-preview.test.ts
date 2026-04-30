import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  getFirstThreadPreviewUserMessage,
  normalizeThreadPreviewUserMessage,
} from '@/lib/thread-preview';

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

  it('returns null for system-only content', () => {
    const content = '<camelai system message>hidden</camelai system message>';
    expect(normalizeThreadPreviewUserMessage(content)).toBeNull();
  });

  it('truncates to 500 characters', () => {
    const content = 'a'.repeat(800);
    expect(normalizeThreadPreviewUserMessage(content)?.length).toBe(500);
  });
});

describe('getFirstThreadPreviewUserMessage', () => {
  it('skips meta and compact-summary messages', () => {
    const messages: Message[] = [
      {
        id: '1',
        thread_id: 't1',
        role: 'user',
        content: '[A (a@example.com)]: should not use',
        created_at: 1,
        isMeta: true,
      },
      {
        id: '2',
        thread_id: 't1',
        role: 'user',
        content: '[A (a@example.com)]: should not use',
        created_at: 2,
        isCompactSummary: true,
      },
      {
        id: '3',
        thread_id: 't1',
        role: 'assistant',
        content: 'assistant content',
        created_at: 3,
      },
      {
        id: '4',
        thread_id: 't1',
        role: 'user',
        content: '[A (a@example.com)]: use this',
        created_at: 4,
      },
    ];

    expect(getFirstThreadPreviewUserMessage(messages)).toBe('use this');
  });

  it('returns null when no usable user message exists', () => {
    const messages: Message[] = [
      {
        id: '1',
        thread_id: 't1',
        role: 'assistant',
        content: 'assistant content',
        created_at: 1,
      },
      {
        id: '2',
        thread_id: 't1',
        role: 'user',
        content: '<camelai system message>hidden</camelai system message>',
        created_at: 2,
      },
    ];

    expect(getFirstThreadPreviewUserMessage(messages)).toBeNull();
  });
});
