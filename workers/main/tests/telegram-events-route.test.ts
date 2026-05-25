import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrgBanIdKey, type BanRecord } from '../src/ban-list.js';
import { handleTelegramWebhook } from '../src/routes/integrations.js';
import {
  type TelegramChatBinding,
  type TelegramSetupRecord,
} from '../../../src/lib/telegram-channel';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockKV(initial?: Record<string, string>): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial || {}));

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
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function createTelegramRegistryStub(args: {
  setup?: TelegramSetupRecord | null;
  binding?: TelegramChatBinding | null;
} = {}) {
  const stub = {
    consumeSetupToken: vi.fn(async () => args.setup ?? null),
    bindChat: vi.fn(async () => undefined),
    getChatBinding: vi.fn(async () => args.binding ?? null),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  return { namespace, stub };
}

function telegramRequest(body: unknown, secret = 'telegram-secret'): Request {
  return new Request('https://camelai.dev/api/integrations/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  });
}

describe('handleTelegramWebhook', () => {
  it('binds a Telegram chat from a setup deep link token', async () => {
    const setup: TelegramSetupRecord = {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
      userId: 'user-1',
    };
    const kv = createMockKV() as KVNamespace & { _store: Map<string, string> };
    const registry = createTelegramRegistryStub({ setup });
    const updateIntegration = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.telegram.org/botbot-token/sendMessage');
      return Response.json({ ok: true, result: { message_id: 10 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleTelegramWebhook({
      req: telegramRequest({
        update_id: 1,
        message: {
          message_id: 100,
          text: '/start setup-token',
          chat: { id: 12345, type: 'private', first_name: 'Ada' },
          from: { id: 777, first_name: 'Ada' },
        },
      }),
      env: {
        APP_KV: kv,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
        TELEGRAM_REGISTRY: registry.namespace,
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ status: 'pending', setup_token: 'setup-token' }),
            })),
            updateIntegration,
          })),
        },
      } as never,
      ctx: {} as never,
      url: new URL('https://camelai.dev/api/integrations/telegram/webhook'),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(updateIntegration).toHaveBeenCalledWith(
      'telegram-int',
      {
        config: expect.stringContaining('"status":"active"'),
      },
      'user-1',
    );
    const updatedConfig = JSON.parse(updateIntegration.mock.calls[0][1].config);
    expect(updatedConfig).toMatchObject({
      status: 'active',
      chat_id: '12345',
      chat_type: 'private',
      chat_title: 'Ada',
      connected_by_telegram_user_id: '777',
    });
    expect(updatedConfig.setup_token).toBeUndefined();
    expect(registry.stub.consumeSetupToken).toHaveBeenCalledWith('setup-token');
    expect(registry.stub.bindChat).toHaveBeenCalledWith('12345', {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enqueues connected Telegram text messages as channel messages', async () => {
    const binding: TelegramChatBinding = {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
    };
    const kv = createMockKV({
      'channel_thread:telegram:ws-1:telegram-int:12345': 'thread-1',
    }) as KVNamespace & { _store: Map<string, string> };
    const registry = createTelegramRegistryStub({ binding });
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const response = await handleTelegramWebhook({
      req: telegramRequest({
        update_id: 2,
        message: {
          message_id: 101,
          text: 'hello from Telegram',
          chat: { id: 12345, type: 'private', first_name: 'Ada' },
          from: { id: 777, first_name: 'Ada' },
        },
      }),
      env: {
        APP_KV: kv,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
        TELEGRAM_REGISTRY: registry.namespace,
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ status: 'active', chat_id: '12345' }),
            })),
          })),
        },
        ORG: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getThread: vi.fn(async () => ({ id: 'thread-1', title: 'Ada' })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never,
      ctx: {} as never,
      url: new URL('https://camelai.dev/api/integrations/telegram/webhook'),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(startInitialUserMessage).toHaveBeenCalledWith({
      threadId: 'thread-1',
      workspaceId: 'ws-1',
      orgId: 'org-1',
      userName: 'Ada',
      userEmail: null,
      message: expect.stringContaining('send_telegram_message'),
    });
    expect(startInitialUserMessage.mock.calls[0][0].message).toContain('hello from Telegram');
    expect(kv._store.get('channel_event:telegram:ws-1:12345:101')).toBe('done');
  });

  it('does not enqueue Telegram messages from stale chat bindings', async () => {
    const binding: TelegramChatBinding = {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
    };
    const kv = createMockKV();
    const registry = createTelegramRegistryStub({ binding });
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const response = await handleTelegramWebhook({
      req: telegramRequest({
        update_id: 5,
        message: {
          message_id: 104,
          text: 'old chat',
          chat: { id: 12345, type: 'private', first_name: 'Ada' },
          from: { id: 777, first_name: 'Ada' },
        },
      }),
      env: {
        APP_KV: kv,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
        TELEGRAM_REGISTRY: registry.namespace,
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ status: 'active', chat_id: '67890' }),
            })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never,
      ctx: {} as never,
      url: new URL('https://camelai.dev/api/integrations/telegram/webhook'),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(startInitialUserMessage).not.toHaveBeenCalled();
    expect(await kv.get('channel_event:telegram:ws-1:12345:104')).toBeNull();
  });

  it('does not enqueue Telegram messages for archived workspaces', async () => {
    const binding: TelegramChatBinding = {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
    };
    const kv = createMockKV();
    const registry = createTelegramRegistryStub({ binding });
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const response = await handleTelegramWebhook({
      req: telegramRequest({
        update_id: 6,
        message: {
          message_id: 105,
          text: 'archived chat',
          chat: { id: 12345, type: 'private', first_name: 'Ada' },
          from: { id: 777, first_name: 'Ada' },
        },
      }),
      env: {
        APP_KV: kv,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
        TELEGRAM_REGISTRY: registry.namespace,
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: true })),
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ status: 'active', chat_id: '12345' }),
            })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never,
      ctx: {} as never,
      url: new URL('https://camelai.dev/api/integrations/telegram/webhook'),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(startInitialUserMessage).not.toHaveBeenCalled();
    expect(await kv.get('channel_event:telegram:ws-1:12345:105')).toBeNull();
  });

  it('does not enqueue Telegram messages for banned orgs', async () => {
    const binding: TelegramChatBinding = {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
    };
    const banRecord: BanRecord = {
      scope: 'org',
      target_id: 'org-1',
      email: null,
      org_slug: null,
      reason: 'spam',
      created_at: Date.now(),
      created_by: 'admin',
      status: 'active',
      purge_status: 'completed',
      purge_job_id: null,
      purge_started_at: null,
      purge_completed_at: null,
      purge_error: null,
    };
    const kv = createMockKV({
      [getOrgBanIdKey('org-1')]: JSON.stringify(banRecord),
    });
    const registry = createTelegramRegistryStub({ binding });
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const response = await handleTelegramWebhook({
      req: telegramRequest({
        update_id: 4,
        message: {
          message_id: 103,
          text: 'hello from Telegram',
          chat: { id: 12345, type: 'private', first_name: 'Ada' },
          from: { id: 777, first_name: 'Ada' },
        },
      }),
      env: {
        APP_KV: kv,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
        TELEGRAM_REGISTRY: registry.namespace,
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ status: 'active', chat_id: '12345' }),
            })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never,
      ctx: {} as never,
      url: new URL('https://camelai.dev/api/integrations/telegram/webhook'),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(startInitialUserMessage).not.toHaveBeenCalled();
    expect(await kv.get('channel_event:telegram:ws-1:12345:103')).toBeNull();
  });

  it('uploads Telegram documents before enqueueing channel messages', async () => {
    const binding: TelegramChatBinding = {
      workspaceId: 'ws-1',
      orgId: 'org-1',
      integrationId: 'telegram-int',
    };
    const kv = createMockKV({
      'channel_thread:telegram:ws-1:telegram-int:12345': 'thread-1',
    });
    const registry = createTelegramRegistryStub({ binding });
    const r2Put = vi.fn(async () => undefined);
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/getFile')) {
        expect(await kv.get('channel_event:telegram:ws-1:12345:102')).toBe('processing');
        return Response.json({
          ok: true,
          result: { file_path: 'documents/report.csv', file_size: 8 },
        });
      }
      if (url === 'https://api.telegram.org/file/botbot-token/documents/report.csv') {
        return new Response('a,b\n1,2\n', {
          headers: {
            'content-type': 'text/csv',
            'content-length': '8',
          },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleTelegramWebhook({
      req: telegramRequest({
        update_id: 3,
        message: {
          message_id: 102,
          caption: 'see report',
          chat: { id: 12345, type: 'private', first_name: 'Ada' },
          from: { id: 777, first_name: 'Ada' },
          document: {
            file_id: 'FILE123',
            file_name: 'report.csv',
            mime_type: 'text/csv',
            file_size: 8,
          },
        },
      }),
      env: {
        APP_KV: kv,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
        TELEGRAM_REGISTRY: registry.namespace,
        R2_BUCKET: { put: r2Put },
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ status: 'active', chat_id: '12345' }),
            })),
          })),
        },
        ORG: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getThread: vi.fn(async () => ({ id: 'thread-1', title: 'Ada' })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never,
      ctx: {} as never,
      url: new URL('https://camelai.dev/api/integrations/telegram/webhook'),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r2Put).toHaveBeenCalledTimes(1);
    expect(r2Put.mock.calls[0][0]).toMatch(/^org-1\/ws-1\/user-uploads\/report-\d+-[a-z0-9]+\.csv$/);
    expect(startInitialUserMessage).toHaveBeenCalledTimes(1);
    const enqueued = startInitialUserMessage.mock.calls[0][0];
    expect(enqueued.message).toContain('see report');
    expect(enqueued.message).toContain('(user uploaded file to /mnt/user-uploads/report-');
  });
});
