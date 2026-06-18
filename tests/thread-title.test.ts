import { describe, expect, it } from 'vitest';
import {
  buildAppThreadFallbackTitle,
  getInitialChatGroupNameFromThreadTitle,
  getThreadTitleSourceMessage,
  getThreadUserMessageSources,
  isPlaceholderThreadTitle,
  sanitizeGeneratedThreadTitle,
} from '@/lib/thread-title';

describe('thread title helpers', () => {
  it('builds the app fallback title from the script name', () => {
    expect(buildAppThreadFallbackTitle('my-todo-app')).toBe('Working on my-todo-app');
  });

  it('detects placeholder titles', () => {
    expect(isPlaceholderThreadTitle('New Chat')).toBe(true);
    expect(isPlaceholderThreadTitle('Working on my-todo-app')).toBe(true);
    expect(isPlaceholderThreadTitle('Fix the app auth flow')).toBe(false);
  });

  it('derives initial chat group names only from real thread titles', () => {
    expect(getInitialChatGroupNameFromThreadTitle('Fix the app auth flow')).toBe(
      'Fix the app auth flow',
    );
    expect(getInitialChatGroupNameFromThreadTitle('New Chat')).toBeUndefined();
    expect(
      getInitialChatGroupNameFromThreadTitle('Working on my-todo-app'),
    ).toBeUndefined();
    expect(getInitialChatGroupNameFromThreadTitle('')).toBeUndefined();
  });

  it('extracts a real user message from attributed content', () => {
    const content = '<camelai system message>Research the app first.</camelai system message>\n\n[Jane Doe (jane@example.com)]: Fix the broken login form';

    expect(getThreadTitleSourceMessage(content)).toBe('Fix the broken login form');
  });

  it('separates full metadata source text from bounded title source text', () => {
    const longMessage = `Build the dashboard ${'x'.repeat(700)}`;
    const content = `[Jane Doe (jane@example.com)]: ${longMessage}`;

    expect(getThreadUserMessageSources(content)).toEqual({
      metadataSourceMessage: longMessage,
      titleSourceMessage: longMessage.slice(0, 500),
    });
    expect(getThreadTitleSourceMessage(content)).toBe(longMessage.slice(0, 500));
  });

  it('can normalize generated titles to title case', () => {
    expect(sanitizeGeneratedThreadTitle('test delete flow', { titleCase: true })).toBe(
      'Test Delete Flow',
    );
    expect(sanitizeGeneratedThreadTitle('api oauth setup', { titleCase: true })).toBe(
      'API OAuth Setup',
    );
  });

  it('ignores system-only content and slash commands', () => {
    expect(
      getThreadTitleSourceMessage(
        '<camelai system message>Research the app first.</camelai system message>'
      )
    ).toBeNull();
    expect(getThreadTitleSourceMessage('[Jane Doe]: /compact')).toBeNull();
    expect(
      getThreadUserMessageSources(
        '<camelai system message>Research the app first.</camelai system message>'
      )
    ).toBeNull();
    expect(getThreadUserMessageSources('[Jane Doe]: /compact')).toBeNull();
  });
});
