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
    await expect(grantResponse.json()).resolves.toMatchObject({
      org_id: org.id,
      applied: true,
      grant_id: 'manual-credit-test-1',
      amount_cents: 4200,
      reason: 'CEO approved trial extension',
      created_at: expect.any(Number),
      created_by: null,
      source: 'admin-api',
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
      created_by: null,
      source: 'admin-api',
      billing_credit_grant_total_cents: 4200,
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 4200,
    });
  });

  it('admin API grant response includes ledger metadata', async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      'password123',
      'Credit Admin',
    );
    const { org } = await createOrg(testEnv, 'Admin API Ledger Metadata Org', userId);

    const response = await adminRequest(`/orgs/${org.id}/credits`, {
      amount_cents: 1500,
      reason: 'metadata test',
      idempotency_key: 'manual-credit-metadata-1',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      org_id: org.id,
      applied: true,
      grant_id: 'manual-credit-metadata-1',
      amount_cents: 1500,
      reason: 'metadata test',
      created_at: expect.any(Number),
      created_by: null,
      source: 'admin-api',
      billing_credit_grant_total_cents: 1500,
    });
  });

  it('admin API ignores attempted created_by spoofing', async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      'password123',
      'Credit Admin',
    );
    const { org } = await createOrg(testEnv, 'Admin API Spoofed Ledger Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const response = await adminRequest(`/orgs/${org.id}/credits`, {
      amount_cents: 2100,
      reason: 'spoof test',
      idempotency_key: 'manual-credit-spoof-1',
      created_by: 'attacker',
      source: 'fake',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      created_by: null,
      source: 'admin-api',
    });
    await expect(orgStub.listManualCreditGrants()).resolves.toMatchObject([
      {
        grant_id: 'manual-credit-spoof-1',
        created_by: null,
        source: 'admin-api',
      },
    ]);
  });

  it('admin API still requires bearer auth', async () => {
    const unauthenticated = new Request(
      'http://example/api/admin/orgs/missing/credits',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_cents: 1000 }),
      },
    );
    await expect(
      handleAdminApi({
        req: unauthenticated,
        env: adminEnv(),
        ctx: {} as ExecutionContext,
        url: new URL(unauthenticated.url),
        match: unauthenticated.url.match(/^.*$/)!,
      }),
    ).resolves.toBeNull();

    const unauthorized = await adminRequest(
      '/orgs/missing/credits',
      { amount_cents: 1000 },
      { Authorization: 'Bearer wrong-key' },
    );
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      error: 'Unauthorized',
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
