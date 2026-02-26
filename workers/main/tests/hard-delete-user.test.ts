import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { hardDeleteAdminUser } from '../../../src/lib/auth-do.server';
import { createUser, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function makeContext() {
  return {
    cloudflare: {
      env: testEnv as never,
    },
  } as never;
}

async function waitForAdminIndexUserPresence(userId: string, present: boolean): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const overview = await adminIndex.getOverview();
    const exists = overview.users.some((user: { id: string }) => user.id === userId);
    if (exists === present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for user ${userId} presence=${present} in AdminIndexDO`);
}

describe('hardDeleteAdminUser', () => {
  it('removes deleted users from AdminIndexDO user list', async () => {
    const email = `hard-delete-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const { userId } = await createUser(testEnv, email, 'password123', 'Delete Me');

    await waitForAdminIndexUserPresence(userId, true);

    const result = await hardDeleteAdminUser(makeContext(), userId, 'system-admin');
    expect(result.removed_org_memberships).toBe(0);

    const profile = await testEnv.USER.get(testEnv.USER.idFromName(userId)).getProfile();
    expect(profile).toBeNull();

    await waitForAdminIndexUserPresence(userId, false);
  });
});
