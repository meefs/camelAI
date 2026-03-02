/**
 * Admin API route handlers on Hono.
 *
 * Each route uses the openApi() middleware from hono-zod-openapi to declare
 * its request/response schemas. The OpenAPI spec is auto-generated from these
 * declarations — no separate spec file needed.
 *
 * All handlers assume Bearer auth has already been validated by the wrapper
 * in index.ts — they only handle routing and business logic.
 */

import { Hono } from 'hono';
import { openApi } from 'hono-zod-openapi';
import type { Env } from '../../types.js';
import {
  ErrorSchema,
  StatsResponseSchema,
  UserSummarySchema,
  OrgMembershipSchema,
  OrgEnrichedSchema,
  ThreadSchema,
  AddMemberBodySchema,
  AddMemberResponseSchema,
  KvEntrySchema,
  KvValueSchema,
  R2ObjectSummarySchema,
  R2ObjectDetailSchema,
  dataList,
} from './schemas.js';
import {
  getAllUsers,
  getAllOrgs,
  getAllThreads,
  collectAllOrgIds,
  getOrgStub,
  getUserStub,
} from './helpers.js';

type HonoEnv = { Bindings: Env };

export const routes = new Hono<HonoEnv>();

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
    const env = c.env;
    const users = await getAllUsers(env);
    const orgIds = new Set<string>();
    let membershipCount = 0;

    for (const u of users) {
      membershipCount += u.org_count;
    }

    await Promise.all(
      users.map(async (u) => {
        try {
          const userStub = getUserStub(env, u.id);
          const orgs = await userStub.getOrgs();
          for (const org of orgs) orgIds.add(org.org_id);
        } catch {
          // ignore
        }
      })
    );

    return c.json({
      user_count: users.length,
      org_count: orgIds.size,
      membership_count: membershipCount,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------

routes.get(
  '/users',
  openApi({
    summary: 'List all users',
    responses: {
      200: dataList(UserSummarySchema),
    },
  }),
  async (c) => {
    const users = await getAllUsers(c.env);
    return c.json({ data: users });
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
    summary: 'List all orgs (enriched with members and workspaces)',
    responses: {
      200: dataList(OrgEnrichedSchema),
    },
  }),
  async (c) => {
    const env = c.env;
    const orgs = await getAllOrgs(env);

    const enrichedOrgs = await Promise.all(
      orgs.map(async (org) => {
        const orgStub = getOrgStub(env, org.id);
        const [members, workspaces] = await Promise.all([
          orgStub.getMembers(),
          orgStub.getWorkspaces(true),
        ]);

        const memberDetails = await Promise.all(
          members.map(async (m) => {
            try {
              const userStub = getUserStub(env, m.user_id);
              const profile = await userStub.getProfile();
              return {
                user_id: m.user_id,
                email: profile?.email || 'unknown',
                name: profile?.name || null,
                role: m.role,
                joined_at: m.joined_at,
              };
            } catch {
              return {
                user_id: m.user_id,
                email: 'unknown',
                name: null,
                role: m.role,
                joined_at: m.joined_at,
              };
            }
          })
        );

        return {
          id: org.id,
          name: org.name,
          created_by: org.created_by,
          created_at: org.created_at,
          member_count: org.member_count,
          members: memberDetails,
          workspace_count: workspaces.length,
          workspaces: workspaces.map((ws) => ({
            id: ws.id,
            name: ws.name,
            created_at: ws.created_at,
            archived: ws.archived,
          })),
        };
      })
    );

    return c.json({ data: enrichedOrgs });
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
// GET /threads
// ---------------------------------------------------------------------------

routes.get(
  '/threads',
  openApi({
    summary: 'List all threads across orgs',
    responses: {
      200: dataList(ThreadSchema),
    },
  }),
  async (c) => {
    const threads = await getAllThreads(c.env);
    return c.json({ data: threads });
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

    const orgIds = await collectAllOrgIds(env);
    let result = null;

    for (const orgId of orgIds) {
      const orgStub = getOrgStub(env, orgId);
      const thread = await orgStub.getThread(threadId);
      if (thread) {
        result = await orgStub.adminUpdateThread(threadId, body, 'admin-api');
        break;
      }
    }

    if (!result) {
      return c.json({ error: 'Thread not found' }, 404);
    }

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

// Need z import for inline schemas in openApi() middleware
import { z } from 'zod';
