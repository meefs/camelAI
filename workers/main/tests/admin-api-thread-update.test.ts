import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

type AdminIndexTestEnv = TestEnv & {
  ADMIN_INDEX: DurableObjectNamespace<any>;
};

const testEnv = env as unknown as AdminIndexTestEnv;

function testEmail() {
  return `admin-api-thread-update-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function waitForAdminIndexThreadPresence(threadId: string): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const threadContext = await adminIndex.getThreadContextById(threadId);
    if (threadContext) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for thread ${threadId} to appear in AdminIndexDO`);
}

describe('admin API thread patch route', () => {
  it('rejects per-thread model changes after creation', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Patch thread model', userId);

    await waitForAdminIndexThreadPresence(thread.id);

    const request = new Request(`http://example/api/admin/threads/${thread.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-admin-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'opus' }),
    });

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: 'This thread is locked to its original model. Start a new thread to use a different model.',
    });

    const stored = await orgStub.getThread(thread.id);
    expect(stored?.model).toBe('sonnet');
  });

  it('backfills null thread models during AdminIndexDO remigration', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin Index Migration User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin Index Migration Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Legacy null model thread', userId);
    const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index')) as unknown as {
      getThreadContextById(threadId: string): Promise<{ model: string | null } | null>;
      setThreadModelForTest(threadId: string, model: string | null): Promise<void>;
      remigrate(): Promise<void>;
    };

    await waitForAdminIndexThreadPresence(thread.id);

    await adminIndex.setThreadModelForTest(thread.id, null);
    await expect(adminIndex.getThreadContextById(thread.id)).resolves.toMatchObject({ model: null });

    await adminIndex.remigrate();

    await expect(adminIndex.getThreadContextById(thread.id)).resolves.toMatchObject({ model: 'sonnet' });
  });
});
