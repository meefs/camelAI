import { describe, expect, it } from 'vitest';
import { normalizeThreadPreviewUserMessage } from '@/lib/thread-preview';

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
