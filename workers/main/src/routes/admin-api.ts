/**
 * Admin REST API
 *
 * All endpoints require Bearer token auth via ADMIN_API_KEY secret.
 * If no Bearer token is present, returns null to fall through to
 * React Router (for session-auth admin routes like /api/admin/threads/:id/messages).
 *
 * Routes:
 *   GET   /api/admin/stats                 — Aggregate counts
 *   GET   /api/admin/users                 — All users
 *   GET   /api/admin/users/:id/orgs        — User's orgs
 *   GET   /api/admin/orgs                  — All orgs (enriched)
 *   GET   /api/admin/threads               — All threads
 *   POST  /api/admin/orgs/:id/members      — Add member to org
 *   PATCH /api/admin/threads/:id           — Update thread
 *   GET   /api/admin/kv                    — List KV keys
 *   GET   /api/admin/kv/:key              — Get KV value
 *   GET   /api/admin/r2                    — List R2 objects
 *   GET   /api/admin/r2/:key+             — R2 object metadata
 */

import type { RouteContext } from '../types.js';
import type { Env } from '../types.js';
import type {
  OrgDO,
  UserDO,
  Organization,
  OrgThread,
} from '../auth.js';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Returns true if auth succeeded, false if no Bearer token (fall through). Throws Response on bad token. */
function checkAdminAuth(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;

  const key = env.ADMIN_API_KEY;
  if (!key) throw new Response(JSON.stringify({ error: 'Admin API not configured' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });

  if (auth !== `Bearer ${key}`) throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

  return true;
}

// ---------------------------------------------------------------------------
// DO stub helpers
// ---------------------------------------------------------------------------

function getOrgStub(env: Env, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

function getUserStub(env: Env, userId: string) {
  return env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<UserDO>;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

async function collectAllUserIds(env: Env): Promise<string[]> {
  const allKeys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const list = await env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
    for (const key of list.keys) {
      allKeys.push(key.name);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  const userIdResults = await Promise.all(allKeys.map((key) => env.EMAIL_TO_USER.get(key)));
  return userIdResults.filter((id): id is string => id !== null && !id.startsWith('{'));
}

async function collectAllOrgIds(env: Env): Promise<Set<string>> {
  const userIds = await collectAllUserIds(env);
  const orgIds = new Set<string>();

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userStub = getUserStub(env, userId);
        const orgs = await userStub.getOrgs();
        for (const org of orgs) {
          orgIds.add(org.org_id);
        }
      } catch {
        // User may not exist
      }
    })
  );

  return orgIds;
}

interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  org_count: number;
  is_superuser: boolean;
}

async function getAllUsers(env: Env): Promise<AdminUserSummary[]> {
  const userIds = await collectAllUserIds(env);
  const users: AdminUserSummary[] = [];

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userStub = getUserStub(env, userId);
        const [profile, orgs] = await Promise.all([userStub.getProfile(), userStub.getOrgs()]);

        if (profile) {
          users.push({
            id: profile.id,
            email: profile.email,
            name: profile.name,
            created_at: profile.created_at,
            org_count: orgs.length,
            is_superuser: profile.is_superuser,
          });
        }
      } catch {
        // User may not exist
      }
    })
  );

  return users;
}

interface AdminOrgSummary extends Organization {
  member_count: number;
  workspace_count: number;
}

async function getAllOrgs(env: Env): Promise<AdminOrgSummary[]> {
  const orgIds = await collectAllOrgIds(env);
  const orgs: AdminOrgSummary[] = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const orgStub = getOrgStub(env, orgId);
        const [info, members, workspaces] = await Promise.all([
          orgStub.getInfo(),
          orgStub.getMembers(),
          orgStub.getWorkspaces(),
        ]);

        if (info) {
          orgs.push({
            ...info,
            member_count: members.length,
            workspace_count: workspaces.length,
          });
        }
      } catch {
        // Org may not exist
      }
    })
  );

  return orgs;
}

interface AdminThreadWithContext extends OrgThread {
  org_id: string;
  org_name: string;
  workspace_name: string;
}

async function getAllThreads(env: Env): Promise<AdminThreadWithContext[]> {
  const orgIds = await collectAllOrgIds(env);
  const threads: AdminThreadWithContext[] = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const orgStub = getOrgStub(env, orgId);
        const [info, orgThreads, workspaces] = await Promise.all([
          orgStub.getInfo(),
          orgStub.getThreads(),
          orgStub.getWorkspaces(),
        ]);

        if (info) {
          const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

          for (const thread of orgThreads) {
            threads.push({
              ...thread,
              org_id: orgId,
              org_name: info.name,
              workspace_name: workspaceMap.get(thread.workspace_id) || 'unknown',
            });
          }
        }
      } catch {
        // Org may not exist
      }
    })
  );

  return threads;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const PREFIX = '/api/admin/';

