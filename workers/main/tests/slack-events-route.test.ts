import { describe, it, expect, vi } from 'vitest';
import { handleSlackEvents } from '../src/routes/integrations.js';
import type { SlackEventQueueMessage } from '../src/slack-types.js';

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<KVNamespaceListResult> {
      return { keys: [], list_complete: true, cursor: '' };
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

async function createSlackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const base = `v0:${timestamp}:${body}`;
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(base));
  const digest = Array.from(new Uint8Array(signed))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${digest}`;
}

async function postSlackEvent(
  payload: unknown,
  env: {
    APP_KV: KVNamespace;
    SLACK_SIGNING_SECRET: string;
    SLACK_EVENTS_QUEUE?: Queue<SlackEventQueueMessage>;
  },
  waitUntil: (promise: Promise<unknown>) => void
): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await createSlackSignature(env.SLACK_SIGNING_SECRET, timestamp, body);

  const req = new Request('https://camelai.dev/api/integrations/slack/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });

  return handleSlackEvents({
    req,
    env: env as never,
    ctx: { waitUntil } as never,
    url: new URL(req.url),
    match: [] as unknown as RegExpMatchArray,
  });
}

describe('handleSlackEvents', () => {
  it('enqueues callback events when SLACK_EVENTS_QUEUE is configured', async () => {
    const kv = createMockKV();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = { send } as unknown as Queue<SlackEventQueueMessage>;
    const waitUntil = vi.fn();
    const env = {
      APP_KV: kv,
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      SLACK_EVENTS_QUEUE: queue,
    };

    const payload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvQueue',
      event: {
        type: 'app_mention',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U123',
        ts: '1700000000.000099',
        text: '<@B123> hello',
      },
    };

    const response = await postSlackEvent(payload, env, waitUntil);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      payload,
      received_at: expect.any(Number),
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('dedupes app_mention and message events for the same Slack message', async () => {
    const kv = createMockKV();
    const waitUntil = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      APP_KV: kv,
      SLACK_SIGNING_SECRET: 'test-signing-secret',
    };

    const sharedEvent = {
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      ts: '1700000000.000100',
      text: '<@B123> hello',
    };

    const mentionPayload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvA',
      event: {
        ...sharedEvent,
        type: 'app_mention',
      },
    };

    const messagePayload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvB',
      event: {
        ...sharedEvent,
        type: 'message',
      },
    };

    try {
      const first = await postSlackEvent(mentionPayload, env, waitUntil);
      const second = await postSlackEvent(messagePayload, env, waitUntil);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(await kv.get('slack_message:T123:C123:U123:1700000000.000100')).toBe('1');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
