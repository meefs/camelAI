import type { Env } from './types.js';
import type { SlackEventQueueMessage } from './slack-types.js';
import { processSlackEventCallback } from './routes/integrations.js';

const MAX_SLACK_EVENT_RETRIES = 5;

function isValidSlackQueueMessage(body: unknown): body is SlackEventQueueMessage {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as Partial<SlackEventQueueMessage>;
  if (!candidate.payload || typeof candidate.payload !== 'object') return false;
  return true;
}

export async function handleSlackEventsQueue(
  batch: MessageBatch<SlackEventQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const attempt = message.attempts ?? 1;

    if (!isValidSlackQueueMessage(message.body)) {
      console.warn('[slack-events-queue] invalid payload', { body: message.body });
      message.ack();
      continue;
    }

    try {
      await processSlackEventCallback(env, message.body.payload);
      message.ack();
    } catch (error) {
      console.error('[slack-events-queue] failed to process message', {
        error: String(error),
        attempt,
      });

      if (attempt >= MAX_SLACK_EVENT_RETRIES) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
