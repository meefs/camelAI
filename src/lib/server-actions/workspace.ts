"use server"

import * as authDO from "@/lib/auth-do"
import { validateAvatarContent } from "@/lib/avatar"
import { getSessionContext } from "@/lib/auth-context"
import { requireSession } from "@/lib/server-guards"
import type { Workspace, WorkspaceAccessLevel, WorkspaceWithAccess, AuditLogEntry } from "@/types"

function toSafeWorkspace(workspace: Workspace) {
  // JSON round-trip ensures nested objects (like avatar) are plain objects for RSC
  return JSON.parse(JSON.stringify({
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
  }))
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
  const sessionContext = await getSessionContext()
  if (!sessionContext) {
    throw new Error("Not logged in")
  }
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can archive workspaces")
  }

  const workspaces = await authDO.listOrgWorkspaces(session.org_id)
  const activeWorkspaces = workspaces.filter((entry) => entry.id !== workspaceId)
  if (activeWorkspaces.length === 0) {
    throw new Error("Cannot archive the only workspace in an organization")
  }

  const archived = await authDO.archiveWorkspace(workspaceId, session.user_id)
  if (!archived) {
    throw new Error("Workspace not found")
  }
  if (session.workspace_id === workspaceId) {
    const fallback = activeWorkspaces[0]
    if (fallback) {
      await authDO.switchSessionWorkspace(sessionContext.sessionId, fallback.id)
    }
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

export async function getWorkspaces(): Promise<WorkspaceWithAccess[]> {
  const session = await requireSession()
  const workspaces = await authDO.listUserWorkspaces(session.user_id, session.org_id)
  return workspaces.map((ws) => ({
    ...toSafeWorkspace(ws),
    access_level: ws.access_level,
  }))
}

export async function getWorkspace(workspaceId: string): Promise<WorkspaceWithAccess | null> {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    return null
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id)
  if (access === "none") {
    return null
  }
  return {
    ...toSafeWorkspace(workspace),
    access_level: access,
  }
}

export async function getWorkspaceMembers(workspaceId: string) {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id)
  if (access === "none") {
    throw new Error("Workspace not found")
  }
  const members = await authDO.listWorkspaceMembers(workspaceId)
  // Hydrate with user data
  const userIds = members.map((m) => m.user_id)
  const users = await authDO.getUsersByIds(userIds)
  const userMap = new Map(users.map((u) => [u.id, u]))

  return members.map((m) => {
    const user = userMap.get(m.user_id)
    return {
      user_id: m.user_id,
      access_level: m.access_level,
      granted_at: m.granted_at,
      granted_by: m.granted_by,
      user: user ? {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: { color: user.avatar_color, content: user.avatar_content },
      } : null,
    }
  })
}

export async function removeWorkspaceAccess(workspaceId: string, userId: string) {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }
  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can remove workspace access")
  }
  await authDO.setWorkspaceAccess(workspaceId, userId, "none", session.user_id)
  return { success: true }
}

export async function getWorkspaceAuditLog(
  workspaceId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }
  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can view audit logs")
  }
  return authDO.getWorkspaceAuditLog(workspaceId, limit, offset)
}

/**
 * Warm up a workspace container asynchronously.
 * This is a cheap, fire-and-forget call that triggers container startup
 * in the background without blocking.
 *
 * Returns:
 * - 'warm': Container is already healthy
 * - 'warming': Container startup triggered in background
 * - 'unauthorized': User doesn't have access
 */
export async function warmupWorkspace(
  workspaceId: string
): Promise<{ status: 'warm' | 'warming' | 'unauthorized' }> {
  const session = await requireSession()
  const result = await authDO.warmupWorkspace(workspaceId, session.user_id)
  // JSON round-trip ensures plain object for RSC serialization
  return { status: result.status }
}
