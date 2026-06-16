import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '@/types';
import { mergeTaskNotifications } from '@/lib/streaming';

function makeTaskNotification({
  taskId,
  outputFile,
  status,
  summary,
}: {
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<output-file>${outputFile}</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    '</task-notification>',
  ].join('\n');
}

describe('mergeTaskNotifications', () => {
  it('merges user task notification into preceding assistant message', () => {
    const messages: Message[] = [
      {
        id: 'assistant-1',
        thread_id: 'thread-1',
        role: 'assistant',
        content: 'Working on your request...',
        created_at: 1000,
      },
      {
        id: 'user-task-1',
        thread_id: 'thread-1',
        role: 'user',
        content: makeTaskNotification({
          taskId: 'task_1',
          outputFile: 'outputs/task_1.md',
          status: 'completed',
          summary: 'Task finished successfully.',
        }),
        created_at: 1100,
      },
    ];

    const merged = mergeTaskNotifications(messages);
    expect(merged).toHaveLength(1);

    const assistant = merged[0];
    expect(assistant.role).toBe('assistant');
    expect(Array.isArray(assistant.content)).toBe(true);
    const blocks = assistant.content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Working on your request...' });
    expect(blocks[1]).toEqual({
      type: 'task_notification',
      taskId: 'task_1',
      outputFile: 'outputs/task_1.md',
      status: 'completed',
      summary: 'Task finished successfully.',
    });
  });

  it('merges meta task notification into preceding assistant message', () => {
    const notificationText = makeTaskNotification({
      taskId: 'task_2',
      outputFile: 'outputs/task_2.md',
      status: 'failed',
      summary: 'Task failed to complete.',
    });

    const messages: Message[] = [
      {
        id: 'assistant-2',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Trying again.' },
          { type: 'tool_use', id: 'tool_123', name: 'Task', input: { prompt: 'Try again' } },
        ],
        created_at: 1200,
      },
      {
        id: 'meta-task-2',
        thread_id: 'thread-1',
        role: 'user',
        content: [{ type: 'text', text: notificationText }],
        created_at: 1300,
        isMeta: true,
        sourceToolUseID: 'tool_123',
      },
    ];

    const merged = mergeTaskNotifications(messages);
    expect(merged).toHaveLength(1);
    expect(Array.isArray(merged[0].content)).toBe(true);
    const blocks = merged[0].content as ContentBlock[];
    expect(blocks[2]).toEqual({
      type: 'task_notification',
      taskId: 'task_2',
      outputFile: 'outputs/task_2.md',
      status: 'failed',
      summary: 'Task failed to complete.',
    });
  });

  it('uses sourceToolUseID to target the correct assistant turn when newer assistant messages exist', () => {
    const notificationText = makeTaskNotification({
      taskId: 'task_old',
      outputFile: 'outputs/task_old.md',
      status: 'completed',
      summary: 'Older task finished.',
    });

    const messages: Message[] = [
      {
        id: 'assistant-old',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Starting old task.' },
          { type: 'tool_use', id: 'tool_old', name: 'Task', input: { prompt: 'Old task' } },
        ],
        created_at: 1000,
      },
      {
        id: 'assistant-new',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Starting new task.' },
          { type: 'tool_use', id: 'tool_new', name: 'Task', input: { prompt: 'New task' } },
        ],
        created_at: 1100,
      },
      {
        id: 'meta-task-old',
        thread_id: 'thread-1',
        role: 'user',
        content: [{ type: 'text', text: notificationText }],
        created_at: 1200,
        isMeta: true,
        sourceToolUseID: 'tool_old',
      },
    ];

    const merged = mergeTaskNotifications(messages);
    expect(merged).toHaveLength(2);

    expect(Array.isArray(merged[0].content)).toBe(true);
    const oldBlocks = merged[0].content as ContentBlock[];
    expect(oldBlocks[2]).toEqual({
      type: 'task_notification',
      taskId: 'task_old',
      outputFile: 'outputs/task_old.md',
      status: 'completed',
      summary: 'Older task finished.',
    });

    expect(Array.isArray(merged[1].content)).toBe(true);
    const newBlocks = merged[1].content as ContentBlock[];
    expect(newBlocks).toHaveLength(2);
    expect(newBlocks.some(block => block.type === 'task_notification')).toBe(false);
  });

  it('attaches notification to a later assistant turn when source tool_use appears after the notification', () => {
    const notificationText = makeTaskNotification({
      taskId: 'task_future',
      outputFile: 'outputs/task_future.md',
      status: 'completed',
      summary: 'Future task finished.',
    });

    const messages: Message[] = [
      {
        id: 'assistant-prev',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Earlier assistant turn.' },
          { type: 'tool_use', id: 'tool_prev', name: 'Task', input: { prompt: 'Earlier task' } },
        ],
        created_at: 1000,
      },
      {
        id: 'meta-task-future',
        thread_id: 'thread-1',
        role: 'user',
        content: [{ type: 'text', text: notificationText }],
        created_at: 1100,
        isMeta: true,
        sourceToolUseID: 'tool_future',
      },
      {
        id: 'assistant-future',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Later assistant turn.' },
          { type: 'tool_use', id: 'tool_future', name: 'Task', input: { prompt: 'Later task' } },
        ],
        created_at: 1200,
      },
    ];

    const merged = mergeTaskNotifications(messages);
    expect(merged).toHaveLength(2);

    expect(Array.isArray(merged[0].content)).toBe(true);
    const firstAssistantBlocks = merged[0].content as ContentBlock[];
    expect(firstAssistantBlocks.some(block => block.type === 'task_notification')).toBe(false);

    expect(Array.isArray(merged[1].content)).toBe(true);
    const secondAssistantBlocks = merged[1].content as ContentBlock[];
    expect(secondAssistantBlocks[2]).toEqual({
      type: 'task_notification',
      taskId: 'task_future',
      outputFile: 'outputs/task_future.md',
      status: 'completed',
      summary: 'Future task finished.',
    });
  });

  it('synthesizes an assistant message when no preceding assistant exists', () => {
    const messages: Message[] = [
      {
        id: 'user-task-3',
        thread_id: 'thread-1',
        role: 'user',
        content: makeTaskNotification({
          taskId: 'task_3',
          outputFile: 'outputs/task_3.md',
          status: 'success',
          summary: 'Done.',
        }),
        created_at: 1400,
      },
    ];

    const merged = mergeTaskNotifications(messages);
    expect(merged).toHaveLength(1);
    expect(merged[0].role).toBe('assistant');
    expect(merged[0].thread_id).toBe('thread-1');
    expect(merged[0].created_at).toBe(1400);
    expect(merged[0].id).toBe('task_notification_user-task-3');
    expect(merged[0].content).toEqual([
      {
        type: 'task_notification',
        taskId: 'task_3',
        outputFile: 'outputs/task_3.md',
        status: 'success',
        summary: 'Done.',
      },
    ]);
  });

  it('leaves regular user messages unchanged', () => {
    const messages: Message[] = [
      {
        id: 'user-plain',
        thread_id: 'thread-1',
        role: 'user',
        content: 'hello world',
        created_at: 1500,
      },
    ];

    const merged = mergeTaskNotifications(messages);
    expect(merged).toBe(messages);
  });
});
