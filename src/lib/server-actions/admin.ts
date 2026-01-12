'use server';

import * as authDO from '@/lib/auth-do';
import { validateAvatarContent } from '@/lib/avatar';
import { requireSuperuser } from '@/lib/server-guards';
import type { OrgRole } from '@/types';

export async function updateAdminUser(
  userId: string,
  updates: { name?: string | null; is_superuser?: boolean; avatar?: { color: string; content: string } }
) {
  await requireSuperuser('Forbidden');
  const trimmedName = updates.name === undefined || updates.name === null
    ? updates.name
    : updates.name.trim();
  if (typeof trimmedName === 'string' && trimmedName.length > 100) {
    throw new Error('Display name must be 100 characters or less');
  }
  if (updates.avatar && !validateAvatarContent(updates.avatar.content)) {
    throw new Error('Invalid avatar content');
  }
  const profile = await authDO.adminUpdateUser(userId, {
    name: trimmedName,
    is_superuser: updates.is_superuser,
    avatar: updates.avatar,
  });
  if (!profile) {
    throw new Error('User not found');
  }
  return profile;
}

export async function updateAdminOrg(orgId: string, updates: { name?: string }) {
  const { session } = await requireSuperuser('Forbidden');
  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (!trimmed) {
      throw new Error('Organization name is required');
    }
    if (trimmed.length > 100) {
      throw new Error('Organization name must be 100 characters or less');
    }
    await authDO.updateOrgName(orgId, trimmed, session.user_id);
  }
  const org = await authDO.getOrg(orgId);
  if (!org) {
    throw new Error('Organization not found');
  }
  return org;
}

export async function updateAdminOrgMemberRole(orgId: string, userId: string, role: OrgRole) {
  const { session } = await requireSuperuser('Forbidden');
  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }
  if (!['admin', 'member', 'viewer'].includes(role)) {
    throw new Error('Role must be "admin", "member", or "viewer"');
  }
  await authDO.updateOrgMemberRole(orgId, userId, role, session.user_id);
  return { success: true };
}

export async function transferAdminOrgOwnership(orgId: string, newOwnerId: string) {
  const { session } = await requireSuperuser('Forbidden');
  if (!newOwnerId || typeof newOwnerId !== 'string') {
    throw new Error('New owner ID is required');
  }
  await authDO.adminTransferOrgOwnership(orgId, newOwnerId, session.user_id);
  return { success: true };
}

export async function addAdminOrgMember(orgId: string, userId: string, role: 'admin' | 'member') {
  const { session } = await requireSuperuser('Forbidden');
  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }
  if (!['admin', 'member'].includes(role)) {
    throw new Error('Role must be "admin" or "member"');
  }
  await authDO.adminAddOrgMember(orgId, userId, role, session.user_id);
  return { success: true };
}

export async function archiveAdminOrg(orgId: string) {
  const { session } = await requireSuperuser('Forbidden');
  await authDO.archiveOrg(orgId, session.user_id);
  return { success: true };
}

export async function updateAdminThread(threadId: string, updates: { title?: string }) {
  await requireSuperuser('Forbidden');
  const thread = await authDO.adminUpdateThread(threadId, updates);
  if (!thread) {
    throw new Error('Thread not found');
  }
  return thread;
}

export async function updateAdminApp(
  orgId: string,
  scriptName: string,
  data: { is_public: boolean }
) {
  const { session } = await requireSuperuser('Forbidden');
  const updated = await authDO.adminSetAppPublic(orgId, scriptName, data.is_public, session.user_id);
  if (!updated) {
    throw new Error('App not found');
  }
  return updated;
}

export async function deleteAdminApp(orgId: string, scriptName: string) {
  const { session } = await requireSuperuser('Forbidden');
  const success = await authDO.adminDeleteApp(orgId, scriptName, session.user_id);
  if (!success) {
    throw new Error('App not found');
  }
  return { success: true };
}

export async function updateAdminWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } }
) {
  const { session } = await requireSuperuser('Forbidden');
  const trimmedName = updates.name?.trim();
  const trimmedDescription = updates.description?.trim() || null;
  if (trimmedName !== undefined && trimmedName.length === 0) {
    throw new Error('Workspace name is required');
  }
  if (trimmedName && trimmedName.length > 100) {
    throw new Error('Workspace name must be 100 characters or less');
  }
  if (trimmedDescription && trimmedDescription.length > 200) {
    throw new Error('Workspace description must be 200 characters or less');
  }
  if (updates.avatar && !validateAvatarContent(updates.avatar.content)) {
    throw new Error('Invalid avatar content');
  }

  const updated = await authDO.adminUpdateWorkspace(
    workspaceId,
    {
      name: trimmedName,
      description: trimmedDescription,
      avatar: updates.avatar,
    },
    session.user_id
  );
  if (!updated) {
    throw new Error('Workspace not found');
  }
  return updated;
}

export async function archiveAdminWorkspace(workspaceId: string) {
  const { session } = await requireSuperuser('Forbidden');
  const archived = await authDO.adminArchiveWorkspace(workspaceId, session.user_id);
  if (!archived) {
    throw new Error('Workspace not found');
  }
  return archived;
}

export async function resetAdminWorkspaceContainer(workspaceId: string) {
  await requireSuperuser('Forbidden');
  return authDO.resetWorkspaceContainer(workspaceId);
}

export async function resetAdminOrgContainers(orgId: string) {
  await requireSuperuser('Forbidden');
  const workspaces = await authDO.listOrgWorkspaces(orgId);
  const results = await Promise.all(
    workspaces.map((workspace) => authDO.resetWorkspaceContainer(workspace.id))
  );
  return {
    restarted: results.length,
    containers: results.map((result) => result.containerId),
  };
}

export async function forceAdminOrphanUser(userId: string) {
  const { session } = await requireSuperuser('Forbidden');
  await authDO.adminForceOrphanUser(userId, session.user_id);
  return { success: true };
}

export async function deleteAdminInvitation(orgId: string, invitationId: string) {
  await requireSuperuser('Forbidden');
  await authDO.adminDeleteInvitation(orgId, invitationId);
  return { success: true };
}
