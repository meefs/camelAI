import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/app-index-db', () => ({
  getAppIndexDatabase: (env: { APP_DB: unknown }) => env.APP_DB,
  getAppIndexReadDatabase: (env: { APP_DB: unknown }) => env.APP_DB,
}));

vi.mock('../src/admin-index-bootstrap', () => ({
  ensureAdminIndexReady: vi.fn(async () => undefined),
}));

import { loadAdminThreadMessagesResponse } from '../src/routes/admin/helpers';

describe('loadAdminThreadMessagesResponse', () => {
  it('returns Pi messages directly', async () => {
    const piMessages = [
      {
        id: 'message-1',
        thread_id: 'thread-1',
        role: 'user',
        content: 'hello',
        created_at: 123,
      },
    ];
    const env = {
      APP_DB: {
        getThreadContextById: vi.fn(async () => ({
          org_id: 'org-1',
          workspace_id: 'workspace-1',
        })),
      },
      APP_KV: {},
      EMAIL_TO_USER: {},
      USER: {},
      ORG: {
        idFromName: (id: string) => id,
        get: vi.fn(() => ({
          getThread: vi.fn(async () => ({
            workspace_id: 'workspace-1',
          })),
        })),
      },
      WORKSPACE: {},
      CHAT_THREAD: {
        idFromName: (id: string) => id,
        get: vi.fn(() => ({
          getPiCoreParsedMessages: vi.fn(async () => piMessages),
        })),
      },
    };

    const response = await loadAdminThreadMessagesResponse(env as never, 'thread-1');
    const body = await response.json() as { success?: boolean; messages?: unknown[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.messages).toEqual(piMessages);
  });
});
