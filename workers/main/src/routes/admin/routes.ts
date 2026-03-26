/**
 * Admin API route handlers on Hono.
 *
 * Each route uses the openApi() middleware from hono-zod-openapi to declare
 * its request/response schemas. The OpenAPI spec is auto-generated from these
 * declarations — no separate spec file needed.
 *
 * List endpoints use AdminIndexDO (SQLite-backed) for efficient paginated,
 * filterable, sortable queries. Mutation endpoints still use individual DO stubs.
 *
 * All handlers assume Bearer auth has already been validated by the wrapper
 * in index.ts — they only handle routing and business logic.
 */

import { Hono } from 'hono';
import { openApi } from 'hono-zod-openapi';
import { z } from 'zod';
import type { Env } from '../../types.js';
import type { UserFilters, ThreadFilters, OrgFilters, WorkspaceFilters, AppFilters } from '../../admin-index-do.js';
import {
  ErrorSchema,
  StatsResponseSchema,
  UserSummarySchema,
  OrgMembershipSchema,
  OrgSchema,
  OrgDetailSchema,
  ThreadSchema,
  WorkspaceSchema,
  AppSchema,
  AddMemberBodySchema,
  AddMemberResponseSchema,
  BlockSignupIpBodySchema,
  BlockedSignupIpSchema,
  KvEntrySchema,
  KvValueSchema,
  R2ObjectSummarySchema,
  R2ObjectDetailSchema,
  ThreadMessagesResponseSchema,
  UsersQuerySchema,
  ThreadsQuerySchema,
  OrgsQuerySchema,
  WorkspacesQuerySchema,
  AppsQuerySchema,
  PaginationQuerySchema,
  OrgUsageSpendSchema,
  OrgUsageLimitsSchema,
  OrgUsageLogSchema,
  OrgUsageLogSumSchema,
  SetOrgLimitsBodySchema,
  paginatedList,
  dataList,
} from './schemas.js';
import {
  getAdminIndexStub,
  getOrgStub,
  getUserStub,
  loadAdminThreadMessagesResponse,
} from './helpers.js';

type HonoEnv = { Bindings: Env };

// ---------------------------------------------------------------------------
// Sandbox host usage proxy helper
// ---------------------------------------------------------------------------

async function fetchSandboxHostUsage(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `http://sandbox${path}`;
  if (!env.SANDBOX_HOST) {
    return Response.json({ error: 'SANDBOX_HOST binding not configured' }, { status: 502 });
  }
  return env.SANDBOX_HOST.fetch(url, init);
}

export const routes = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Cache-Control middleware for GET endpoints
// ---------------------------------------------------------------------------

routes.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' && c.res.status === 200 && !c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'private, max-age=30');
  }
});

// ---------------------------------------------------------------------------
// GET /stats
// ---------------------------------------------------------------------------

