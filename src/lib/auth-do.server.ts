/**
 * Server-side auth-do functions that accept React Router AppLoadContext.
 * These functions wrap the auth-do module to use context-passed environment.
 */
import type { AppLoadContext } from 'react-router';
import type {
  User,
  Organization,
  OrgMembership,
  OrgRole,
  WorkspaceWithAccess,
  AuditLogEntry,
  AdminOverview,
  AdminUserSummary,
  AdminWorkspaceSummary,
  AdminWorkspaceDetail,
  AdminThreadWithContext,
  AdminAppSummary,
  AdminAppDetail,
  AdminInvitation,
  PaginatedResult,
  PaginationParams,
  Message,
} from '@/types';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import type { UserProfile } from '../../workers/main/src/auth';
import * as authDO from './auth-do';
import { getMessages as getThreadMessages, getThreadPreview } from './chat-do.server';
import {
  getWorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../workers/main/src/workspace-container';

function getAuthEnv(env: CloudflareEnv): authDO.AuthEnv {
  return {
    USER: env.USER as authDO.AuthEnv['USER'],
    ORG: env.ORG as authDO.AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as authDO.AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
}

// Helper: Collect all user IDs from KV
async function collectAllUserIds(env: CloudflareEnv): Promise<string[]> {
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

// Helper: Collect all org IDs from user memberships
async function collectAllOrgIds(env: CloudflareEnv): Promise<Set<string>> {
  const authEnv = getAuthEnv(env);
  const userIds = await collectAllUserIds(env);
  const orgIds = new Set<string>();

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const orgs = await authDO.getUserOrgs(authEnv, userId);
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

// Admin overview functions
export async function getAdminOverview(context: AppLoadContext): Promise<AdminOverview> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userIds = await collectAllUserIds(env);
  const seenOrgIds = new Set<string>();
  let membershipCount = 0;
  let orphanedUsers = 0;

  const users: AdminUserSummary[] = [];

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const [profile, orgs] = await Promise.all([
          authDO.getUserById(authEnv, userId),
          authDO.getUserOrgs(authEnv, userId),
        ]);

        if (profile) {
          const isOrphaned = profile.is_orphaned || false;
          if (isOrphaned) orphanedUsers++;

          users.push({
            id: profile.id,
            email: profile.email,
            name: profile.name,
            avatar: { color: profile.avatar_color || '#666', content: profile.avatar_content || profile.email[0].toUpperCase() },
            created_at: profile.created_at,
            org_count: orgs.length,
            is_superuser: profile.is_superuser,
            is_orphaned: isOrphaned,
          });

          membershipCount += orgs.length;
          for (const org of orgs) {
            seenOrgIds.add(org.org_id);
          }
        }
      } catch {
        // User may not exist
      }
    })
  );

  // Count workspaces and integrations across all orgs
  let totalWorkspaces = 0;
  let totalIntegrations = 0;

  await Promise.all(
    Array.from(seenOrgIds).map(async (orgId) => {
      try {
        const workspaces = await authDO.listOrgWorkspaces(authEnv, orgId);
        totalWorkspaces += workspaces.length;

        // Count integrations per workspace
        for (const ws of workspaces) {
          try {
            const integrations = await authDO.listWorkspaceIntegrations(authEnv, ws.id);
            totalIntegrations += integrations.length;
          } catch {
            // Workspace may not have integrations
          }
        }
      } catch {
        // Org may not exist
      }
    })
  );

  return {
    users,
    total_users: users.length,
    total_orgs: seenOrgIds.size,
    total_memberships: membershipCount,
    total_workspaces: totalWorkspaces,
    total_integrations: totalIntegrations,
    orphaned_users: orphanedUsers,
  };
}

export async function adminGetAllThreads(context: AppLoadContext): Promise<AdminThreadWithContext[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);
  const threads: AdminThreadWithContext[] = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const [info, orgThreads, workspaces] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.getOrgThreads(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
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

export async function adminGetAppCount(context: AppLoadContext): Promise<number> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);
  let count = 0;

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const scripts = await authDO.listWorkerScripts(authEnv, orgId);
        count += scripts.length;
      } catch {
        // Org may not exist
      }
    })
  );

  return count;
}

