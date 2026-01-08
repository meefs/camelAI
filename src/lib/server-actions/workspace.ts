"use server"

import * as authDO from "@/lib/auth-do"
import { validateAvatarContent } from "@/lib/avatar"
import { requireSession } from "@/lib/server-guards"
import type { Workspace, WorkspaceAccessLevel } from "@/types"

function toSafeWorkspace(workspace: Workspace) {
  return {
    id: workspace.id,
    org_id: workspace.org_id,
    name: workspace.name,
    description: workspace.description,
    created_by: workspace.created_by,
    created_at: workspace.created_at,
    avatar: {
      color: workspace.avatar.color,
      content: workspace.avatar.content,
    },
    archived: workspace.archived,
    archived_at: workspace.archived_at,
  }
}

export async function createWorkspace(name: string, description?: string | null) {
  const session = await requireSession()

  const trimmed = name?.trim() ?? ""
  if (!trimmed) {
    throw new Error("Workspace name is required")
  }
  if (trimmed.length > 100) {
    throw new Error("Workspace name must be 100 characters or less")
  }

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can create workspaces")
  }

  const created = await authDO.createWorkspace(
    session.org_id,
    trimmed,
    session.user_id,
    description ?? null
  )
  return toSafeWorkspace(created)
}

export async function updateWorkspaceInfo(
  workspaceId: string,
  updates: {
    name?: string
    description?: string | null
    avatar?: { color: string; content: string }
  }
) {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can update workspaces")
  }

  if (updates.name && updates.name.length > 100) {
    throw new Error("Workspace name must be 100 characters or less")
  }

  if (updates.avatar && !validateAvatarContent(updates.avatar.content)) {
    throw new Error("Invalid avatar content")
  }

  const updated = await authDO.updateWorkspace(
    workspaceId,
    {
      name: updates.name?.trim(),
      description: updates.description ?? null,
      avatar: updates.avatar,
    },
    session.user_id
  )

  if (!updated) {
    throw new Error("Workspace not found")
  }

  return toSafeWorkspace(updated)
}

export async function archiveWorkspace(workspaceId: string) {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can archive workspaces")
  }

  const workspaces = await authDO.listOrgWorkspaces(session.org_id)
  const activeCount = workspaces.filter((entry) => !entry.archived).length
  if (activeCount <= 1) {
    throw new Error("Cannot archive the only workspace in an organization")
  }

  const archived = await authDO.archiveWorkspace(workspaceId, session.user_id)
  if (!archived) {
    throw new Error("Workspace not found")
  }
  return toSafeWorkspace(archived)
}

export async function setWorkspaceAccess(
  workspaceId: string,
  userId: string,
  accessLevel: WorkspaceAccessLevel
) {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can update workspace access")
  }

  const isMember = await authDO.isOrgMember(userId, session.org_id)
  if (!isMember) {
    throw new Error("User is not a member of this organization")
  }

  await authDO.setWorkspaceAccess(workspaceId, userId, accessLevel, session.user_id)
  return { success: true }
}
