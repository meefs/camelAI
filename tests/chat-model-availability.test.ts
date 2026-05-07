import { describe, expect, it } from 'vitest';
import { isNoModelsBlockingNewThread } from '@/lib/chat-model-availability';

describe('chat model availability guards', () => {
  it('blocks new thread flows when no models are available', () => {
    expect(
      isNoModelsBlockingNewThread(
        null,
        'No models are available. Ask an admin to add a model.',
      ),
    ).toBe(true);
  });

  it('does not block existing threads when the picker is empty', () => {
    expect(
      isNoModelsBlockingNewThread(
        'thread_123',
        'No models are available. Ask an admin to add a model.',
      ),
    ).toBe(false);
  });
});