routes.get(
  '/stats',
  openApi({
    summary: 'Aggregate counts',
    responses: {
      200: StatsResponseSchema,
    },
  }),
  async (c) => {
    const adminIndex = getAdminIndexStub(c.env);
    const overview = await adminIndex.getOverview();
    return c.json({
      total_users: overview.total_users,
      total_orgs: overview.total_orgs,
      total_memberships: overview.total_memberships,
      total_workspaces: overview.total_workspaces,
      total_integrations: overview.total_integrations,
      orphaned_users: overview.orphaned_users,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------

routes.get(
  '/users',
  openApi({
    summary: 'List users (paginated)',
    request: {
      query: UsersQuerySchema,
    },
    responses: {
      200: paginatedList(UserSummarySchema),
    },
  }),
  async (c) => {
    const { limit, offset, search, is_superuser, is_orphaned, sort_by, sort_dir } = c.req.valid('query');
    const adminIndex = getAdminIndexStub(c.env);
    const filters: UserFilters = { sort_by, sort_dir };
    if (is_superuser !== undefined) filters.is_superuser = is_superuser;
    if (is_orphaned !== undefined) filters.is_orphaned = is_orphaned;

    const result = await adminIndex.getUsersPaginated(offset, limit, search, filters);
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /users/:id/orgs
// ---------------------------------------------------------------------------

routes.get(
  '/users/:id/orgs',
  openApi({
    summary: "User's org memberships",
    responses: {
      200: dataList(OrgMembershipSchema),
    },
  }),
  async (c) => {
    const userId = c.req.param('id');
    const userStub = getUserStub(c.env, userId);
    const orgs = await userStub.getOrgs();
    return c.json({ data: orgs });
  },
);

// ---------------------------------------------------------------------------
// GET /orgs
// ---------------------------------------------------------------------------

routes.get(
  '/orgs',
  openApi({
    summary: 'List orgs (paginated)',
    request: {
      query: OrgsQuerySchema,
    },
    responses: {
      200: paginatedList(OrgSchema),
    },
  }),
  async (c) => {
    const { limit, offset, search, archived, sort_by, sort_dir } = c.req.valid('query');
    const adminIndex = getAdminIndexStub(c.env);
    const filters: OrgFilters = { sort_by, sort_dir };
    if (archived !== undefined) filters.archived = archived;

    const result = await adminIndex.getOrgsPaginated(offset, limit, search, filters);
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id
// ---------------------------------------------------------------------------

routes.get(
  '/orgs/:id',
  openApi({
    summary: 'Org detail with recent activity',
    responses: {
      200: OrgDetailSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param('id');
    const adminIndex = getAdminIndexStub(c.env);

    // Get org metadata (including member_count, workspace_count) from AdminIndexDO
    const orgInfo = await adminIndex.getOrgById(orgId);
    if (!orgInfo) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const activity = await adminIndex.getOrgRecentActivity(orgId);

    return c.json({
      id: orgInfo.id,
      name: orgInfo.name,
      slug: orgInfo.slug ?? null,
      created_by: orgInfo.created_by,
      created_at: orgInfo.created_at,
      archived: orgInfo.archived,
      member_count: orgInfo.member_count ?? 0,
      workspace_count: orgInfo.workspace_count ?? 0,
      threads: activity.threads,
      apps: activity.apps,
      threadCount: activity.threadCount,
      appCount: activity.appCount,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/:id/members
// ---------------------------------------------------------------------------

routes.post(
  '/orgs/:id/members',
  openApi({
    summary: 'Add member to org',
    request: { json: AddMemberBodySchema },
    responses: {
      201: AddMemberResponseSchema,
      400: ErrorSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const env = c.env;
    const orgId = c.req.param('id');
    const body = c.req.valid('json');

    const orgStub = getOrgStub(env, orgId);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const userStub = getUserStub(env, body.user_id);
    const profile = await userStub.getProfile();
    if (!profile) {
      return c.json({ error: 'User not found' }, 404);
    }

    await orgStub.addMember(body.user_id, body.role, 'admin-api');
    await userStub.addOrg(orgId, body.role, null);

    return c.json({ org_id: orgId, user_id: body.user_id, role: body.role }, 201);
  },
);

// ---------------------------------------------------------------------------
// PUT /signup-blocked-ips/:ip
// ---------------------------------------------------------------------------

routes.put(
  '/signup-blocked-ips/:ip',
  openApi({
    summary: 'Block signup attempts from an IP address',
    request: {
      json: BlockSignupIpBodySchema,
    },
    responses: {
      200: BlockedSignupIpSchema,
      400: ErrorSchema,
    },
  }),
  async (c) => {
    const rawIp = decodeURIComponent(c.req.param('ip'));
    const normalizedIp = rawIp.trim().toLowerCase();
    if (!normalizedIp) {
      return c.json({ error: 'IP required' }, 400);
    }

    const body = c.req.valid('json');
    const blockedBy = body.blocked_by?.trim() || null;
    const reason = body.reason?.trim() || null;
    const blockedAt = Date.now();
    const adminIndex = getAdminIndexStub(c.env);

    await adminIndex.blockSignupIp(normalizedIp, blockedBy, reason);

    return c.json({
      ip: normalizedIp,
      blocked: true,
      blocked_at: blockedAt,
      blocked_by: blockedBy,
      reason,
    });
  },
);

// ---------------------------------------------------------------------------
// DELETE /signup-blocked-ips/:ip
// ---------------------------------------------------------------------------

routes.delete(
  '/signup-blocked-ips/:ip',
  openApi({
    summary: 'Remove an IP address from the signup blocklist',
    responses: {
      200: BlockedSignupIpSchema,
      400: ErrorSchema,
    },
  }),
  async (c) => {
    const rawIp = decodeURIComponent(c.req.param('ip'));
    const normalizedIp = rawIp.trim().toLowerCase();
    if (!normalizedIp) {
      return c.json({ error: 'IP required' }, 400);
    }

    const adminIndex = getAdminIndexStub(c.env);
    await adminIndex.unblockSignupIp(normalizedIp);

    return c.json({
      ip: normalizedIp,
      blocked: false,
      blocked_at: null,
      blocked_by: null,
      reason: null,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /threads
// ---------------------------------------------------------------------------

routes.get(
  '/threads',
  openApi({
    summary: 'List threads (paginated)',
    request: {
      query: ThreadsQuerySchema,
    },
    responses: {
      200: paginatedList(ThreadSchema),
    },
  }),
  async (c) => {
    const { limit, offset, search, org_id, workspace_id, created_by, sort_by, sort_dir } = c.req.valid('query');
    const adminIndex = getAdminIndexStub(c.env);
    const filters: ThreadFilters = { sort_by, sort_dir };
    if (org_id) filters.org_id = org_id;
    if (workspace_id) filters.workspace_id = workspace_id;
    if (created_by) filters.created_by = created_by;

    const result = await adminIndex.getThreadsPaginated(offset, limit, search, filters);
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /threads/:id/messages
// ---------------------------------------------------------------------------

routes.get(
  '/threads/:id/messages',
  openApi({
    summary: 'Get parsed thread messages',
    responses: {
      200: ThreadMessagesResponseSchema,
      400: ErrorSchema,
      404: ErrorSchema,
      500: ErrorSchema,
    },
  }),
  async (c) => {
    return loadAdminThreadMessagesResponse(c.env, c.req.param('id'));
  },
);

// ---------------------------------------------------------------------------
// PATCH /threads/:id
// ---------------------------------------------------------------------------

routes.patch(
  '/threads/:id',
  openApi({
    summary: 'Update thread title or creator',
    request: {
      json: z.object({
        title: z.string().optional(),
        created_by: z.string().optional(),
      }),
    },
    responses: {
      200: ThreadSchema,
      400: ErrorSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const env = c.env;
    const threadId = c.req.param('id');
    const body = c.req.valid('json');

    if (!body.title && !body.created_by) {
      return c.json({ error: 'At least one of title or created_by is required' }, 400);
    }

    // Try AdminIndexDO first (fast single-SQL lookup)
    const adminIndex = getAdminIndexStub(env);
    const threadContext = await adminIndex.getThreadContextById(threadId);

    if (threadContext) {
      const orgStub = getOrgStub(env, threadContext.org_id);
      const result = await orgStub.adminUpdateThread(threadId, body, 'admin-api');
      if (result) return c.json(result);
    }

    // Fallback: index may be stale — scan orgs via AdminIndexDO org list
    const orgsResult = await adminIndex.getOrgsPaginated(0, 1000);
    for (const org of orgsResult.items) {
      const orgStub = getOrgStub(env, org.id);
      const result = await orgStub.adminUpdateThread(threadId, body, 'admin-api');
      if (result) return c.json(result);
    }

    return c.json({ error: 'Thread not found' }, 404);
  },
);

// ---------------------------------------------------------------------------
// GET /workspaces
// ---------------------------------------------------------------------------

routes.get(
  '/workspaces',
  openApi({
    summary: 'List workspaces (paginated)',
    request: {
      query: WorkspacesQuerySchema,
    },
    responses: {
      200: paginatedList(WorkspaceSchema),
    },
  }),
  async (c) => {
    const { limit, offset, search, org_id, archived, sort_by, sort_dir } = c.req.valid('query');
    const adminIndex = getAdminIndexStub(c.env);
    const filters: WorkspaceFilters = { sort_by, sort_dir };
    if (org_id) filters.org_id = org_id;
    if (archived !== undefined) filters.archived = archived;

    const result = await adminIndex.getWorkspacesPaginated(offset, limit, search, filters);
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /apps
// ---------------------------------------------------------------------------

routes.get(
  '/apps',
  openApi({
    summary: 'List apps (paginated)',
    request: {
      query: AppsQuerySchema,
    },
    responses: {
      200: paginatedList(AppSchema),
    },
  }),
  async (c) => {
    const { limit, offset, search, org_id, workspace_id, is_public, sort_by, sort_dir } = c.req.valid('query');
    const adminIndex = getAdminIndexStub(c.env);
    const filters: AppFilters = { sort_by, sort_dir };
    if (org_id) filters.org_id = org_id;
    if (workspace_id) filters.workspace_id = workspace_id;
    if (is_public !== undefined) filters.is_public = is_public;

    const result = await adminIndex.getAppsPaginated(offset, limit, search, filters);
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /kv
// ---------------------------------------------------------------------------

routes.get(
  '/kv',
  openApi({
    summary: 'List KV keys',
    request: {
      query: z.object({ prefix: z.string().optional() }),
    },
    responses: {
      200: dataList(KvEntrySchema),
    },
  }),
  async (c) => {
    const env = c.env;
    const { prefix } = c.req.valid('query');
    const keys: Array<{ name: string; metadata?: unknown }> = [];
    let cursor: string | undefined;

    while (true) {
      const list = await env.EMAIL_TO_USER.list({ prefix, cursor });
      for (const key of list.keys) {
        keys.push({ name: key.name, metadata: key.metadata });
      }
      if (list.list_complete) break;
      cursor = list.cursor;
    }

    return c.json({ data: keys });
  },
);

// ---------------------------------------------------------------------------
// GET /kv/:key
// ---------------------------------------------------------------------------

routes.get(
  '/kv/:key',
  openApi({
    summary: 'Get KV value by key',
    responses: {
      200: KvValueSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const key = c.req.param('key');
    const value = await c.env.EMAIL_TO_USER.get(key);

    if (value === null) {
      return c.json({ error: 'Key not found' }, 404);
    }

    try {
      const parsed = JSON.parse(value);
      return c.json({ key, value: parsed, type: 'json' as const });
    } catch {
      return c.json({ key, value, type: 'string' as const });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /r2
// ---------------------------------------------------------------------------

routes.get(
  '/r2',
  openApi({
    summary: 'List R2 objects',
    request: {
      query: z.object({ prefix: z.string().optional() }),
    },
    responses: {
      200: dataList(R2ObjectSummarySchema),
    },
  }),
  async (c) => {
    const env = c.env;
    const { prefix } = c.req.valid('query');
    const objects: Array<{ key: string; size: number; lastModified: string; etag: string }> = [];
    let cursor: string | undefined;

    while (true) {
      const list = await env.R2_BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const obj of list.objects) {
        objects.push({
          key: obj.key,
          size: obj.size,
          lastModified: obj.uploaded.toISOString(),
          etag: obj.etag,
        });
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }

    return c.json({ data: objects });
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/spend — proxy to sandbox-host usage API
// ---------------------------------------------------------------------------

routes.get(
  '/orgs/:id/usage/spend',
  openApi({
    summary: 'Org spend totals and rolling window status',
    responses: {
      200: OrgUsageSpendSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param('id');
    const resp = await fetchSandboxHostUsage(c.env, `/v1/usage/orgs/${encodeURIComponent(orgId)}/spend`);
    if (!resp.ok) {
      return c.json({ error: `Sandbox host returned ${resp.status}` }, 502);
    }
    return c.json(await resp.json());
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/limits — proxy to sandbox-host usage API
// ---------------------------------------------------------------------------

routes.get(
  '/orgs/:id/usage/limits',
  openApi({
    summary: 'Org effective spend limits',
    responses: {
      200: OrgUsageLimitsSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param('id');
    const resp = await fetchSandboxHostUsage(c.env, `/v1/usage/orgs/${encodeURIComponent(orgId)}/limits`);
    if (!resp.ok) {
      return c.json({ error: `Sandbox host returned ${resp.status}` }, 502);
    }
    return c.json(await resp.json());
  },
);

// ---------------------------------------------------------------------------
// PUT /orgs/:id/usage/limits — proxy to sandbox-host usage API
// ---------------------------------------------------------------------------

routes.put(
  '/orgs/:id/usage/limits',
  openApi({
    summary: 'Set org spend limit overrides',
    request: {
      json: SetOrgLimitsBodySchema,
    },
    responses: {
      200: OrgUsageLimitsSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param('id');
    const body = c.req.valid('json');
    const resp = await fetchSandboxHostUsage(
      c.env,
      `/v1/usage/orgs/${encodeURIComponent(orgId)}/limits`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      return c.json({ error: `Sandbox host returned ${resp.status}` }, 502);
    }
    return c.json(await resp.json());
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/log — proxy to sandbox-host usage API
// ---------------------------------------------------------------------------

routes.get(
  '/orgs/:id/usage/log',
  openApi({
    summary: 'Org recent usage log entries (paginated)',
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        cursor: z.string().optional(),
        from: z.coerce.number().int().min(0).optional().describe('Start timestamp (ms since epoch, inclusive)'),
        to: z.coerce.number().int().min(0).optional().describe('End timestamp (ms since epoch, exclusive)'),
      }),
    },
    responses: {
      200: OrgUsageLogSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param('id');
    const { limit, cursor, from, to } = c.req.valid('query');
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    if (from) params.set('from', String(from));
    if (to) params.set('to', String(to));
    const qs = params.toString() ? `?${params}` : '';
    const resp = await fetchSandboxHostUsage(c.env, `/v1/usage/orgs/${encodeURIComponent(orgId)}/log${qs}`);
    if (!resp.ok) {
      return c.json({ error: `Sandbox host returned ${resp.status}` }, 502);
    }
    return c.json(await resp.json());
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/log/sum — sum spend between dates
// ---------------------------------------------------------------------------

routes.get(
  '/orgs/:id/usage/log/sum',
  openApi({
    summary: 'Sum of usage costs between dates',
    request: {
      query: z.object({
        from: z.coerce.number().int().min(0).describe('Start timestamp (ms since epoch, inclusive)'),
        to: z.coerce.number().int().min(0).describe('End timestamp (ms since epoch, exclusive)'),
      }),
    },
    responses: {
      200: OrgUsageLogSumSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param('id');
    const { from, to } = c.req.valid('query');
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    const resp = await fetchSandboxHostUsage(c.env, `/v1/usage/orgs/${encodeURIComponent(orgId)}/log/sum?${params}`);
    if (!resp.ok) {
      return c.json({ error: `Sandbox host returned ${resp.status}` }, 502);
    }
    return c.json(await resp.json());
  },
);

// ---------------------------------------------------------------------------
// GET /r2/* (wildcard — key may contain slashes)
// ---------------------------------------------------------------------------

routes.get(
  '/r2/*',
  openApi({
    summary: 'R2 object head metadata',
    responses: {
      200: R2ObjectDetailSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    // Extract everything after /r2/ from the full path.
    // basePath is /api/admin, so c.req.path is /api/admin/r2/some/key
    const fullPath = c.req.path;
    const r2Prefix = '/r2/';
    const idx = fullPath.indexOf(r2Prefix);
    const key = idx >= 0 ? decodeURIComponent(fullPath.slice(idx + r2Prefix.length)) : '';

    if (!key) {
      return c.json({ error: 'Not found' }, 404);
    }

    const obj = await c.env.R2_BUCKET.head(key);
    if (!obj) {
      return c.json({ error: 'Object not found' }, 404);
    }

    return c.json({
      key: obj.key,
      size: obj.size,
      lastModified: obj.uploaded.toISOString(),
      etag: obj.etag,
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    });
  },
);
