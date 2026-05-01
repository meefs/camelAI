import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';
import { DAY_MS } from '../src/admin-dashboard-metrics';
import { encryptCredentials } from '../../../src/lib/integration-crypto';

type AdminIndexTestEnv = TestEnv & {
  ADMIN_INDEX: DurableObjectNamespace<any>;
};

const testEnv = env as unknown as AdminIndexTestEnv;

function uniqueEmail(domain = 'example.com') {
  return `admin-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}@${domain}`;
}

function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function uniqueDomain(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.test`;
}

async function buildExcludedDomains(allowedDomain: string): Promise<string> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));
  const overview = await adminIndex.getOverview();
  const domains = new Set<string>(['camelai.com']);

  for (const user of overview.users as Array<{ email?: string | null }>) {
    const email = user.email ?? null;
    const atIndex = email?.lastIndexOf('@') ?? -1;
    if (atIndex >= 0 && atIndex < (email?.length ?? 0) - 1) {
      domains.add(email!.slice(atIndex + 1).toLowerCase());
    }
  }

  domains.delete(allowedDomain);
  return Array.from(domains).sort().join(',');
}

async function seedDashboardMetricFixture(allowedDomain: string) {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));
  const now = Date.now();
  const todayStart = startOfUtcDay(now);
  const tenDaysAgo = todayStart - 10 * DAY_MS + 1_000;
  const twoDaysAfterSignup = tenDaysAgo + 2 * DAY_MS + 1_000;

  const userAId = crypto.randomUUID();
  const userBId = crypto.randomUUID();
  const orgAId = crypto.randomUUID();
  const orgBId = crypto.randomUUID();
  const wsAId = crypto.randomUUID();
  const wsBId = crypto.randomUUID();
  const threadRetentionId = crypto.randomUUID();
  const threadTodayAId = crypto.randomUUID();
  const threadTodayBId = crypto.randomUUID();
  const appTodayAId = `${orgAId}:summary-public-${crypto.randomUUID().slice(0, 8)}`;
  const appTodayBId = `${orgBId}:summary-private-${crypto.randomUUID().slice(0, 8)}`;

  await adminIndex.handleEvent({
    type: 'user_upsert',
    payload: {
      id: userAId,
      email: `summary-a@${allowedDomain}`,
      name: 'Summary User A',
      avatar: { color: '#111111', content: 'A' },
      created_at: tenDaysAgo,
      is_superuser: false,
      is_orphaned: false,
      org_count: 1,
    },
  });
  await adminIndex.handleEvent({
    type: 'user_upsert',
    payload: {
      id: userBId,
      email: `summary-b@${allowedDomain}`,
      name: 'Summary User B',
      avatar: { color: '#222222', content: 'B' },
      created_at: todayStart + 2_000,
      is_superuser: false,
      is_orphaned: false,
      org_count: 1,
    },
  });

  await adminIndex.handleEvent({
    type: 'org_upsert',
    payload: {
      id: orgAId,
      name: 'Summary Org A',
      slug: `summary-org-a-${crypto.randomUUID().slice(0, 6)}`,
      created_at: tenDaysAgo + 100,
      archived: false,
      billing_status: 'paying',
      created_by: userAId,
      member_count: 1,
      workspace_count: 1,
    },
  });
  await adminIndex.handleEvent({
    type: 'org_upsert',
    payload: {
      id: orgBId,
      name: 'Summary Org B',
      slug: `summary-org-b-${crypto.randomUUID().slice(0, 6)}`,
      created_at: todayStart + 2_100,
      archived: false,
      billing_status: null,
      created_by: userBId,
      member_count: 1,
      workspace_count: 1,
    },
  });

  await adminIndex.handleEvent({
    type: 'workspace_upsert',
    payload: {
      id: wsAId,
      name: 'Summary Workspace A',
      org_id: orgAId,
      description: null,
      avatar: { color: '#aaaaaa', content: 'A' },
      created_at: tenDaysAgo + 200,
      created_by: userAId,
      archived: false,
      archived_at: null,
      archived_by: null,
      compute_tier: 'standard',
      integration_count: 0,
    },
  });
  await adminIndex.handleEvent({
    type: 'workspace_upsert',
    payload: {
      id: wsBId,
      name: 'Summary Workspace B',
      org_id: orgBId,
      description: null,
      avatar: { color: '#bbbbbb', content: 'B' },
      created_at: todayStart + 2_200,
      created_by: userBId,
      archived: false,
      archived_at: null,
      archived_by: null,
      compute_tier: 'standard',
      integration_count: 0,
    },
  });

  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: threadRetentionId,
      title: 'Retention Thread',
      org_id: orgAId,
      workspace_id: wsAId,
      created_at: twoDaysAfterSignup,
      updated_at: twoDaysAfterSignup,
      created_by: userAId,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: threadTodayAId,
      title: 'Today Thread A',
      org_id: orgAId,
      workspace_id: wsAId,
      created_at: todayStart + 4_000,
      updated_at: todayStart + 4_000,
      created_by: userAId,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: threadTodayBId,
      title: 'Today Thread B',
      org_id: orgBId,
      workspace_id: wsBId,
      created_at: todayStart + 5_000,
      updated_at: todayStart + 5_000,
      created_by: userBId,
    },
  });

  await adminIndex.handleEvent({
    type: 'app_upsert',
    payload: {
      app_id: appTodayAId,
      script_name: appTodayAId.split(':')[1],
      org_id: orgAId,
      workspace_id: wsAId,
      created_by: userAId,
      created_at: todayStart + 6_000,
      updated_at: todayStart + 6_000,
      is_public: true,
      preview_status: null,
      preview_error: null,
    },
  });
  await adminIndex.handleEvent({
    type: 'app_upsert',
    payload: {
      app_id: appTodayBId,
      script_name: appTodayBId.split(':')[1],
      org_id: orgBId,
      workspace_id: wsBId,
      created_by: userBId,
      created_at: todayStart + 7_000,
      updated_at: todayStart + 7_000,
      is_public: false,
      preview_status: null,
      preview_error: null,
    },
  });

  return {
    today: new Date(now).toISOString().slice(0, 10),
    userAId,
    userBId,
    orgAId,
    orgBId,
    threadTodayAId,
    threadTodayBId,
    appTodayAId,
    appTodayBId,
  };
}

async function seedRetentionMetricFixture(allowedDomain: string) {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));
  const now = Date.now();
  const todayStart = startOfUtcDay(now);
  const eightDaysAgo = todayStart - 8 * DAY_MS + 1_000;

  const user1Id = crypto.randomUUID();
  const user2Id = crypto.randomUUID();
  const user3Id = crypto.randomUUID();
  const records = [
    {
      userId: user1Id,
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      email: `retention-one@${allowedDomain}`,
      name: 'Retention One',
      createdAt: eightDaysAgo,
      slug: `retention-one-${crypto.randomUUID().slice(0, 6)}`,
      billingStatus: null,
    },
    {
      userId: user2Id,
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      email: `retention-two@${allowedDomain}`,
      name: 'Retention Two',
      createdAt: eightDaysAgo + 1_000,
      slug: `retention-two-${crypto.randomUUID().slice(0, 6)}`,
      billingStatus: null,
    },
    {
      userId: user3Id,
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      email: `retention-three@${allowedDomain}`,
      name: 'Retention Three',
      createdAt: todayStart + 1_000,
      slug: `retention-three-${crypto.randomUUID().slice(0, 6)}`,
      billingStatus: null,
    },
  ];

  for (const [index, record] of records.entries()) {
    await adminIndex.handleEvent({
      type: 'user_upsert',
      payload: {
        id: record.userId,
        email: record.email,
        name: record.name,
        avatar: { color: `#${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}`, content: record.name[0] },
        created_at: record.createdAt,
        is_superuser: false,
        is_orphaned: false,
        org_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_upsert',
      payload: {
        id: record.orgId,
        name: `${record.name} Org`,
        slug: record.slug,
        created_at: record.createdAt + 10,
        archived: false,
        billing_status: record.billingStatus,
        created_by: record.userId,
        member_count: 1,
        workspace_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'workspace_upsert',
      payload: {
        id: record.workspaceId,
        name: `${record.name} Workspace`,
        org_id: record.orgId,
        description: null,
        avatar: { color: '#999999', content: record.name[0] },
        created_at: record.createdAt + 20,
        created_by: record.userId,
        archived: false,
        archived_at: null,
        archived_by: null,
        compute_tier: 'standard',
        integration_count: 0,
      },
    });
  }

  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: crypto.randomUUID(),
      title: 'Retention One Signup',
      org_id: records[0].orgId,
      workspace_id: records[0].workspaceId,
      created_at: records[0].createdAt + 30,
      updated_at: records[0].createdAt + 30,
      created_by: records[0].userId,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: crypto.randomUUID(),
      title: 'Retention One Day One',
      org_id: records[0].orgId,
      workspace_id: records[0].workspaceId,
      created_at: records[0].createdAt + DAY_MS + 30,
      updated_at: records[0].createdAt + DAY_MS + 30,
      created_by: records[0].userId,
    },
  });
  await adminIndex.handleEvent({
    type: 'app_upsert',
    payload: {
      app_id: `${records[1].orgId}:retention-signup`,
      script_name: 'retention-signup',
      org_id: records[1].orgId,
      workspace_id: records[1].workspaceId,
      created_by: records[1].userId,
      created_at: records[1].createdAt + 30,
      updated_at: records[1].createdAt + 30,
      is_public: true,
      preview_status: null,
      preview_error: null,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: crypto.randomUUID(),
      title: 'Retention Three Signup',
      org_id: records[2].orgId,
      workspace_id: records[2].workspaceId,
      created_at: records[2].createdAt + 30,
      updated_at: records[2].createdAt + 30,
      created_by: records[2].userId,
    },
  });
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

