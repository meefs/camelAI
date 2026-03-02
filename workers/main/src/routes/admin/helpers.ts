/**
 * Data-fetching helpers and DO stub accessors for the admin API.
 * Lifted verbatim from the original admin-api.ts.
 */

import type { Env } from '../../types.js';
import type {
  OrgDO,
  UserDO,
  Organization,
  OrgThread,
} from '../../auth.js';

// ---------------------------------------------------------------------------
// DO stub helpers
// ---------------------------------------------------------------------------

export function getOrgStub(env: Env, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

export function getUserStub(env: Env, userId: string) {
  return env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<UserDO>;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

export async function collectAllUserIds(env: Env): Promise<string[]> {
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

export async function collectAllOrgIds(env: Env): Promise<Set<string>> {
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

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  org_count: number;
  is_superuser: boolean;
}

export async function getAllUsers(env: Env): Promise<AdminUserSummary[]> {
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

export interface AdminOrgSummary extends Organization {
  member_count: number;
  workspace_count: number;
}

export async function getAllOrgs(env: Env): Promise<AdminOrgSummary[]> {
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

export interface AdminThreadWithContext extends OrgThread {
  org_id: string;
  org_name: string;
  workspace_name: string;
}

export async function getAllThreads(env: Env): Promise<AdminThreadWithContext[]> {
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
