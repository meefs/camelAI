import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@/types';
import { parseSlashCommand } from '@/components/message-bubble';

describe('parseSlashCommand', () => {
  it('parses wrapped slash commands', () => {
    expect(parseSlashCommand('<command-name>/compact</command-name>')).toBe('/compact');
  });

  it('parses bare slash commands in plain string content', () => {
    expect(parseSlashCommand('/compact')).toBe('/compact');
  });

  it('parses bare slash commands after author attribution', () => {
    expect(parseSlashCommand('[Illiana Reed (admin@example.com)]: /compact')).toBe('/compact');
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
