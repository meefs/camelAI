import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `admin-api-credits-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function adminEnv(): WorkerEnv {
  return {
    ...testEnv,
    ADMIN_API_KEY: 'test-admin-api-key',
  } as unknown as WorkerEnv;
}

async function adminRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request(`http://example/api/admin${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-admin-api-key',
      'Content-Type': 'application/json',
      ...headers,
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

describe('admin API org credit grants', () => {
  it('grants credits and deduplicates by idempotency key', async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      'password123',
      'Credit Admin',
    );
    const { org } = await createOrg(testEnv, 'Admin API Credit Grant Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const grantResponse = await adminRequest(`/orgs/${org.id}/credits`, {
      amount_cents: 4200,
      reason: 'CEO approved trial extension',
    }, {
      'Idempotency-Key': 'manual-credit-test-1',
    });

    expect(grantResponse.status).toBe(200);
    await expect(grantResponse.json()).resolves.toEqual({
      org_id: org.id,
      applied: true,
      grant_id: 'manual-credit-test-1',
      amount_cents: 4200,
      reason: 'CEO approved trial extension',
      billing_credit_grant_total_cents: 4200,
    });

    const duplicateResponse = await adminRequest(`/orgs/${org.id}/credits`, {
      amount_cents: 4200,
      reason: 'CEO approved trial extension',
    }, {
      'Idempotency-Key': 'manual-credit-test-1',
    });

    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      org_id: org.id,
      applied: false,
      grant_id: 'manual-credit-test-1',
      amount_cents: 4200,
      billing_credit_grant_total_cents: 4200,
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 4200,
    });
  });

  it('returns 404 for unknown orgs', async () => {
    const response = await adminRequest('/orgs/missing-org/credits', {
      amount_cents: 1000,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization not found',
    });
  });
});
