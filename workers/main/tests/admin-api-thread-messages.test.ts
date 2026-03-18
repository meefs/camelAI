import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

type AdminIndexTestEnv = TestEnv & {
  ADMIN_INDEX: DurableObjectNamespace<any>;
};

const testEnv = env as unknown as AdminIndexTestEnv;

function testEmail() {
  return `admin-api-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function waitForAdminIndexThreadPresence(threadId: string, present: boolean): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const threadContext = await adminIndex.getThreadContextById(threadId);
    const exists = threadContext !== null;
    if (exists === present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for thread ${threadId} presence=${present} in AdminIndexDO`);
}

describe('admin API thread messages route', () => {
  it('serves parsed thread messages with bearer auth', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Bearer thread messages', userId);

    await waitForAdminIndexThreadPresence(thread.id, true);

    const sandboxFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      expect(url.pathname).toBe(
        `/v1/workspaces/${encodeURIComponent(org.id)}/${encodeURIComponent(defaultWorkspaceId)}/chat/messages`,
      );
      expect(url.searchParams.get('threadId')).toBe(thread.id);

      return Response.json({
        success: true,
        messages: [
          {
            id: 'u1',
            thread_id: thread.id,
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            created_at: 1730000000000,
          },
        ],
      });
    });

    const request = new Request(`http://example/api/admin/threads/${thread.id}/messages`, {
      headers: {
        Authorization: 'Bearer test-admin-api-key',
      },
    });

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
        SANDBOX_HOST: { fetch: sandboxFetch },
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    await expect(response!.json()).resolves.toEqual({
      success: true,
      messages: [
        {
          id: 'u1',
          thread_id: thread.id,
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          created_at: 1730000000000,
        },
      ],
    });
    expect(sandboxFetch).toHaveBeenCalledOnce();
  });
});
