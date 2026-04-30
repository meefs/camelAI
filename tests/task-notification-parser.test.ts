import { describe, expect, it } from 'vitest';
import { parseTaskNotification, parseTaskNotificationFromContent } from '@/lib/task-notification';
import type { ContentBlock } from '@/types';

describe('parseTaskNotification', () => {
  it('parses valid task notification payload with trailing output-file instruction', () => {
    const raw = [
      '<camelai system message>internal metadata</camelai system message>',
      '<task-notification>',
      '<task-id>task_123</task-id>',
      '<output-file>/mnt/user-outputs/task_123.md</output-file>',
      '<status>Completed</status>',
      '<summary>Report generation finished.</summary>',
      '</task-notification>',
      'Read the output file to retrieve the result: /mnt/user-outputs/task_123.md',
    ].join('\n');

    expect(parseTaskNotification(raw)).toEqual({
      taskId: 'task_123',
      outputFile: '/mnt/user-outputs/task_123.md',
      status: 'completed',
      summary: 'Report generation finished.',
    });
  });

  it('ignores connection mention annotations outside the task payload', () => {
    const raw = [
      '<task-notification>',
      '<task-id>task_123</task-id>',
      '<output-file>/mnt/user-outputs/task_123.md</output-file>',
      '<status>Completed</status>',
      '<summary>Report generation finished for @camel.</summary>',
      '</task-notification>',
      ' ⟦ref: other "Camel" id=conn_123⟧',
    ].join('\n');

    expect(parseTaskNotification(raw)).toEqual({
      taskId: 'task_123',
      outputFile: '/mnt/user-outputs/task_123.md',
      status: 'completed',
      summary: 'Report generation finished for @camel.',
    });
  });

  it('rejects payloads with unrelated wrapper text', () => {
    const raw = [
      'unexpected wrapper',
      '<task-notification>',
      '<task-id>task_123</task-id>',
      '<output-file>/mnt/user-outputs/task_123.md</output-file>',
      '<status>completed</status>',
      '<summary>done</summary>',
      '</task-notification>',
    ].join('\n');

    expect(parseTaskNotification(raw)).toBeNull();
  });

  it('handles multiline summary payload from content blocks', () => {
    const content: ContentBlock[] = [
      {
        type: 'text',
        text: [
          '<task-notification>',
          '<summary>First line',
          'Second line</summary>',
          '<task-id>task_456</task-id>',
          '<status>SUCCESS</status>',
          '<output-file>/mnt/user-outputs/task_456.md</output-file>',
          '</task-notification>',
        ].join('\n'),
      },
    ];

    expect(parseTaskNotificationFromContent(content)).toEqual({
      taskId: 'task_456',
      outputFile: '/mnt/user-outputs/task_456.md',
      status: 'success',
      summary: 'First line\nSecond line',
    });
  });
});
