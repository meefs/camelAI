import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

type AdminIndexTestEnv = TestEnv & {
  ADMIN_INDEX: DurableObjectNamespace<any>;
};

const testEnv = env as unknown as AdminIndexTestEnv;

function uniqueEmail(domain = 'example.com') {
  return `admin-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}@${domain}`;
}

async function waitForAdminIndexOrgCount(minCount: number): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const orgs = await adminIndex.getOrgDirectoryRows();
    if (orgs.length >= minCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for ${minCount} orgs in AdminIndexDO`);
}

async function waitForAdminIndexOrgIds(orgIds: string[]): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const orgs = await adminIndex.getOrgDirectoryRows();
    const orgIdSet = new Set(orgs.map((org: { id: string }) => org.id));
    if (orgIds.every((orgId) => orgIdSet.has(orgId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for org ids ${orgIds.join(', ')} in AdminIndexDO`);
}

async function waitForAdminIndexSpamSummary(orgIds: string[], expected: {
  users: number;
  threads: number;
  apps: number;
  orgs: number;
}): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [users, threads, apps, orgs] = await Promise.all([
      adminIndex.getUsersByOrgIds(orgIds),
      adminIndex.getThreadsByOrgIds(orgIds),
      adminIndex.getAppsByOrgIds(orgIds),
      adminIndex.getOrgDirectoryByIds(orgIds),
    ]);
    if (
      users.length >= expected.users &&
      threads.length >= expected.threads &&
      apps.length >= expected.apps &&
      orgs.length >= expected.orgs
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for spam summary rows for org ids ${orgIds.join(', ')}`);
}

async function callAdminApi(
  request: Request,
  sandboxFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return handleAdminApi({
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
}

describe('admin API metrics routes', () => {
  it('serves spam org ids via a single analytics lookup', async () => {
    const sandboxFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      expect(url.pathname).toBe('/v1/usage/analytics/spam-org-ids');
      return Response.json({ org_ids: ['org-spam-a', 'org-spam-b'], count: 2 });
    });

    const request = new Request('http://example/api/admin/spam/org-ids', {
      headers: { Authorization: 'Bearer test-admin-api-key' },
    });
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      org_ids: ['org-spam-a', 'org-spam-b'],
      count: 2,
    });
    expect(sandboxFetch).toHaveBeenCalledOnce();
  });

  it('filters orgs by slug search and returns additive usage enrichment', async () => {
    const { userId: externalUserId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'External Admin Metrics User',
    );
    const { userId: internalUserId } = await createUser(
      testEnv,
      uniqueEmail('camelai.com'),
      'password123',
      'Internal Admin Metrics User',
    );
    const { org: externalOrg } = await createOrg(testEnv, 'External Metrics Org', externalUserId);
    await createOrg(testEnv, 'Internal Metrics Org', internalUserId);

    await waitForAdminIndexOrgIds([externalOrg.id]);

    const sandboxFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);

      if (url.pathname === '/v1/usage/analytics/orgs/query') {
        const body = await request.json() as {
          org_ids: string[];
          include_windows: boolean;
        };
        expect(body.org_ids).toEqual([externalOrg.id]);
        expect(body.include_windows).toBe(true);
        return Response.json({
          items: [
            {
              org_id: externalOrg.id,
              total_cost_usd: 12.5,
              total_requests: 7,
              spend_7d: 4.5,
              spend_30d: 9.5,
              windows: [
                {
                  label: '5h',
                  window_ms: 18_000_000,
                  limit_usd: 50,
                  spent_usd: 1.25,
                  exceeded: false,
                },
              ],
            },
          ],
          count: 1,
        });
      }

      throw new Error(`Unexpected sandbox usage route ${url.pathname}`);
    });

    const request = new Request(
      `http://example/api/admin/orgs?search=${encodeURIComponent(externalOrg.slug)}&exclude_internal_domains=camelai.com&include_usage=1&include_spend_30d=true`,
      {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      },
    );
    const response = await callAdminApi(request, sandboxFetch);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    await expect(response!.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: externalOrg.id,
          slug: externalOrg.slug,
          total_requests: 7,
          total_cost_usd: 12.5,
          spend_30d: 9.5,
          windows: [
            {
              label: '5h',
              window_ms: 18_000_000,
              limit_usd: 50,
              spent_usd: 1.25,
              exceeded: false,
            },
          ],
        }),
      ],
      total: 1,
      offset: 0,
      limit: 50,
    });
    expect(sandboxFetch).toHaveBeenCalledOnce();
  });

  it('uses default spam and internal-domain filters for top orgs', async () => {
    const { userId: externalUserA } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'External A',
    );
    const { userId: externalUserB } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'External B',
    );
    const { userId: internalUser } = await createUser(
      testEnv,
      uniqueEmail('camelai.com'),
      'password123',
      'Internal User',
    );

    const { org: externalOrgA } = await createOrg(testEnv, 'External Org A', externalUserA);
    const { org: externalOrgB } = await createOrg(testEnv, 'External Org B', externalUserB);
    await createOrg(testEnv, 'Internal Org', internalUser);

    await waitForAdminIndexOrgIds([externalOrgA.id, externalOrgB.id]);
    const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));
    const currentOrgRows = await adminIndex.getOrgDirectoryRows();
    const spamOrgIds = currentOrgRows
      .map((org: { id: string }) => org.id)
      .filter((orgId: string) => orgId !== externalOrgA.id);

    const sandboxFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);

      if (url.pathname === '/v1/usage/analytics/spam-org-ids') {
        return Response.json({ org_ids: spamOrgIds, count: spamOrgIds.length });
      }

      if (url.pathname === '/v1/usage/analytics/orgs/query') {
        const body = await request.json() as {
          org_ids: string[];
          include_windows: boolean;
        };
        expect(body.org_ids).toEqual([externalOrgA.id]);
        // Two-pass: first call ranks without windows, second fetches windows for top-N.
        return Response.json({
          items: [
            {
              org_id: externalOrgA.id,
              total_cost_usd: 30,
              total_requests: 12,
              spend_7d: 20,
              spend_30d: 25,
              ...(body.include_windows
                ? {
                    windows: [
                      {
                        label: '7d',
                        window_ms: 604_800_000,
                        limit_usd: 200,
                        spent_usd: 20,
                        exceeded: false,
                      },
                    ],
                  }
                : {}),
            },
          ],
          count: 1,
        });
      }

      throw new Error(`Unexpected sandbox usage route ${url.pathname}`);
    });

    const request = new Request('http://example/api/admin/dashboard/top-orgs', {
      headers: { Authorization: 'Bearer test-admin-api-key' },
    });
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      items: [
        {
          org_id: externalOrgA.id,
          name: 'External Org A',
          slug: externalOrgA.slug,
          created_at: expect.any(Number),
          created_by: externalUserA,
          creator_name: 'External A',
          creator_email: expect.stringMatching(/@example\.com$/),
          member_count: 1,
          workspace_count: 1,
          billing_status: 'free',
          total_requests: 12,
          total_cost_usd: 30,
          spend_7d: 20,
          spend_30d: 25,
          windows: [
            {
              label: '7d',
              window_ms: 604_800_000,
              limit_usd: 200,
              spent_usd: 20,
              exceeded: false,
            },
          ],
        },
      ],
      count: 1,
      limit: 25,
      sort_by: 'spend_7d',
    });
  });

  it('returns 501 for formula-sensitive dashboard endpoints', async () => {
    const sandboxFetch = vi.fn(async () => {
      throw new Error('sandbox fetch should not be called');
    });

    const request = new Request('http://example/api/admin/dashboard/summary', {
      headers: { Authorization: 'Bearer test-admin-api-key' },
    });
    const response = await callAdminApi(request, sandboxFetch);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(501);
    await expect(response!.json()).resolves.toEqual({
      error: 'Dashboard summary is blocked until the authoritative dashboard formulas or fixtures are available in this repo.',
    });
  });

  it('serves spam summary from spam-org set lookups and keeps mixed-membership users', async () => {
    const { userId: spamOwnerId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Spam Owner',
    );
    const { userId: mixedUserId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Mixed User',
    );
    const { userId: nonSpamOwnerId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Non Spam Owner',
    );

    const { org: spamOrg, defaultWorkspaceId: spamWorkspaceId } = await createOrg(
      testEnv,
      'Spam Metrics Org',
      spamOwnerId,
    );
    const { org: nonSpamOrg, defaultWorkspaceId: nonSpamWorkspaceId } = await createOrg(
      testEnv,
      'Legit Metrics Org',
      nonSpamOwnerId,
    );

    const spamOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(spamOrg.id));
    const nonSpamOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(nonSpamOrg.id));
    const mixedUserStub = testEnv.USER.get(testEnv.USER.idFromName(mixedUserId));

    await spamOrgStub.addMember(mixedUserId, 'member', spamOwnerId);
    await mixedUserStub.addOrg(spamOrg.id, 'member', spamWorkspaceId);
    await nonSpamOrgStub.addMember(mixedUserId, 'member', nonSpamOwnerId);
    await mixedUserStub.addOrg(nonSpamOrg.id, 'member', nonSpamWorkspaceId);

    const spamThread = await spamOrgStub.createThread(spamWorkspaceId, 'Spam Thread', mixedUserId);
    await nonSpamOrgStub.createThread(nonSpamWorkspaceId, 'Legit Thread', nonSpamOwnerId);

    const spamAppName = `spam-metrics-${crypto.randomUUID().slice(0, 8)}`;
    const legitAppName = `legit-metrics-${crypto.randomUUID().slice(0, 8)}`;
    await spamOrgStub.registerWorkerScript(spamAppName, spamWorkspaceId, spamOwnerId);
    await nonSpamOrgStub.registerWorkerScript(legitAppName, nonSpamWorkspaceId, nonSpamOwnerId);

    const spamInfo = await spamOrgStub.getInfo();
    expect(spamInfo).not.toBeNull();
    await spamOrgStub.setInfo({
      ...spamInfo!,
      billing_status: 'paying',
    });

    await waitForAdminIndexSpamSummary([spamOrg.id], {
      users: 2,
      threads: 1,
      apps: 1,
      orgs: 1,
    });

    const sandboxFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);

      if (url.pathname === '/v1/usage/analytics/spam-org-ids') {
        return Response.json({ org_ids: [spamOrg.id], count: 1 });
      }

      if (url.pathname === '/v1/usage/analytics/orgs/query') {
        const body = await request.json() as {
          org_ids: string[];
          include_windows: boolean;
        };
        expect(body.org_ids).toEqual([spamOrg.id]);
        expect(body.include_windows).toBe(true);
        return Response.json({
          items: [
            {
              org_id: spamOrg.id,
              total_cost_usd: 18.5,
              total_requests: 9,
              spend_7d: 7.5,
              spend_30d: 15.25,
              windows: [
                {
                  label: '30d',
                  window_ms: 2_592_000_000,
                  limit_usd: 0.01,
                  spent_usd: 15.25,
                  exceeded: true,
                },
              ],
            },
          ],
          count: 1,
        });
      }

      throw new Error(`Unexpected sandbox usage route ${url.pathname}`);
    });

    const request = new Request('http://example/api/admin/dashboard/spam-summary', {
      headers: { Authorization: 'Bearer test-admin-api-key' },
    });
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = await response!.json() as {
      users: Array<{ id: string; org_count: number }>;
      threads: Array<{ id: string; org_id: string; workspace_id: string; title: string }>;
      apps: Array<{ script_name: string; org_id: string; workspace_id: string; created_by: string }>;
      orgs: Array<{ id: string; name: string; billing_status: string }>;
      org_usage: Array<{
        org_id: string;
        name: string;
        billing_status: string;
        total_requests: number;
        total_cost_usd: number;
        spend_7d: number;
        spend_30d: number;
        windows: Array<{
          label: string;
          window_ms: number;
          limit_usd: number;
          spent_usd: number;
          exceeded: boolean;
        }>;
      }>;
    };

    expect(payload.users).toHaveLength(2);
    expect(payload.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: mixedUserId, org_count: 2 }),
        expect.objectContaining({ id: spamOwnerId, org_count: 1 }),
      ]),
    );
    expect(payload.threads).toEqual([
      expect.objectContaining({
        id: spamThread.id,
        title: 'Spam Thread',
        org_id: spamOrg.id,
        workspace_id: spamWorkspaceId,
      }),
    ]);
    expect(payload.apps).toEqual([
      expect.objectContaining({
        script_name: spamAppName,
        org_id: spamOrg.id,
        workspace_id: spamWorkspaceId,
        created_by: spamOwnerId,
      }),
    ]);
    expect(payload.orgs).toEqual([
      expect.objectContaining({
        id: spamOrg.id,
        name: 'Spam Metrics Org',
        billing_status: 'active',
      }),
    ]);
    expect(payload.org_usage).toEqual([
      expect.objectContaining({
        org_id: spamOrg.id,
        name: 'Spam Metrics Org',
        billing_status: 'active',
        total_requests: 9,
        total_cost_usd: 18.5,
        spend_7d: 7.5,
        spend_30d: 15.25,
        windows: [
          {
            label: '30d',
            window_ms: 2_592_000_000,
            limit_usd: 0.01,
            spent_usd: 15.25,
            exceeded: true,
          },
        ],
      }),
    ]);

    expect(sandboxFetch).toHaveBeenCalledTimes(2);
  });

  it('rebuilds missing membership rows on spam-summary reads', async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Spam Backfill Owner',
    );
    const { userId: memberId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Spam Backfill Member',
    );

    const { org: spamOrg, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Spam Backfill Org',
      ownerId,
    );
    const spamOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(spamOrg.id));
    const memberStub = testEnv.USER.get(testEnv.USER.idFromName(memberId));
    await spamOrgStub.addMember(memberId, 'member', ownerId);
    await memberStub.addOrg(spamOrg.id, 'member', defaultWorkspaceId);

    await waitForAdminIndexSpamSummary([spamOrg.id], {
      users: 2,
      threads: 0,
      apps: 0,
      orgs: 1,
    });

    const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));
    await adminIndex.handleEvent({
      type: 'org_membership_delete',
      payload: { org_id: spamOrg.id, user_id: ownerId },
    });
    await adminIndex.handleEvent({
      type: 'org_membership_delete',
      payload: { org_id: spamOrg.id, user_id: memberId },
    });

    const sandboxFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);

      if (url.pathname === '/v1/usage/analytics/spam-org-ids') {
        return Response.json({ org_ids: [spamOrg.id], count: 1 });
      }

      if (url.pathname === '/v1/usage/analytics/orgs/query') {
        return Response.json({
          items: [
            {
              org_id: spamOrg.id,
              total_cost_usd: 0,
              total_requests: 0,
              spend_7d: 0,
              spend_30d: 0,
              windows: [],
            },
          ],
          count: 1,
        });
      }

      throw new Error(`Unexpected sandbox usage route ${url.pathname}`);
    });

    const request = new Request('http://example/api/admin/dashboard/spam-summary', {
      headers: { Authorization: 'Bearer test-admin-api-key' },
    });
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = await response!.json() as {
      users: Array<{ id: string }>;
      orgs: Array<{ id: string }>;
    };
    expect(payload.orgs).toEqual([expect.objectContaining({ id: spamOrg.id })]);
    expect(payload.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ownerId }),
        expect.objectContaining({ id: memberId }),
      ]),
    );
    expect(payload.users).toHaveLength(2);
    expect(sandboxFetch).toHaveBeenCalledTimes(2);
  });
});
