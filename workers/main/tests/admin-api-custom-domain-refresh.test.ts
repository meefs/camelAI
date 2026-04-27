import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `admin-api-custom-domain-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function adminEnv(): WorkerEnv {
  return {
    ...testEnv,
    ADMIN_API_KEY: 'test-admin-api-key',
    CF_ZONE_ID: 'zone-1',
    CF_API_TOKEN: 'token-1',
  } as unknown as WorkerEnv;
}

async function adminRequest(path: string, body: unknown): Promise<Response> {
  const request = new Request(`http://example/api/admin${path}`, {
    method: 'POST',
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

function cfHostnameResponse(scriptName: string) {
  return Response.json({
    success: true,
    result: {
      id: `cf-${scriptName}`,
      hostname: `${scriptName}.apps.example.com`,
      ssl: {
        status: 'pending_validation',
        method: 'txt',
        type: 'dv',
        dcv_delegation_records: [
          {
            cname: `_acme-challenge.${scriptName}.apps.example.com`,
            cname_target: `${scriptName}-token.dcv.cloudflare.com`,
          },
        ],
      },
      status: 'pending',
      created_at: '2026-04-27T00:00:00Z',
    },
  });
}

describe('admin API custom domain refresh route', () => {
  it('refreshes non-active custom hostnames for an org', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Custom Domain Admin');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Custom Domain Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await orgStub.setCustomDomain('apps.example.com', userId);
    await orgStub.registerWorkerScript('pending-app', defaultWorkspaceId, userId);
    await orgStub.registerWorkerScript('active-app', defaultWorkspaceId, userId);
    await orgStub.updateWorkerScriptCustomDomain('active-app', {
      hostname: 'active-app.apps.example.com',
      cf_hostname_id: 'cf-active-app',
      status: 'active',
      ssl_status: 'active',
      error: null,
    });

    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.method).toBe('POST');
        const body = await request.json() as { hostname: string };
        expect(body.hostname).toBe('pending-app.apps.example.com');
        return cfHostnameResponse('pending-app');
      });
    vi.stubGlobal('fetch', fetchMock);

    const response = await adminRequest(`/orgs/${org.id}/custom-domain/refresh`, {
      include_active: false,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      org_id: org.id,
      domain: 'apps.example.com',
      total_apps: 2,
      attempted: 1,
      refreshed: 1,
      failed: 0,
      skipped_active: 1,
      apps: expect.arrayContaining([
        expect.objectContaining({
          script_name: 'pending-app',
          action: 'refreshed',
          cf_hostname_id: 'cf-pending-app',
          status: 'pending',
          ssl_status: 'pending_validation',
          dcv_record: {
            cname: '_acme-challenge.pending-app.apps.example.com',
            cname_target: 'pending-app-token.dcv.cloudflare.com',
          },
        }),
        expect.objectContaining({
          script_name: 'active-app',
          action: 'skipped_active',
        }),
      ]),
    });

    await expect(orgStub.getWorkerScript('pending-app')).resolves.toMatchObject({
      custom_domain_hostname: 'pending-app.apps.example.com',
      custom_domain_cf_hostname_id: 'cf-pending-app',
      custom_domain_status: 'pending',
      custom_domain_ssl_status: 'pending_validation',
      custom_domain_error: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns 404 for unknown orgs', async () => {
    const response = await adminRequest('/orgs/missing-org/custom-domain/refresh', {
      include_active: false,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization not found',
    });
  });
});