// Paginated admin functions
export async function adminGetUsersPaginated(
  context: AppLoadContext,
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminUserSummary>> {
  const overview = await getAdminOverview(context);
  const { offset = 0, limit = 50, search } = params;

  let items = overview.users;

  // Apply search filter
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(
      (u) =>
        u.email.toLowerCase().includes(lowerSearch) ||
        u.name?.toLowerCase().includes(lowerSearch)
    );
  }

  // Sort by created_at descending
  items.sort((a, b) => b.created_at - a.created_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

export async function adminGetOrgsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {}
): Promise<PaginatedResult<Organization & { member_count: number; workspace_count: number }>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);
  const { offset = 0, limit = 50, search } = params;

  const orgs: Array<Organization & { member_count: number; workspace_count: number }> = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const [info, members, workspaces] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.getOrgMembers(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
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

  // Apply search filter
  let items = orgs;
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter((o) => o.name.toLowerCase().includes(lowerSearch));
  }

  // Sort by created_at descending
  items.sort((a, b) => b.created_at - a.created_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

export async function adminGetWorkspacesPaginated(
  context: AppLoadContext,
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminWorkspaceSummary>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);
  const { offset = 0, limit = 50, search } = params;

  // Maps for counts
  const threadCountByWorkspace = new Map<string, number>();
  const integrationCountByWorkspace = new Map<string, number>();

  // First pass: collect workspaces and counts
  const entries: Array<{
    workspace: Awaited<ReturnType<typeof authDO.listOrgWorkspaces>>[0];
    org_id: string;
    org_name: string;
  }> = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const [orgInfo, orgWorkspaces, threads] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          authDO.getOrgThreads(authEnv, orgId),
        ]);

        if (orgInfo) {
          // Count threads by workspace
          for (const thread of threads) {
            const count = threadCountByWorkspace.get(thread.workspace_id) ?? 0;
            threadCountByWorkspace.set(thread.workspace_id, count + 1);
          }

          for (const ws of orgWorkspaces) {
            entries.push({
              workspace: ws,
              org_id: orgId,
              org_name: orgInfo.name,
            });
          }
        }
      } catch {
        // Org may not exist
      }
    })
  );

  // Fetch integration counts for each workspace
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const integrations = await authDO.listWorkspaceIntegrations(authEnv, entry.workspace.id);
        integrationCountByWorkspace.set(entry.workspace.id, integrations.length);
      } catch {
        integrationCountByWorkspace.set(entry.workspace.id, 0);
      }
    })
  );

  // Build final workspace list
  const workspaces: AdminWorkspaceSummary[] = entries.map((entry) => ({
    ...entry.workspace,
    org_id: entry.org_id,
    org_name: entry.org_name,
    thread_count: threadCountByWorkspace.get(entry.workspace.id) ?? 0,
    integration_count: integrationCountByWorkspace.get(entry.workspace.id) ?? 0,
  }));

  // Apply search filter
  let items = workspaces;
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(
      (w) =>
        w.name.toLowerCase().includes(lowerSearch) ||
        w.org_name.toLowerCase().includes(lowerSearch)
    );
  }

  // Sort by created_at descending
  items.sort((a, b) => b.created_at - a.created_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

export async function adminGetThreadsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminThreadWithContext>> {
  const threads = await adminGetAllThreads(context);
  const { offset = 0, limit = 50, search } = params;

  // Apply search filter
  let items = threads;
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(
      (t) =>
        t.title?.toLowerCase().includes(lowerSearch) ||
        t.org_name.toLowerCase().includes(lowerSearch) ||
        t.workspace_name.toLowerCase().includes(lowerSearch)
    );
  }

  // Sort by updated_at descending
  items.sort((a, b) => b.updated_at - a.updated_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

export async function adminGetAppsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminAppSummary>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);
  const { offset = 0, limit = 50, search } = params;

  // First pass: collect all scripts with org/workspace info
  const entries: Array<{
    script: Awaited<ReturnType<typeof authDO.listWorkerScripts>>[0];
    org_id: string;
    org_name: string;
    workspace_name: string;
  }> = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const [orgInfo, scripts, workspaces] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listWorkerScripts(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
        ]);

        if (orgInfo) {
          const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));
          for (const script of scripts) {
            entries.push({
              script,
              org_id: orgId,
              org_name: orgInfo.name,
              workspace_name: workspaceMap.get(script.workspace_id) || 'unknown',
            });
          }
        }
      } catch {
        // Org may not exist
      }
    })
  );

  // Batch fetch creator info
  const creatorIds = [...new Set(entries.map((e) => e.script.created_by).filter(Boolean))];
  const creators = await authDO.getUsersByIds(authEnv, creatorIds);
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  // Build final app list with creator info
  const apps: AdminAppSummary[] = entries.map((entry) => {
    const creator = creatorMap.get(entry.script.created_by);
    return {
      script_name: entry.script.script_name,
      org_id: entry.org_id,
      org_name: entry.org_name,
      workspace_id: entry.script.workspace_id,
      workspace_name: entry.workspace_name,
      created_by: entry.script.created_by,
      created_by_name: creator?.name ?? null,
      created_by_email: creator?.email ?? null,
      created_at: entry.script.created_at,
      updated_at: entry.script.updated_at,
      is_public: entry.script.is_public,
      preview_status: entry.script.preview_status,
      preview_error: entry.script.preview_error,
    };
  });

  // Apply search filter (include creator info in search)
  let items = apps;
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter((a) =>
      [a.script_name, a.org_name, a.workspace_name, a.created_by_name ?? '', a.created_by_email ?? '']
        .join(' ')
        .toLowerCase()
        .includes(lowerSearch)
    );
  }

  // Sort by updated_at descending
  items.sort((a, b) => b.updated_at - a.updated_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

export async function adminGetInvitationsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminInvitation>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);
  const { offset = 0, limit = 50, search } = params;

  // First pass: collect all invitations with org info
  const entries: Array<{
    inv: Awaited<ReturnType<typeof authDO.getOrgInvitations>>[0];
    org_id: string;
    org_name: string;
  }> = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const [orgInfo, orgInvitations] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.getOrgInvitations(authEnv, orgId),
        ]);

        if (orgInfo) {
          for (const inv of orgInvitations) {
            entries.push({
              inv,
              org_id: orgId,
              org_name: orgInfo.name,
            });
          }
        }
      } catch {
        // Org may not exist
      }
    })
  );

  // Batch fetch inviter info
  const inviterIds = [...new Set(entries.map((e) => e.inv.invited_by).filter(Boolean))];
  const inviters = await authDO.getUsersByIds(authEnv, inviterIds);
  const inviterMap = new Map(inviters.map((u) => [u.id, u]));

  // Build final invitation list with inviter info
  const invitations: AdminInvitation[] = entries.map((entry) => {
    const inviter = inviterMap.get(entry.inv.invited_by);
    return {
      ...entry.inv,
      org_id: entry.org_id,
      org_name: entry.org_name,
      inviter_email: inviter?.email ?? entry.inv.invited_by,
      inviter_name: inviter?.name ?? null,
    };
  });

  // Apply search filter
  let items = invitations;
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(
      (i) =>
        i.email.toLowerCase().includes(lowerSearch) ||
        i.org_name.toLowerCase().includes(lowerSearch) ||
        (i.inviter_email?.toLowerCase().includes(lowerSearch)) ||
        (i.inviter_name?.toLowerCase().includes(lowerSearch))
    );
  }

  // Sort by created_at descending
  items.sort((a, b) => b.created_at - a.created_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

// Admin detail functions
export async function adminGetThreadWithMessages(
  context: AppLoadContext,
  threadId: string
): Promise<{
  thread: { id: string; title: string; created_by: string; created_at: number; updated_at: number };
  messages: Message[];
  org_id: string;
  workspace_id: string;
  org_name: string;
  workspace_name: string;
  preview_workers: string[];
} | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);

  for (const orgId of orgIds) {
    try {
      const thread = await authDO.getOrgThread(authEnv, orgId, threadId);
      if (thread) {
        const [orgInfo, workspaces, messages, preview_workers] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          getThreadMessages(context, threadId, thread.workspace_id),
          getThreadPreview(context, threadId),
        ]);

        const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

        return {
          thread: {
            id: thread.id,
            title: thread.title || 'Untitled',
            created_by: thread.created_by,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
          },
          messages,
          org_id: orgId,
          workspace_id: thread.workspace_id,
          org_name: orgInfo?.name || 'Unknown',
          workspace_name: workspaceMap.get(thread.workspace_id) || 'Unknown',
          preview_workers,
        };
      }
    } catch {
      // Continue searching
    }
  }

  return null;
}