async function waitForAdminIndexOrgBillingStatus(
  orgId: string,
  billingStatus: string | null,
): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await adminIndex.getOrgDirectoryByIds([orgId]);
    if ((rows[0]?.billing_status ?? null) === billingStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for billing status ${billingStatus} on org ${orgId}`);
}

async function waitForAdminIndexOrgLlmProvider(
  orgId: string,
  provider: string,
): Promise<void> {
  const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await adminIndex.getOrgLlmProviderDirectoryPaginated(
      0,
      100,
      undefined,
      provider,
    );
    if (rows.items.some((org: { id: string }) => org.id === orgId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for LLM provider ${provider} on org ${orgId}`);
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
  envOverride?: WorkerEnv,
) {
  return handleAdminApi({
    req: request,
    env: envOverride ?? {
      ...testEnv,
      ADMIN_API_KEY: 'test-admin-api-key',
      SANDBOX_HOST: { fetch: sandboxFetch },
    } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
}

function createIsolatedAdminApiEnv(
  adminIndexName: string,
  sandboxFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return {
    ...testEnv,
    ADMIN_API_KEY: 'test-admin-api-key',
    ADMIN_INDEX: {
      idFromName: () => testEnv.ADMIN_INDEX.idFromName(adminIndexName),
      get: (id: DurableObjectId, options?: DurableObjectGetOptions) =>
        testEnv.ADMIN_INDEX.get(id, options),
    },
    SANDBOX_HOST: { fetch: sandboxFetch },
  } as unknown as WorkerEnv;
}

describe('admin API metrics routes', () => {
  it('migrates legacy counter columns used by dashboard API endpoints', async () => {
    const adminIndexName = `admin_index_legacy_counters_${crypto.randomUUID()}`;
    const sandboxFetch = vi.fn(async () => Response.json({ org_ids: [], count: 0 }));
    const isolatedEnv = createIsolatedAdminApiEnv(adminIndexName, sandboxFetch);
    const adminIndex = testEnv.ADMIN_INDEX.get(
      testEnv.ADMIN_INDEX.idFromName(adminIndexName),
    );
    const now = Date.now();
    const selectedDate = new Date(now).toISOString().slice(0, 10);
    const userId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const adminRequest = (path: string) =>
      new Request(`http://example/api/admin${path}`, {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      });

    await adminIndex.handleEvent({
      type: 'user_upsert',
      payload: {
        id: userId,
        email: `legacy-workspace-${crypto.randomUUID()}@example.com`,
        name: 'Legacy Workspace User',
        avatar: { color: '#123456', content: 'L' },
        created_at: now,
        is_superuser: false,
        is_orphaned: false,
        org_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_upsert',
      payload: {
        id: orgId,
        name: 'Legacy Workspace Org',
        slug: `legacy-workspace-${crypto.randomUUID().slice(0, 8)}`,
        created_at: now,
        archived: false,
        billing_status: null,
        created_by: userId,
        member_count: 1,
        workspace_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_membership_upsert',
      payload: {
        org_id: orgId,
        user_id: userId,
        role: 'admin',
        joined_at: now,
      },
    });
    await adminIndex.handleEvent({
      type: 'workspace_upsert',
      payload: {
        id: workspaceId,
        name: 'Legacy Workspace',
        org_id: orgId,
        description: null,
        avatar: { color: '#654321', content: 'W' },
        created_at: now,
        created_by: userId,
        archived: false,
        archived_at: null,
        archived_by: null,
        compute_tier: 'standard',
        integration_count: 3,
      },
    });
    await adminIndex.handleEvent({
      type: 'thread_upsert',
      payload: {
        id: crypto.randomUUID(),
        title: 'Legacy Thread',
        org_id: orgId,
        workspace_id: workspaceId,
        created_at: now + 1,
        updated_at: now + 1,
        created_by: userId,
      },
    });

    const migratedColumns = await runInDurableObject(adminIndex, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE orgs_legacy (
          id TEXT PRIMARY KEY,
          name TEXT,
          slug TEXT,
          created_at INTEGER,
          archived INTEGER,
          billing_status TEXT,
          created_by TEXT
        );
        INSERT INTO orgs_legacy (
          id,
          name,
          slug,
          created_at,
          archived,
          billing_status,
          created_by
        )
        SELECT
          id,
          name,
          slug,
          created_at,
          archived,
          billing_status,
          created_by
        FROM orgs;
        DROP TABLE orgs;
        ALTER TABLE orgs_legacy RENAME TO orgs;

        CREATE TABLE workspaces_legacy (
          id TEXT PRIMARY KEY,
          name TEXT,
          org_id TEXT,
          description TEXT,
          avatar_color TEXT,
          avatar_content TEXT,
          created_at INTEGER,
          created_by TEXT,
          archived INTEGER,
          archived_at INTEGER,
          archived_by TEXT,
          compute_tier TEXT
        );
        INSERT INTO workspaces_legacy (
          id,
          name,
          org_id,
          description,
          avatar_color,
          avatar_content,
          created_at,
          created_by,
          archived,
          archived_at,
          archived_by,
          compute_tier
        )
        SELECT
          id,
          name,
          org_id,
          description,
          avatar_color,
          avatar_content,
          created_at,
          created_by,
          archived,
          archived_at,
          archived_by,
          compute_tier
        FROM workspaces;
        DROP TABLE workspaces;
        ALTER TABLE workspaces_legacy RENAME TO workspaces;
      `);
      instance.migrate();
      return {
        orgs: sql.exec<{ name: string }>('PRAGMA table_info(orgs)')
          .toArray()
          .map((column) => column.name),
        orgIndexes: sql.exec<{ name: string }>('PRAGMA index_list(orgs)')
          .toArray()
          .map((index) => index.name),
        workspaces: sql.exec<{ name: string }>('PRAGMA table_info(workspaces)')
          .toArray()
          .map((column) => column.name),
      };
    });

    expect(migratedColumns.orgs).toContain('member_count');
    expect(migratedColumns.orgs).toContain('workspace_count');
    expect(migratedColumns.orgs).toContain('llm_provider');
    expect(migratedColumns.orgs).toContain('llm_provider_updated_at');
    expect(migratedColumns.orgIndexes).toContain('idx_orgs_llm_provider_created_at');
    expect(migratedColumns.workspaces).toContain('thread_count');
    expect(migratedColumns.workspaces).toContain('integration_count');

    const statsResponse = await callAdminApi(adminRequest('/stats'), sandboxFetch, isolatedEnv);
    expect(statsResponse?.status).toBe(200);
    const stats = await statsResponse!.json() as {
      total_workspaces: number;
      total_memberships: number;
      total_integrations: number;
    };
    expect(stats.total_workspaces).toBe(1);
    expect(stats.total_memberships).toBe(1);
    expect(stats.total_integrations).toBe(0);

    const workspacesResponse = await callAdminApi(adminRequest('/workspaces?limit=10'), sandboxFetch, isolatedEnv);
    expect(workspacesResponse?.status).toBe(200);
    const workspaces = await workspacesResponse!.json() as {
      items: Array<{ id: string; thread_count: number; integration_count: number }>;
    };
    expect(workspaces.items).toEqual([
      expect.objectContaining({
        id: workspaceId,
        thread_count: 1,
        integration_count: 0,
      }),
    ]);

    const summaryResponse = await callAdminApi(
      adminRequest(`/dashboard/summary?date=${selectedDate}&exclude_spam=false`),
      sandboxFetch,
      isolatedEnv,
    );
    expect(summaryResponse?.status).toBe(200);
    const summary = await summaryResponse!.json() as {
      kpis: { total_workspaces: number; total_users: number };
    };
    expect(summary.kpis.total_workspaces).toBe(1);
    expect(summary.kpis.total_users).toBe(1);
  });

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

  it('filters orgs with large spam exclusion lists without exceeding sqlite variable limits', async () => {
    const adminIndexName = `admin_index_large_spam_filter_${crypto.randomUUID()}`;
    const spamOrgIds = Array.from({ length: 1_200 }, (_, index) => `spam-org-${index}`);
    const sandboxFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      expect(url.pathname).toBe('/v1/usage/analytics/spam-org-ids');
      return Response.json({ org_ids: spamOrgIds, count: spamOrgIds.length });
    });
    const isolatedEnv = createIsolatedAdminApiEnv(adminIndexName, sandboxFetch);
    const adminIndex = testEnv.ADMIN_INDEX.get(
      testEnv.ADMIN_INDEX.idFromName(adminIndexName),
    );
    const now = Date.now();
    const userId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const scriptName = `large-spam-app-${crypto.randomUUID().slice(0, 8)}`;
    const appId = `${orgId}:${scriptName}`;

    await adminIndex.handleEvent({
      type: 'user_upsert',
      payload: {
        id: userId,
        email: `large-spam-filter-${crypto.randomUUID()}@example.com`,
        name: 'Large Spam Filter User',
        avatar: { color: '#334455', content: 'S' },
        created_at: now,
        is_superuser: false,
        is_orphaned: false,
        org_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_upsert',
      payload: {
        id: orgId,
        name: 'Large Spam Filter Org',
        slug: `large-spam-filter-${crypto.randomUUID().slice(0, 8)}`,
        created_at: now,
        archived: false,
        billing_status: null,
        created_by: userId,
        member_count: 1,
        workspace_count: 0,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_membership_upsert',
      payload: {
        org_id: orgId,
        user_id: userId,
        role: 'admin',
        joined_at: now,
      },
    });
    await adminIndex.handleEvent({
      type: 'thread_upsert',
      payload: {
        id: threadId,
        title: 'Large Spam Filter Thread',
        org_id: orgId,
        workspace_id: workspaceId,
        created_at: now + 1,
        updated_at: now + 1,
        created_by: userId,
      },
    });
    await adminIndex.handleEvent({
      type: 'app_upsert',
      payload: {
        app_id: appId,
        script_name: scriptName,
        org_id: orgId,
        workspace_id: workspaceId,
        created_by: userId,
        created_at: now + 2,
        updated_at: now + 2,
        is_public: false,
        preview_status: null,
        preview_error: null,
      },
    });

    const response = await callAdminApi(
      new Request('http://example/api/admin/orgs?exclude_spam=true&exclude_internal_domains=camelai.com', {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      }),
      sandboxFetch,
      isolatedEnv,
    );

    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: orgId,
          name: 'Large Spam Filter Org',
        }),
      ],
      total: 1,
      offset: 0,
      limit: 50,
    });
    expect(sandboxFetch).toHaveBeenCalledOnce();

    const largeOrgIdLookup = [...spamOrgIds, orgId];
    await expect(adminIndex.getOrgDirectoryByIds(largeOrgIdLookup)).resolves.toEqual([
      expect.objectContaining({ id: orgId }),
    ]);
    await expect(adminIndex.getUsersByOrgIds(largeOrgIdLookup)).resolves.toEqual([
      expect.objectContaining({ id: userId }),
    ]);
    await expect(adminIndex.getThreadsByOrgIds(largeOrgIdLookup)).resolves.toEqual([
      expect.objectContaining({ id: threadId }),
    ]);
    await expect(adminIndex.getAppsByOrgIds(largeOrgIdLookup)).resolves.toEqual([
      expect.objectContaining({ app_id: appId }),
    ]);
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
                  limit_usd: 25,
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
              limit_usd: 25,
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

  it('exposes BYOK provider status for admin org listing', async () => {
    const secretKey = testEnv.INTEGRATION_SECRET_KEY ?? 'admin-byok-test-secret';
    const { userId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Admin BYOK User',
    );
    const searchPrefix = `Admin BYOK ${crypto.randomUUID().slice(0, 8)}`;
    const { org } = await createOrg(testEnv, `${searchPrefix} One`, userId);
    const { org: secondOrg } = await createOrg(
      testEnv,
      `${searchPrefix} Two`,
      userId,
    );
    await waitForAdminIndexOrgIds([org.id]);
    await waitForAdminIndexOrgIds([secondOrg.id]);

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const secondOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(secondOrg.id));
    const encrypted = await encryptCredentials(
      { api_key: 'sk-or-admin-byok-visible' },
      secretKey,
    );
    const secondEncrypted = await encryptCredentials(
      { api_key: 'sk-or-admin-byok-visible-2' },
      secretKey,
    );
    await orgStub.setLlmProviderConfig(
      'openrouter',
      encrypted,
      JSON.stringify({}),
      userId,
    );
    await secondOrgStub.setLlmProviderConfig(
      'openrouter',
      secondEncrypted,
      JSON.stringify({}),
      userId,
    );
    await waitForAdminIndexOrgLlmProvider(org.id, 'openrouter');
    await waitForAdminIndexOrgLlmProvider(secondOrg.id, 'openrouter');

    const sandboxFetch = vi.fn(async () => Response.json({}));
    const adminEnv = {
      ...testEnv,
      ADMIN_API_KEY: 'test-admin-api-key',
      INTEGRATION_SECRET_KEY: secretKey,
      SANDBOX_HOST: { fetch: sandboxFetch },
    } as unknown as WorkerEnv;

    const byokResponse = await callAdminApi(
      new Request(
        `http://example/api/admin/orgs/llm-providers?search=${encodeURIComponent(org.slug)}`,
        {
          headers: { Authorization: 'Bearer test-admin-api-key' },
        },
      ),
      sandboxFetch,
      adminEnv,
    );
    expect(byokResponse?.status).toBe(200);
    const byokBody = await byokResponse!.json() as {
      items: Array<{
        id: string;
        has_llm_provider: boolean;
        llm_provider: { provider: string; key_hint: string };
      }>;
      total: number;
    };
    expect(byokBody.total).toBe(1);
    expect(byokBody.items).toEqual([
      expect.objectContaining({
        id: org.id,
        has_llm_provider: true,
        llm_provider: expect.objectContaining({
          provider: 'openrouter',
          key_hint: 'sk-or-ad...',
        }),
      }),
    ]);
    expect(JSON.stringify(byokBody)).not.toContain('credentials_encrypted');

    const paginatedByokResponse = await callAdminApi(
      new Request(
        `http://example/api/admin/orgs/llm-providers?search=${encodeURIComponent(searchPrefix)}&limit=1&offset=1`,
        {
          headers: { Authorization: 'Bearer test-admin-api-key' },
        },
      ),
      sandboxFetch,
      adminEnv,
    );
    expect(paginatedByokResponse?.status).toBe(200);
    const paginatedByokBody = await paginatedByokResponse!.json() as {
      items: Array<{ id: string; has_llm_provider: boolean }>;
      total: number;
      offset: number;
      limit: number;
    };
    expect(paginatedByokBody).toEqual({
      items: [
        expect.objectContaining({
          id: expect.stringMatching(
            new RegExp(`^(${org.id}|${secondOrg.id})$`),
          ),
          has_llm_provider: true,
        }),
      ],
      total: 2,
      offset: 1,
      limit: 1,
    });

    const orgsResponse = await callAdminApi(
      new Request(
        `http://example/api/admin/orgs?search=${encodeURIComponent(org.slug)}&include_llm_provider=1`,
        {
          headers: { Authorization: 'Bearer test-admin-api-key' },
        },
      ),
      sandboxFetch,
      adminEnv,
    );
    expect(orgsResponse?.status).toBe(200);
    await expect(orgsResponse!.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: org.id,
          has_llm_provider: true,
          llm_provider: expect.objectContaining({
            provider: 'openrouter',
            key_hint: 'sk-or-ad...',
          }),
        }),
      ],
      total: 1,
      offset: 0,
      limit: 50,
    });
  });

  it('serves dashboard daily spend with internal orgs included and enriched top-org metadata', async () => {
    const { userId: payingUserId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Daily Spend Paying User',
    );
    const { userId: spamUserId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Daily Spend Spam User',
    );
    const { userId: internalUserId } = await createUser(
      testEnv,
      uniqueEmail('camelai.com'),
      'password123',
      'Daily Spend Internal User',
    );

    const { org: payingOrg } = await createOrg(testEnv, 'Daily Spend Paying Org', payingUserId);
    const { org: spamOrg } = await createOrg(testEnv, 'Daily Spend Spam Org', spamUserId);
    const { org: internalOrg } = await createOrg(testEnv, 'Daily Spend Internal Org', internalUserId);

    await waitForAdminIndexOrgIds([payingOrg.id, spamOrg.id, internalOrg.id]);

    const payingOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(payingOrg.id));
    const payingOrgInfo = await payingOrgStub.getInfo();
    expect(payingOrgInfo).not.toBeNull();
    await payingOrgStub.setInfo({
      ...payingOrgInfo!,
      billing_status: 'paying',
    });
    await waitForAdminIndexOrgBillingStatus(payingOrg.id, 'paying');

    const adminIndex = testEnv.ADMIN_INDEX.get(testEnv.ADMIN_INDEX.idFromName('admin_index'));
    const expectedOrgIds = (await adminIndex.getOrgDirectoryRows())
      .map((org: { id: string }) => org.id)
      .sort();

    const sandboxFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);
      expect(url.pathname).toBe('/v1/usage/analytics/daily-spend/query');

      const body = await request.json() as {
        date: string;
        org_ids: string[];
        top_orgs_limit: number;
      };
      expect(body.date).toBe('2026-04-04');
      expect(body.top_orgs_limit).toBe(1);
      expect(body.org_ids.slice().sort()).toEqual(expectedOrgIds);
      expect(body.org_ids).toContain(internalOrg.id);

      return Response.json({
        date: '2026-04-04',
        is_partial: true,
        total_spend_usd: 150,
        total_requests: 15,
        spam_spend_usd: 25,
        non_spam_spend_usd: 125,
        spam_org_count: 1,
        non_spam_org_count: 1,
        previous_day: {
          date: '2026-04-03',
          total_spend_usd: 100,
          total_requests: 10,
          spam_spend_usd: 10,
          non_spam_spend_usd: 90,
        },
        hourly_series: [
          {
            hour: 0,
            spend_usd: 30,
            requests: 3,
            spam_spend_usd: 5,
            non_spam_spend_usd: 25,
          },
        ],
        model_breakdown: [
          {
            model: 'claude-opus-4-6',
            spend_usd: 100,
            requests: 5,
          },
          {
            model: 'claude-sonnet-4-6',
            spend_usd: 50,
            requests: 10,
          },
        ],
        top_orgs: [
          {
            org_id: payingOrg.id,
            spend_usd: 125,
            requests: 12,
            is_spam: false,
          },
        ],
        other_orgs_spend_usd: 25,
        other_orgs_count: 1,
      });
    });

    const request = new Request(
      'http://example/api/admin/dashboard/daily-spend?date=2026-04-04&top_orgs_limit=1',
      {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      },
    );
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      date: '2026-04-04',
      is_partial: true,
      total_spend_usd: 150,
      total_requests: 15,
      spam_spend_usd: 25,
      non_spam_spend_usd: 125,
      spam_org_count: 1,
      non_spam_org_count: 1,
      previous_day: {
        date: '2026-04-03',
        total_spend_usd: 100,
        total_requests: 10,
        spam_spend_usd: 10,
        non_spam_spend_usd: 90,
      },
      hourly_series: [
        {
          hour: 0,
          spend_usd: 30,
          requests: 3,
          spam_spend_usd: 5,
          non_spam_spend_usd: 25,
        },
      ],
      model_breakdown: [
        {
          model: 'claude-opus-4-6',
          spend_usd: 100,
          requests: 5,
          pct_of_total: 66.7,
        },
        {
          model: 'claude-sonnet-4-6',
          spend_usd: 50,
          requests: 10,
          pct_of_total: 33.3,
        },
      ],
      top_orgs: [
        {
          org_id: payingOrg.id,
          org_name: 'Daily Spend Paying Org',
          org_slug: payingOrg.slug,
          spend_usd: 125,
          requests: 12,
          is_spam: false,
          billing_plan: 'pro',
        },
      ],
      other_orgs_spend_usd: 25,
      other_orgs_count: 1,
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
                        limit_usd: 100,
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
              limit_usd: 100,
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

  it('serves dashboard summary with filtered metrics and selected-day drilldown', async () => {
    const allowedDomain = uniqueDomain('summary-metrics');
    const fixture = await seedDashboardMetricFixture(allowedDomain);
    const excludedDomains = await buildExcludedDomains(allowedDomain);

    const sandboxFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      expect(url.pathname).toBe('/v1/usage/analytics/spam-org-ids');
      return Response.json({ org_ids: [], count: 0 });
    });

    const request = new Request(
      `http://example/api/admin/dashboard/summary?date=${fixture.today}&exclude_internal_domains=${encodeURIComponent(excludedDomains)}`,
      {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      },
    );
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = await response!.json() as {
      kpis: {
        total_users: number;
        total_orgs: number;
        total_threads: number;
        total_apps: number;
        total_workspaces: number;
      };
      daily_series: Array<{
        date: string;
        new_users: number;
        new_threads: number;
        new_apps: number;
        returning_users: number;
        new_active_users: number;
        rolling_avg_signups: number;
      }>;
      selected_day: {
        date: string;
        new_users: number;
        new_threads: number;
        new_apps: number;
        new_orgs: number;
        top_users_by_threads: Array<{ id: string; thread_count: number }>;
        top_orgs_by_activity: Array<{ name: string; thread_count: number }>;
        latest_threads: Array<{ id: string }>;
        latest_apps: Array<{ app_id: string }>;
        latest_orgs: Array<{ id: string; billing_status: string }>;
        recent_users: Array<{ id: string }>;
      };
      billing_breakdown: Array<{ status: string; count: number }>;
      app_visibility: { public: number; private: number };
      retention_snapshot: { rate_pct: number; cohort_size: number; retained_count: number };
    };

    expect(payload.kpis).toEqual({
      total_users: 2,
      total_orgs: 2,
      total_threads: 3,
      total_apps: 2,
      total_workspaces: 2,
    });
    expect(payload.daily_series).toHaveLength(30);
    expect(payload.daily_series.at(-1)).toEqual({
      date: fixture.today,
      new_users: 1,
      new_threads: 2,
      new_apps: 2,
      returning_users: 1,
      new_active_users: 1,
      rolling_avg_signups: 0.1,
    });
    expect(payload.selected_day.date).toBe(fixture.today);
    expect(payload.selected_day.new_users).toBe(1);
    expect(payload.selected_day.new_threads).toBe(2);
    expect(payload.selected_day.new_apps).toBe(2);
    expect(payload.selected_day.new_orgs).toBe(1);
    expect(payload.selected_day.top_users_by_threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.userAId, thread_count: 1 }),
        expect.objectContaining({ id: fixture.userBId, thread_count: 1 }),
      ]),
    );
    expect(payload.selected_day.top_orgs_by_activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Summary Org A', thread_count: 1 }),
        expect.objectContaining({ name: 'Summary Org B', thread_count: 1 }),
      ]),
    );
    expect(payload.selected_day.latest_threads.map((thread) => thread.id)).toEqual([
      fixture.threadTodayBId,
      fixture.threadTodayAId,
    ]);
    expect(payload.selected_day.latest_apps.map((app) => app.app_id)).toEqual([
      fixture.appTodayBId,
      fixture.appTodayAId,
    ]);
    expect(payload.selected_day.latest_orgs).toEqual([
      expect.objectContaining({ id: fixture.orgBId, billing_status: 'free' }),
    ]);
    expect(payload.selected_day.recent_users).toEqual([
      expect.objectContaining({ id: fixture.userBId }),
    ]);
    expect(payload.billing_breakdown).toEqual([
      { status: 'active', count: 1 },
      { status: 'free', count: 1 },
    ]);
    expect(payload.app_visibility).toEqual({ public: 1, private: 1 });
    expect(payload.retention_snapshot).toEqual({
      rate_pct: 100,
      cohort_size: 1,
      retained_count: 1,
    });
    expect(sandboxFetch).toHaveBeenCalledOnce();
  });

  it('serves dashboard retention without sandbox spam lookups when disabled', async () => {
    const allowedDomain = uniqueDomain('retention-metrics');
    await seedRetentionMetricFixture(allowedDomain);
    const excludedDomains = await buildExcludedDomains(allowedDomain);

    const sandboxFetch = vi.fn(async () => {
      throw new Error('sandbox fetch should not be called');
    });

    const request = new Request(
      `http://example/api/admin/dashboard/retention?exclude_spam=false&exclude_internal_domains=${encodeURIComponent(excludedDomains)}`,
      {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      },
    );
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = await response!.json() as {
      retention_curve: Array<{ day: number; retention_pct: number; users_eligible: number }>;
      kpis: {
        day1_retention: number;
        day7_retention: number;
        day14_retention: number;
        day30_retention: number;
      };
      cohort_table: Array<{ cohort_size: number }>;
      wau_time_series: Array<{ wau: number }>;
      stickiness_series: Array<{ dau_wau_ratio: number }>;
    };

    expect(payload.retention_curve).toEqual(
      expect.arrayContaining([
        { day: 0, retention_pct: 100, users_eligible: 3 },
        { day: 1, retention_pct: 50, users_eligible: 2 },
        { day: 7, retention_pct: 50, users_eligible: 2 },
        { day: 14, retention_pct: 0, users_eligible: 0 },
        { day: 28, retention_pct: 0, users_eligible: 0 },
      ]),
    );
    expect(payload.kpis).toEqual(expect.objectContaining({
      day1_retention: 50,
      day7_retention: 50,
      day14_retention: 0,
      day30_retention: 0,
    }));
    expect(payload.cohort_table.length).toBeGreaterThan(0);
    expect(payload.wau_time_series.length).toBeGreaterThan(0);
    expect(payload.stickiness_series).toHaveLength(30);
    expect(sandboxFetch).not.toHaveBeenCalled();
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
