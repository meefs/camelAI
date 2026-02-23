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
  PreviewTarget,
} from '@/types';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import { type AuthEnv, getAuthEnv } from './auth-helpers';
import * as authDO from './auth-do';
import { getMessages as getThreadMessages, getThreadPreviewTarget } from './chat-do.server';
import { deleteDispatchScript } from '../../workers/main/src/cf-api-proxy';

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

const SCRIPT_PREFIX = 'script:';
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';
const SPEND_PREFIX = 'spend:';
const API_TOKEN_PREFIX = 'tok_';
const SESSION_PREFIX = 'session:';
const WORKER_SESSION_PREFIX = 'worker_session:';
const SCREENSHOT_SESSION_PREFIX = 'screenshot_session:';
const SCREENSHOT_TOKEN_PREFIX = 'screenshot_token:';
const WORKER_AUTH_STATE_PREFIX = 'wauth_state:';
const WORKER_AUTH_TOKEN_PREFIX = 'wauth_token:';
const PREVIEW_PREFIX = 'app-previews/';

function parseJsonSafely(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function sanitizeStorageName(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20) || 'x';
}

function isMissingRpcMethodError(error: unknown, methodName: string): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes(`does not implement "${methodName}"`)
  );
}

async function deleteKvEntriesWithPrefix(
  kv: KVNamespace,
  prefix: string,
  shouldDelete: (key: string, value: string | null) => boolean
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  while (true) {
    const listed = await kv.list({ prefix, cursor });
    const keys = listed.keys.map((entry) => entry.name);
    if (keys.length > 0) {
      const values = await Promise.all(keys.map((key) => kv.get(key)));
      const keysToDelete: string[] = [];

      for (let index = 0; index < keys.length; index += 1) {
        if (shouldDelete(keys[index], values[index])) {
          keysToDelete.push(keys[index]);
        }
      }

      await Promise.all(keysToDelete.map((key) => kv.delete(key)));
      deleted += keysToDelete.length;
    }

    if (listed.list_complete || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  while (true) {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await Promise.all(listed.objects.map((obj) => bucket.delete(obj.key)));
      deleted += listed.objects.length;
    }

    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
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
          authEnv.USER.get(authEnv.USER.idFromName(userId)).getProfile(),
          authDO.getUserOrgs(authEnv, userId),
        ]);

        if (profile) {
          const isOrphaned = profile.is_orphaned || false;
          if (isOrphaned) orphanedUsers++;

          users.push({
            id: profile.id,
            email: profile.email,
            name: profile.name,
            avatar: profile.avatar || { color: '#666', content: profile.email[0].toUpperCase() },
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
          authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).getThreads(),
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
        const scripts = await authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).listWorkerScripts();
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
          authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).getThreads(),
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
    script: authDO.WorkerScript;
    org_id: string;
    org_name: string;
    workspace_name: string;
  }> = [];

  await Promise.all(
    Array.from(orgIds).map(async (orgId) => {
      try {
        const [orgInfo, scripts, workspaces] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).listWorkerScripts(),
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
  thread: { id: string; title: string; created_by: string; created_at: number; updated_at: number; source: 'web' | 'slack' };
  messages: Message[];
  org_id: string;
  workspace_id: string;
  org_name: string;
  workspace_name: string;
  preview_target: PreviewTarget | null;
} | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);

  for (const orgId of orgIds) {
    try {
      const thread = await authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).getThread(threadId);
      if (thread) {
        const [orgInfo, workspaces, messages, preview_target] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          getThreadMessages(context, threadId, thread.workspace_id),
          getThreadPreviewTarget(context, threadId),
        ]);

        const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

        return {
          thread: {
            id: thread.id,
            title: thread.title || 'Untitled',
            created_by: thread.created_by,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            source: thread.source ?? 'web',
          },
          messages,
          org_id: orgId,
          workspace_id: thread.workspace_id,
          org_name: orgInfo?.name || 'Unknown',
          workspace_name: workspaceMap.get(thread.workspace_id) || 'Unknown',
          preview_target,
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
    authEnv.ORG.get(authEnv.ORG.idFromName(workspace.org_id)).getThreads(),
    authDO.listWorkspaceIntegrations(authEnv, workspaceId),
    authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId)).listMembers(),
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
      source: t.source ?? 'web',
      user_message_count: t.user_message_count ?? 0,
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
      const scripts = await authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).listWorkerScripts();
      const script = scripts.find((s) => s.script_name === scriptName);

      if (script) {
        const [orgInfo, workspaces, creator] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          authEnv.USER.get(authEnv.USER.idFromName(script.created_by)).getProfile(),
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

export interface AdminHardDeleteOrgResult {
  deleted_workspaces: number;
  deleted_apps: number;
  removed_memberships: number;
  warnings: string[];
}

/**
 * Permanently delete an organization and all related records.
 * This is superuser-only and intended for test account resets.
 */
export async function hardDeleteAdminOrg(
  context: AppLoadContext,
  orgId: string,
  actorId = 'system-admin'
): Promise<AdminHardDeleteOrgResult> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const warnings: string[] = [];

  const [orgInfo, workspaceRows, workerScripts] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getWorkspaces(),
    orgStub.listWorkerScripts(),
  ]);

  if (!orgInfo) {
    throw new Error('Organization not found');
  }

  const workspaceIdSet = new Set(workspaceRows.map((workspace) => workspace.id));
  for (const script of workerScripts) {
    workspaceIdSet.add(script.workspace_id);
  }
  const workspaceIds = Array.from(workspaceIdSet);
  const scriptNames = workerScripts.map((script) => script.script_name);

  // Delete deployed dispatch scripts first to avoid orphaned public apps.
  if (scriptNames.length > 0) {
    const accountId = env.CF_ACCOUNT_ID;
    const dispatchNamespace = env.CF_DISPATCH_NAMESPACE;
    const apiToken = env.CF_API_TOKEN;

    if (!accountId || !dispatchNamespace || !apiToken) {
      throw new Error('Cannot delete org with deployed apps: missing Cloudflare dispatch credentials');
    }

    const failedDeletes: string[] = [];
    await Promise.all(
      scriptNames.map(async (scriptName) => {
        const candidateScriptNames = new Set<string>([
          `${orgInfo.slug}--${scriptName}`,
          scriptName,
        ]);

        for (const candidateScriptName of candidateScriptNames) {
          const ok = await deleteDispatchScript(
            accountId,
            dispatchNamespace,
            candidateScriptName,
            apiToken
          );
          if (!ok) {
            failedDeletes.push(candidateScriptName);
          }
        }
      })
    );

    if (failedDeletes.length > 0) {
      throw new Error(
        `Failed to delete ${failedDeletes.length} dispatch script(s): ${failedDeletes.slice(0, 3).join(', ')}`
      );
    }
  }

  // Hard-delete each workspace Durable Object.
  for (const workspaceId of workspaceIds) {
    const workspaceStub = authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId));
    try {
      await workspaceStub.hardDeleteWorkspace(actorId);
    } catch (error) {
      if (isMissingRpcMethodError(error, 'hardDeleteWorkspace')) {
        throw new Error(
          'Workspace Durable Object is running old code (missing hardDeleteWorkspace). Restart `bun run dev` or deploy the latest main worker, then retry delete.'
        );
      }
      throw error;
    }
  }

  // Remove org memberships from all users to prevent stale user->org links.
  const allUserIds = await collectAllUserIds(env);
  const membershipResults = await Promise.all(
    allUserIds.map(async (userId) => {
      const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
      const hasOrg = await userStub.hasOrg(orgId);
      if (!hasOrg) return false;

      await userStub.removeOrg(orgId);

      const remainingOrgs = await userStub.getOrgs();
      const isOrphaned = remainingOrgs.length === 0;
      await userStub.setOrphaned(isOrphaned);

      // For test-account reset flows, clear onboarding when a user has no orgs left.
      if (isOrphaned) {
        try {
          await authDO.resetOnboardingForUser(authEnv, userId);
        } catch (error) {
          warnings.push(
            `Failed to reset onboarding for user ${userId.slice(0, 8)}: ${toErrorMessage(error)}`
          );
        }
      }

      return true;
    })
  );
  const removedMemberships = membershipResults.filter(Boolean).length;

  // Finally, wipe org DO state and release slug ownership.
  try {
    await orgStub.hardDeleteOrg(actorId);
  } catch (error) {
    if (isMissingRpcMethodError(error, 'hardDeleteOrg')) {
      throw new Error(
        'Organization Durable Object is running old code (missing hardDeleteOrg). Restart `bun run dev` or deploy the latest main worker, then retry delete.'
      );
    }
    throw error;
  }

  // Best-effort cleanup of related KV indexes and sessions.
  const dispatchNames = scriptNames.map((scriptName) => `${orgInfo.slug}--${scriptName}`);
  await Promise.all([
    authEnv.APP_KV.delete(`${SPEND_PREFIX}${orgId}`),
    ...dispatchNames.map((dispatchName) => authEnv.APP_KV.delete(`${SCRIPT_PREFIX}${dispatchName}`)),
    ...scriptNames.map((scriptName) => authEnv.APP_KV.delete(`${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`)),
  ]);

  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, SCRIPT_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean script ownership index: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, SCRIPT_ORG_PREFIX_LEGACY, (_key, value) => {
      if (!value) return false;
      if (value === orgId) return true;
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean legacy script index: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, API_TOKEN_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean API tokens: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, SCREENSHOT_TOKEN_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean screenshot tokens: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, WORKER_AUTH_STATE_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.required_org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean worker auth state: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, WORKER_AUTH_TOKEN_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean worker auth tokens: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.SESSIONS, SESSION_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean user sessions: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.SESSIONS, WORKER_SESSION_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean worker sessions: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(authEnv.SESSIONS, SCREENSHOT_SESSION_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.org_id === orgId;
    });
  } catch (error) {
    warnings.push(`Failed to clean screenshot sessions: ${toErrorMessage(error)}`);
  }

  // Best-effort cleanup of R2 artifacts (uploads/outputs/previews/workspace storage).
  try {
    await deleteR2Prefix(env.R2_BUCKET, `${PREVIEW_PREFIX}${orgId}/`);
  } catch (error) {
    warnings.push(`Failed to clean app previews in R2: ${toErrorMessage(error)}`);
  }

  try {
    await deleteR2Prefix(env.R2_BUCKET, `${orgId}/`);
  } catch (error) {
    warnings.push(`Failed to clean workspace uploads/outputs in R2: ${toErrorMessage(error)}`);
  }

  try {
    const orgSafe = sanitizeStorageName(orgId);
    for (const workspaceId of workspaceIds) {
      const wsSafe = sanitizeStorageName(workspaceId);
      await deleteR2Prefix(env.R2_BUCKET, `chiridion-${orgSafe}-${wsSafe}/`);
    }
  } catch (error) {
    warnings.push(`Failed to clean workspace storage in R2: ${toErrorMessage(error)}`);
  }

  return {
    deleted_workspaces: workspaceIds.length,
    deleted_apps: scriptNames.length,
    removed_memberships: removedMemberships,
    warnings,
  };
}

