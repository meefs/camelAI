import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@/types';
import { contentToString } from '@/components/message-bubble';

describe('contentToString', () => {
  it('preserves literal teammate XML in plain string content', () => {
    const content = '<teammate-message teammate_id="alice">literal example</teammate-message>';
    expect(contentToString(content)).toBe(content);
  });

  it('strips system message tags but keeps literal teammate XML', () => {
    const content = [
      '<camelai system message>internal</camelai system message>',
      '<teammate-message teammate_id="alice">literal example</teammate-message>',
    ].join('\n');
    expect(contentToString(content)).toBe('<teammate-message teammate_id="alice">literal example</teammate-message>');
  });

  it('strips connection mention annotations from plain string content', () => {
    const content = 'Check @camel ⟦ref: other "Camel" id=conn_123⟧ please';
    expect(contentToString(content)).toBe('Check @camel please');
  });

  it('preserves literal teammate XML in text blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: 'Use this snippet: <teammate-message teammate_id="alice">example</teammate-message>',
      },
    ];
    expect(contentToString(blocks)).toBe(
      'Use this snippet: <teammate-message teammate_id="alice">example</teammate-message>'
    );
  });

  it('strips connection mention annotations from text blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: 'Check @camel ⟦ref: other "Camel" id=conn_123⟧ please',
      },
    ];
    expect(contentToString(blocks)).toBe('Check @camel please');
  });

  it('serializes parsed teammate message blocks as teammate updates', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'teammate_message',
        teammateId: 'alice',
        content: 'I fixed the failing test.',
      },
    ];
    expect(contentToString(blocks)).toBe('[Update from alice]\nI fixed the failing test.');
  });

  it('serializes task notification blocks as task status lines', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'task_notification',
        taskId: 'task_123',
        outputFile: '/mnt/user-outputs/task_123.md',
        status: 'completed',
        summary: 'Report generation finished.',
      },
    ];
    expect(contentToString(blocks)).toBe('[Task completed] Report generation finished.');
  });

  it('serializes redacted thinking blocks explicitly', () => {
    const blocks: ContentBlock[] = [
      { type: 'redacted_thinking' },
    ];
    expect(contentToString(blocks)).toBe('[Thinking redacted]');
  });
});
