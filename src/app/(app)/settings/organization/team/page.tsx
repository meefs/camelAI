import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"
import { TeamTable } from "@/components/settings/team-table"
import { requireAuthContextLite } from "@/lib/server-guards"
import * as authDO from "@/lib/auth-do"
import type { WorkspaceAccessLevel } from "@/types"

export default async function OrgTeamPage() {
  const authContext = await requireAuthContextLite()
  const orgId = authContext.currentOrg.id

  const [members, workspaces] = await Promise.all([
    authDO.getOrgMembers(orgId),
    authDO.listOrgWorkspaces(orgId),
  ])

  const activeWorkspaces = workspaces.filter((workspace) => !workspace.archived)
  const currentMember = members.find(
    (member) => member.user.id === authContext.user.id
  )
  const canManageMembers =
    currentMember?.role === "owner" || currentMember?.role === "admin"

  const invitations = canManageMembers
    ? await authDO.getOrgInvitations(orgId)
    : []

  const workspaceMembers = await Promise.all(
    activeWorkspaces.map(async (workspace) => ({
      workspaceId: workspace.id,
      members: await authDO.listWorkspaceMembers(workspace.id),
    }))
  )

  const accessByUser = new Map<string, Record<string, WorkspaceAccessLevel>>()
  for (const member of members) {
    const accessMap: Record<string, WorkspaceAccessLevel> = {}
    for (const workspace of activeWorkspaces) {
      accessMap[workspace.id] = "full"
    }
    accessByUser.set(member.user.id, accessMap)
  }

  for (const workspace of workspaceMembers) {
    for (const entry of workspace.members) {
      const accessMap = accessByUser.get(entry.user_id)
      if (!accessMap) continue
      accessMap[workspace.workspaceId] = entry.access_level
    }
  }

  const safeMembersWithAccess = members.map((member) => ({
    user: {
      id: member.user.id,
      email: member.user.email,
      name: member.user.name,
      created_at: member.user.created_at,
      is_superuser: member.user.is_superuser,
      avatar: {
        color: member.user.avatar.color,
        content: member.user.avatar.content,
      },
      is_orphaned: member.user.is_orphaned,
    },
    role: member.role,
    joined_at: member.joined_at,
    workspaceAccess: accessByUser.get(member.user.id) ?? {},
  }))
  const safeInvitations = invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    created_at: invitation.created_at,
    expires_at: invitation.expires_at,
  }))
  const safeWorkspaces = activeWorkspaces.map((workspace) => ({
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

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Team"
        description="Manage members, invitations, and workspace access."
      />
      <Separator />
      <TeamTable
        orgId={orgId}
        currentUserId={authContext.user.id}
        canManageMembers={canManageMembers}
        members={safeMembersWithAccess}
        invitations={safeInvitations}
        workspaces={safeWorkspaces}
      />
    </div>
  )
}
