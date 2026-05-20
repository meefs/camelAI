import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createUser, type TestEnv } from './test-helpers';
import { getAppIndexReadDatabase } from '../src/app-index-db';

const testEmail = () => `signup-ip-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('signup IP logging and blocking storage', () => {
  const testEnv = env as unknown as TestEnv;

  it('stores the signup IP on the user record', async () => {
    const email = testEmail();
    const signupIp = '203.0.113.10';

    const { userId } = await createUser(
      testEnv,
      email,
      'password123',
      'IP Logged User',
      signupIp
    );
    const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId!));
    expect(await userStub.getSignupIp()).toBe(signupIp);
  });

  it('blocks and unblocks signup IPs through the admin API', async () => {
    const blockedIp = '203.0.113.99';
    const appIndex = getAppIndexReadDatabase(testEnv)!;
    const adminEnv = {
      ...testEnv,
      ADMIN_API_KEY: 'test-admin-api-key',
    } as unknown as WorkerEnv;

    const blockRequest = new Request(
      `http://example/api/admin/signup-blocked-ips/${encodeURIComponent(blockedIp)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer test-admin-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          blocked_by: 'test-suite',
          reason: 'abuse',
        }),
      }
    );

    const blockResponse = await handleAdminApi({
      req: blockRequest,
      env: adminEnv,
      ctx: {} as ExecutionContext,
      url: new URL(blockRequest.url),
      match: blockRequest.url.match(/^.*$/)!,
    });

    expect(blockResponse).not.toBeNull();
    expect(blockResponse!.status).toBe(200);
    await expect(blockResponse!.json()).resolves.toMatchObject({
      ip: blockedIp,
      blocked: true,
      blocked_by: 'test-suite',
      reason: 'abuse',
    });
    expect(await appIndex.isSignupIpBlocked(blockedIp)).toBe(true);

    const unblockRequest = new Request(
      `http://example/api/admin/signup-blocked-ips/${encodeURIComponent(blockedIp)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer test-admin-api-key',
        },
      }
    );

    const unblockResponse = await handleAdminApi({
      req: unblockRequest,
      env: adminEnv,
      ctx: {} as ExecutionContext,
      url: new URL(unblockRequest.url),
      match: unblockRequest.url.match(/^.*$/)!,
    });

    expect(unblockResponse).not.toBeNull();
    expect(unblockResponse!.status).toBe(200);
    await expect(unblockResponse!.json()).resolves.toMatchObject({
      ip: blockedIp,
      blocked: false,
    });
    expect(await appIndex.isSignupIpBlocked(blockedIp)).toBe(false);
  });
});