export async function adminGetWorkspaceDetail(
  context: AppLoadContext,
  workspaceId: string
): Promise<AdminWorkspaceDetail | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const workspace = await authDO.getWorkspace(authEnv, workspaceId);
  if (!workspace) return null;

  const [org, orgThreads, integrations, members] = await Promise.all([
    authDO.getOrg(authEnv, workspace.org_id),
    authDO.getOrgThreads(authEnv, workspace.org_id),
    authDO.listWorkspaceIntegrations(authEnv, workspaceId),
    authDO.listWorkspaceMembers(authEnv, workspaceId),
  ]);

  if (!org) return null;

  // Filter threads to this workspace and map to Thread type
  const threads = orgThreads
    .filter((t) => t.workspace_id === workspaceId)
    .map((t) => ({
      id: t.id,
      workspace_id: t.workspace_id,
      title: t.title,
      created_by: t.created_by,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

  return {
    workspace,
    org,
    threads,
    integrations,
    members,
  };
}

export async function adminGetAppDetail(
  context: AppLoadContext,
  scriptName: string
): Promise<AdminAppDetail | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);

  for (const orgId of orgIds) {
    try {
      const scripts = await authDO.listWorkerScripts(authEnv, orgId);
      const script = scripts.find((s) => s.script_name === scriptName);

      if (script) {
        const [orgInfo, workspaces, creator] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          authDO.getUserById(authEnv, script.created_by),
        ]);

        const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

        return {
          ...script,
          org_id: orgId,
          org_name: orgInfo?.name || 'Unknown',
          workspace_name: workspaceMap.get(script.workspace_id) || 'Unknown',
          created_by_name: creator?.name ?? null,
          created_by_email: creator?.email ?? null,
        };
      }
    } catch {
      // Continue searching
    }
  }

  return null;
}

