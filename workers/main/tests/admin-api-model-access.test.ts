import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `admin-api-model-access-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function adminEnv(): WorkerEnv {
  return {
    ...testEnv,
    ADMIN_API_KEY: 'test-admin-api-key',
  } as unknown as WorkerEnv;
}

async function adminRequest(path: string, body: unknown): Promise<Response> {
  const request = new Request(`http://example/api/admin${path}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-admin-api-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const response = await handleAdminApi({
    req: request,
    env: adminEnv(),
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });

  if (!response) {
    throw new Error('Admin API did not handle request');
  }
  return response;
}

describe('admin API org model access route', () => {
  it('grants and revokes Claude proxy access for an org', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Model Access Admin');
    const { org } = await createOrg(testEnv, 'Admin API Model Access Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const grantResponse = await adminRequest(`/orgs/${org.id}/model-access`, {
      claude_proxy_models: true,
    });

    expect(grantResponse.status).toBe(200);
    await expect(grantResponse.json()).resolves.toEqual({
      org_id: org.id,
      claude_proxy_models: true,
    });
    await expect(orgStub.getExperimentalSettings()).resolves.toMatchObject({
      claude_proxy_models: true,
    });

    const revokeResponse = await adminRequest(`/orgs/${org.id}/model-access`, {
      claude_proxy_models: false,
    });

    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toEqual({
      org_id: org.id,
      claude_proxy_models: false,
    });
    await expect(orgStub.getExperimentalSettings()).resolves.toMatchObject({
      claude_proxy_models: false,
    });
  });

  it('returns 404 for unknown orgs', async () => {
    const response = await adminRequest('/orgs/missing-org/model-access', {
      claude_proxy_models: true,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization not found',
    });
  });
});
