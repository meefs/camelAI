import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@/types';
import { parseSlashCommand } from '@/components/message-bubble';
import {
  parseMessageAuthor,
  resolveMessageAuthorDisplayName,
} from '@/lib/message-author';

describe('parseSlashCommand', () => {
  it('parses wrapped slash commands', () => {
    expect(parseSlashCommand('<command-name>/compact</command-name>')).toBe('/compact');
  });

  it('parses bare slash commands in plain string content', () => {
    expect(parseSlashCommand('/compact')).toBe('/compact');
  });

  it('parses bare slash commands after author attribution', () => {
    expect(parseSlashCommand('[Example User (member@example.com)]: /compact')).toBe('/compact');
  });

  it('parses bare slash commands from content blocks', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: '/compact' }];
    expect(parseSlashCommand(blocks)).toBe('/compact');
  });

  it('strips system message tags before parsing', () => {
    const content = '<camelai system message>hidden</camelai system message>\n\n/compact';
    expect(parseSlashCommand(content)).toBe('/compact');
  });

  it('does not parse slash commands with trailing arguments', () => {
    expect(parseSlashCommand('/compact now')).toBeNull();
  });

  it('does not parse slash-like text inside regular prose', () => {
    expect(parseSlashCommand('Please run /compact for me')).toBeNull();
  });
});

describe('parseMessageAuthor', () => {
  it('extracts the source token from attributed channel messages', () => {
    const parsed = parseMessageAuthor(
      '[slack message from Jane Reed (jane@example.com)]: Please review this',
    );

    expect(parsed.source).toBe('slack');
    expect(parsed.author?.displayName).toBe('Jane Reed');
    expect(parsed.author?.email).toBe('jane@example.com');
    expect(parsed.content).toBe('Please review this');
  });

  it('extracts email source attribution without a named author', () => {
    const parsed = parseMessageAuthor('[email message from customer@example.com]: Refund?');

    expect(parsed.source).toBe('email');
    expect(parsed.author?.displayName).toBe('customer@example.com');
    expect(parsed.content).toBe('Refund?');
  });

  it('leaves legacy author prefixes source-less', () => {
    expect(parseMessageAuthor('[Jane Reed (jane@example.com)]: Hello').source).toBeNull();
    expect(parseMessageAuthor('[Jane Reed]: Hello').source).toBeNull();
    expect(parseMessageAuthor('Hello').author).toBeNull();
  });

  it('strips a source-only prefix without fabricating a person', () => {
    const parsed = parseMessageAuthor('[email message]: Refund?');

    expect(parsed).toEqual({
      author: null,
      source: 'email',
      content: 'Refund?',
    });
    expect(parseMessageAuthor('[email message from ]: Refund?')).toEqual({
      author: null,
      source: 'email',
      content: 'Refund?',
    });
  });

  it('strips prefixes and system tags from content blocks even without an author', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'noop', input: {} },
      {
        type: 'text',
        text: '<camelai system message>hidden</camelai system message>\n[email message]: Hello',
      },
    ];
    const parsed = parseMessageAuthor(blocks);

    expect(parsed.author).toBeNull();
    expect(parsed.source).toBe('email');
    expect(parsed.content).toEqual([
      blocks[0],
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('preserves content that has no prefix or system tag', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello' }];
    expect(parseMessageAuthor('Hello')).toEqual({
      author: null,
      source: null,
      content: 'Hello',
    });
    expect(parseMessageAuthor(blocks).content).toBe(blocks);
  });

  it('preserves whitespace and array identity for unattributed blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '    indented code\n' },
    ];
    const parsed = parseMessageAuthor(blocks);

    expect(parsed.content).toBe(blocks);
    expect(parsed.content[0]).toBe(blocks[0]);
    expect((parsed.content[0] as { text: string }).text).toBe(
      '    indented code\n',
    );
    expect(parseMessageAuthor('  untouched text\n').content).toBe(
      '  untouched text\n',
    );
  });
});

describe('resolveMessageAuthorDisplayName', () => {
  it('prefers a trimmed name and falls back to a trimmed email', () => {
    expect(resolveMessageAuthorDisplayName('  Jane Reed ', 'jane@example.com')).toBe('Jane Reed');
    expect(resolveMessageAuthorDisplayName(' ', ' jane@example.com ')).toBe('jane@example.com');
  });

  it('returns null instead of inventing an author', () => {
    expect(resolveMessageAuthorDisplayName(' ', null)).toBeNull();
    expect(resolveMessageAuthorDisplayName(undefined, '')).toBeNull();
  });
});