// User hard delete
// ---------------------------------------------------------------------------

export interface AdminHardDeleteUserResult {
  removed_org_memberships: number;
  warnings: string[];
}

/**
 * Permanently delete a user and all related records.
 * This is superuser-only and intended for test account cleanup.
 *
 * Steps:
 *  1. Fetch user profile + OAuth providers for cleanup key discovery.
 *  2. Fail early if the user still owns any organizations.
 *  3. Remove user from every org (must fully succeed before deletion continues).
 *  4. Wipe the UserDO Durable Object storage (with version-skew guard).
 *  5. Delete EMAIL_TO_USER KV entries (email + oauth provider keys).
 *  6. Delete user sessions from SESSIONS KV.
 *  7. Delete user-scoped worker auth one-time tokens from APP_KV.
 */
export async function hardDeleteAdminUser(
  context: AppLoadContext,
  userId: string,
  actorId = 'system-admin'
): Promise<AdminHardDeleteUserResult> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const warnings: string[] = [];

  // 1. Fetch user data for cleanup keys.
  const [profile, oauthProviders, orgs] = await Promise.all([
    userStub.getProfile(),
    userStub.getOAuthProviders(),
    userStub.getOrgs(),
  ]);

  if (!profile) {
    throw new Error('User not found');
  }

  // 2. Fail early if the user owns any orgs — removing an owner via
  //    removeMember throws, and proceeding would leave a dangling owner
  //    reference in the OrgDO after the UserDO is wiped.
  const ownedOrgIds = orgs.filter((o) => o.role === 'owner').map((o) => o.org_id);
  if (ownedOrgIds.length > 0) {
    const preview = ownedOrgIds.slice(0, 3).map((id) => id.slice(0, 8)).join(', ');
    const suffix = ownedOrgIds.length > 3 ? ` and ${ownedOrgIds.length - 3} more` : '';
    throw new Error(
      `User owns ${ownedOrgIds.length} org(s) (${preview}${suffix}). Transfer ownership or delete those orgs before deleting this user.`
    );
  }

  // 3. Remove user from all orgs first. If any membership cleanup fails,
  // stop before wiping the user record to avoid orphaned org membership rows.
  let removedOrgMemberships = 0;
  const orgRemovalErrors: string[] = [];
  for (const org of orgs) {
    try {
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.org_id));
      await orgStub.removeMember(userId, actorId);
      removedOrgMemberships++;
    } catch (error) {
      orgRemovalErrors.push(
        `${org.org_id.slice(0, 8)}: ${toErrorMessage(error)}`
      );
    }
  }
  if (orgRemovalErrors.length > 0) {
    const preview = orgRemovalErrors.slice(0, 3).join('; ');
    const suffix = orgRemovalErrors.length > 3 ? `; and ${orgRemovalErrors.length - 3} more` : '';
    throw new Error(
      `Failed to remove user from ${orgRemovalErrors.length} org(s) (${preview}${suffix}). User was not deleted. Resolve membership cleanup and retry.`
    );
  }

  // 4. Wipe UserDO state. Do this before external KV cleanup so
  // missing-RPC/version-skew errors do not partially de-index auth keys.
  try {
    await userStub.hardDeleteUser();
  } catch (error) {
    if (isMissingRpcMethodError(error, 'hardDeleteUser')) {
      throw new Error(
        'User Durable Object is running old code (missing hardDeleteUser). Restart `bun run dev` or deploy the latest main worker, then retry delete.'
      );
    }
    throw error;
  }

  // 5. Delete EMAIL_TO_USER KV entries.
  const kvKeysToDelete: string[] = [
    `email:${profile.email.toLowerCase()}`,
  ];
  for (const provider of oauthProviders) {
    kvKeysToDelete.push(`oauth:${provider.provider}:${provider.provider_id}`);
  }
  await Promise.all(
    kvKeysToDelete.map(async (key) => {
      try {
        await authEnv.EMAIL_TO_USER.delete(key);
      } catch (error) {
        warnings.push(`Failed to delete EMAIL_TO_USER key "${key}": ${toErrorMessage(error)}`);
      }
    })
  );

  // 6. Best-effort cleanup of all user sessions (regular, worker, screenshot).
  const sessionPrefixes = [SESSION_PREFIX, WORKER_SESSION_PREFIX, SCREENSHOT_SESSION_PREFIX] as const;
  for (const prefix of sessionPrefixes) {
    try {
      await deleteKvEntriesWithPrefix(authEnv.SESSIONS, prefix, (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.user_id === userId;
      });
    } catch (error) {
      warnings.push(`Failed to clean ${prefix}* sessions: ${toErrorMessage(error)}`);
    }
  }

  // 7. Best-effort cleanup of pending worker auth tokens to prevent
  // post-delete token exchange into fresh worker sessions.
  try {
    await deleteKvEntriesWithPrefix(authEnv.APP_KV, WORKER_AUTH_TOKEN_PREFIX, (_key, value) => {
      const parsed = parseJsonSafely(value);
      return parsed?.user_id === userId;
    });
  } catch (error) {
    warnings.push(`Failed to clean worker auth tokens: ${toErrorMessage(error)}`);
  }

  return {
    removed_org_memberships: removedOrgMemberships,
    warnings,
  };
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