// User functions
export async function getUserById(context: AppLoadContext, userId: string): Promise<UserProfile | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getUserById(authEnv, userId);
}

export async function getUsersByIds(context: AppLoadContext, userIds: string[]): Promise<UserProfile[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getUsersByIds(authEnv, userIds);
}

export async function getUserOrgs(context: AppLoadContext, userId: string): Promise<OrgMembership[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getUserOrgs(authEnv, userId);
}

export async function listUserWorkspaces(
  context: AppLoadContext,
  userId: string,
  orgId: string
): Promise<WorkspaceWithAccess[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.listUserWorkspaces(authEnv, userId, orgId);
}

export async function listUserWorkspacesAcrossOrgs(
  context: AppLoadContext,
  userId: string,
  orgs?: OrgMembership[]
): Promise<WorkspaceWithAccess[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.listUserWorkspacesAcrossOrgs(authEnv, userId, orgs);
}

// Organization functions
export async function getOrg(context: AppLoadContext, orgId: string): Promise<Organization | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrg(authEnv, orgId);
}

export async function getOrgMembers(
  context: AppLoadContext,
  orgId: string
): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrgMembers(authEnv, orgId);
}

export async function getOrgInvitations(
  context: AppLoadContext,
  orgId: string
): Promise<Array<{
  id: string;
  email: string;
  role: OrgRole;
  created_at: number;
  expires_at: number;
}>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrgInvitations(authEnv, orgId);
}

export async function getOrgAuditLog(
  context: AppLoadContext,
  orgId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrgAuditLog(authEnv, orgId, limit, offset);
}

export async function getWorkspaceAuditLog(
  context: AppLoadContext,
  workspaceId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getWorkspaceAuditLog(authEnv, workspaceId, limit, offset);
}

// Admin container reset functions
export async function resetAdminOrgContainers(
  context: AppLoadContext,
  orgId: string
): Promise<{ restarted: number; failed: number }> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const containerEnv = env as unknown as WorkspaceContainerEnv;

  // Get all workspaces for this org
  const workspaces = await authDO.listOrgWorkspaces(authEnv, orgId);

  let restarted = 0;
  let failed = 0;

  // Reset each workspace's container
  for (const workspace of workspaces) {
    try {
      const container = getWorkspaceContainer(containerEnv, workspace.id);
      await container.destroy();
      restarted++;
    } catch (error) {
      console.error(`Failed to reset container for workspace ${workspace.id}:`, error);
      failed++;
    }
  }

  return { restarted, failed };
}

export async function resetAdminWorkspaceContainer(
  context: AppLoadContext,
  workspaceId: string
): Promise<{ success: boolean; containerId: string }> {
  const env = getEnv(context);
  const containerEnv = env as unknown as WorkspaceContainerEnv;

  const container = getWorkspaceContainer(containerEnv, workspaceId);
  await container.destroy();

  return { success: true, containerId: workspaceId };
}

// Admin org member functions
export async function addAdminOrgMember(
  context: AppLoadContext,
  orgId: string,
  userId: string,
  role: 'admin' | 'member'
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  // Use a system actor ID for admin operations
  const actorId = 'system-admin';
  await authDO.adminAddOrgMember(authEnv, orgId, userId, role, actorId);
}

export async function updateAdminOrgMemberRole(
  context: AppLoadContext,
  orgId: string,
  userId: string,
  role: OrgRole
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  // Use a system actor ID for admin operations
  const actorId = 'system-admin';
  await authDO.updateOrgMemberRole(authEnv, orgId, userId, role, actorId);
}