export async function handleAdminApi({ req, env, url }: RouteContext): Promise<Response | null> {
  // No Bearer token → fall through to React Router (session-auth admin routes)
  try {
    if (!checkAdminAuth(req, env)) return null;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const sub = url.pathname.slice(PREFIX.length);

  try {
    // GET /stats
    if (req.method === 'GET' && sub === 'stats') {
      const users = await getAllUsers(env);
      const orgIds = new Set<string>();
      let membershipCount = 0;

      for (const u of users) {
        membershipCount += u.org_count;
        // We need org IDs — fetch from user stubs
      }

      // Collect unique org IDs
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

      return json({
        user_count: users.length,
        org_count: orgIds.size,
        membership_count: membershipCount,
      });
    }

    // GET /users
    if (req.method === 'GET' && sub === 'users') {
      const users = await getAllUsers(env);
      return json({ data: users });
    }

    // GET /users/:id/orgs
    const userOrgsMatch = sub.match(/^users\/([^/]+)\/orgs$/);
    if (req.method === 'GET' && userOrgsMatch) {
      const userId = decodeURIComponent(userOrgsMatch[1]!);
      const userStub = getUserStub(env, userId);
      const orgs = await userStub.getOrgs();
      return json({ data: orgs });
    }

    // GET /orgs
    if (req.method === 'GET' && sub === 'orgs') {
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

      return json({ data: enrichedOrgs });
    }

    // GET /threads
    if (req.method === 'GET' && sub === 'threads') {
      const threads = await getAllThreads(env);
      return json({ data: threads });
    }

    // POST /orgs/:id/members
    const addMemberMatch = sub.match(/^orgs\/([^/]+)\/members$/);
    if (req.method === 'POST' && addMemberMatch) {
      const orgId = decodeURIComponent(addMemberMatch[1]!);
      const body = (await req.json()) as { user_id?: string; role?: string };
      if (!body.user_id) {
        return json({ error: 'user_id is required' }, 400);
      }

      const role = body.role || 'member';
      if (role !== 'admin' && role !== 'member') {
        return json({ error: 'role must be "admin" or "member"' }, 400);
      }

      const orgStub = getOrgStub(env, orgId);
      const orgInfo = await orgStub.getInfo();
      if (!orgInfo) {
        return json({ error: 'Organization not found' }, 404);
      }

      const userStub = getUserStub(env, body.user_id);
      const profile = await userStub.getProfile();
      if (!profile) {
        return json({ error: 'User not found' }, 404);
      }

      await orgStub.addMember(body.user_id, role, 'admin-api');
      await userStub.addOrg(orgId, role, null);

      return json({ org_id: orgId, user_id: body.user_id, role }, 201);
    }

    // PATCH /threads/:id
    const updateThreadMatch = sub.match(/^threads\/([^/]+)$/);
    if (req.method === 'PATCH' && updateThreadMatch) {
      const threadId = decodeURIComponent(updateThreadMatch[1]!);
      const body = (await req.json()) as { title?: string; created_by?: string };
      if (!body.title && !body.created_by) {
        return json({ error: 'At least one of title or created_by is required' }, 400);
      }

      const orgIds = await collectAllOrgIds(env);
      let result: OrgThread | null = null;

      for (const orgId of orgIds) {
        const orgStub = getOrgStub(env, orgId);
        const thread = await orgStub.getThread(threadId);
        if (thread) {
          result = await orgStub.adminUpdateThread(threadId, body, 'admin-api');
          break;
        }
      }

      if (!result) {
        return json({ error: 'Thread not found' }, 404);
      }

      return json(result);
    }

    // GET /kv
    if (req.method === 'GET' && sub === 'kv') {
      const prefix = url.searchParams.get('prefix') || undefined;
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

      return json({ data: keys });
    }

    // GET /kv/:key
    const kvKeyMatch = sub.match(/^kv\/(.+)$/);
    if (req.method === 'GET' && kvKeyMatch) {
      const key = decodeURIComponent(kvKeyMatch[1]!);
      const value = await env.EMAIL_TO_USER.get(key);
      if (value === null) {
        return json({ error: 'Key not found' }, 404);
      }
      try {
        const parsed = JSON.parse(value);
        return json({ key, value: parsed, type: 'json' });
      } catch {
        return json({ key, value, type: 'string' });
      }
    }

    // GET /r2
    if (req.method === 'GET' && sub === 'r2') {
      const prefix = url.searchParams.get('prefix') || undefined;
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

      return json({ data: objects });
    }

    // GET /r2/:key+ (wildcard)
    if (req.method === 'GET' && sub.startsWith('r2/')) {
      const key = decodeURIComponent(sub.slice('r2/'.length));
      // Skip if it looks like the old /r2/list or /r2/backup paths (already handled or dropped)
      if (!key) return json({ error: 'Not found' }, 404);

      const obj = await env.R2_BUCKET.head(key);
      if (!obj) {
        return json({ error: 'Object not found' }, 404);
      }

      return json({
        key: obj.key,
        size: obj.size,
        lastModified: obj.uploaded.toISOString(),
        etag: obj.etag,
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
      });
    }

    // Unmatched sub-path with valid Bearer token → 404
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ error: message }, 500);
  }
}
