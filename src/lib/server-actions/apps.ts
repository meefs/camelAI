'use server';

import * as authDO from '@/lib/auth-do';
import { getUserByIdCached } from '@/lib/auth-context';
import type { AppCreator, WorkerScript, WorkerScriptWithCreator } from '@/types';
import { requireOrgAdmin, requireOrgMember } from '@/lib/server-guards';

function toSafeWorkerScript(script: authDO.WorkerScript): WorkerScript {
  return {
    script_name: script.script_name,
    workspace_id: script.workspace_id,
    created_by: script.created_by,
    created_at: script.created_at,
    updated_at: script.updated_at,
    is_public: script.is_public,
    preview_key: script.preview_key,
    preview_updated_at: script.preview_updated_at,
    preview_status: script.preview_status,
    preview_error: script.preview_error,
  };
}

type CachedProfile = NonNullable<Awaited<ReturnType<typeof getUserByIdCached>>>;

function toCreator(profile: CachedProfile): AppCreator {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    avatar: {
      color: profile.avatar_color,
      content: profile.avatar_content,
    },
  };
}

async function hydrateScripts(scripts: authDO.WorkerScript[]): Promise<WorkerScriptWithCreator[]> {
  const safeScripts = scripts.map(toSafeWorkerScript);
  const creatorIds = Array.from(
    new Set(
      safeScripts
        .map((script) => script.created_by)
        .filter((id) => Boolean(id))
    )
  ) as string[];
  const creatorEntries = await Promise.all(
    creatorIds.map(async (id) => [id, await getUserByIdCached(id)] as const)
  );
  const creatorMap = new Map<string, AppCreator>();
  for (const [id, creator] of creatorEntries) {
    if (creator) creatorMap.set(id, toCreator(creator));
  }
  return safeScripts.map((script) => ({
    ...script,
    creator: creatorMap.get(script.created_by),
  }));
}

async function requireWorkspaceId(orgId: string) {
  const session = await requireOrgMember(orgId, 'You must be a member of this organization');
  const workspaceId = session.workspace_id;
  if (!workspaceId) {
    throw new Error('No workspace selected');
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
  if (access === 'none') {
    throw new Error('Workspace not found');
  }
  return { session, workspaceId };
}

export async function getOrgApps(orgId: string): Promise<WorkerScriptWithCreator[]> {
  const { workspaceId } = await requireWorkspaceId(orgId);
  const scripts = await authDO.listWorkerScripts(orgId);
  const filtered = scripts.filter((script) => script.workspace_id === workspaceId);
  return hydrateScripts(filtered);
}

export async function getOrgAppsAllWorkspaces(
  orgId: string
): Promise<WorkerScriptWithCreator[]> {
  const session = await requireOrgMember(orgId, 'You must be a member of this organization');
  const workspaces = await authDO.listUserWorkspaces(session.user_id, orgId);
  const accessibleIds = workspaces
    .filter((workspace) => workspace.access_level !== 'none')
    .map((workspace) => workspace.id);

  if (accessibleIds.length === 0) {
    return [];
  }

  const scripts = await authDO.listWorkerScripts(orgId);
  const allowedIds = new Set(accessibleIds);
  const filtered = scripts.filter((script) => allowedIds.has(script.workspace_id));
  return hydrateScripts(filtered);
}

export async function setAppPublic(
  orgId: string,
  scriptName: string,
  isPublic: boolean
): Promise<WorkerScript> {
  const session = await requireOrgAdmin(orgId, 'Only admins can change app visibility');

  const script = await authDO.setWorkerScriptPublic(orgId, scriptName, isPublic, session.user_id);
  if (!script) {
    throw new Error('App not found');
  }
  return toSafeWorkerScript(script);
}

export async function deleteApp(orgId: string, scriptName: string): Promise<void> {
  const session = await requireOrgAdmin(orgId, 'Only admins can delete apps');

  const success = await authDO.deleteWorkerScript(orgId, scriptName, session.user_id);
  if (!success) {
    throw new Error('App not found or could not be deleted');
  }
}
