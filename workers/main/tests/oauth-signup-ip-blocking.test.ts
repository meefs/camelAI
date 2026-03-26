import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getOrCreateUserFromOAuth } from '../src/services/oauth';
import type { Env as WorkerEnv } from '../src/types';
import type { AdminIndexDO } from '../src/admin-index-do';
import type { TestEnv } from './test-helpers';

type OAuthSignupTestEnv = TestEnv & {
  ADMIN_INDEX: DurableObjectNamespace<AdminIndexDO>;
};

const testEnv = env as unknown as OAuthSignupTestEnv;

function testEmail() {
  return `oauth-signup-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe('OAuth signup IP logging and blocking', () => {
  it('stores the signup IP for newly created OAuth users', async () => {
    const email = testEmail();
    const signupIp = '203.0.113.20';
    const providerId = `google-${crypto.randomUUID()}`;

    const userId = await getOrCreateUserFromOAuth(
      testEnv as unknown as WorkerEnv,
      'google',
      { email, name: 'OAuth User', providerId },
      signupIp
    );

    const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));
    expect(await userStub.getSignupIp()).toBe(signupIp);
  });

  it('rejects new OAuth users from blocked IPs without leaving KV state behind', async () => {
    const blockedIp = '203.0.113.21';
    const email = testEmail();
    const providerId = `github-${crypto.randomUUID()}`;
    const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

    await adminIndex.blockSignupIp(blockedIp, 'test-suite', 'abuse');

    await expect(
      getOrCreateUserFromOAuth(
        testEnv as unknown as WorkerEnv,
        'github',
        { email, name: 'Blocked OAuth User', providerId },
        blockedIp
      )
    ).rejects.toThrow('signup_ip_blocked');

    expect(await testEnv.EMAIL_TO_USER.get(`email:${email.toLowerCase()}`)).toBeNull();
    expect(await testEnv.EMAIL_TO_USER.get(`oauth:github:${providerId}`)).toBeNull();

    await adminIndex.unblockSignupIp(blockedIp);
  });
});
