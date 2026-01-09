import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"
import { WorkspacesList } from "@/components/settings/workspaces-list"
import { requireAuthContextLite } from "@/lib/server-guards"
import * as authDO from "@/lib/auth-do"

export default async function OrgWorkspacesPage() {
  const authContext = await requireAuthContextLite()
  const orgId = authContext.currentOrg.id

  const [workspaces, isAdmin] = await Promise.all([
    authDO.listOrgWorkspaces(orgId),
    authDO.isOrgAdmin(authContext.user.id, orgId),
  ])

  const workspacesWithStats = await Promise.all(
    workspaces.map(async (workspace) => {
      const members = await authDO.listWorkspaceMembers(workspace.id)
      const memberCount = members.filter(
        (member) => member.access_level !== "none"
      ).length

      return {
        id: workspace.id,
        org_id: workspace.org_id,
        name: workspace.name,
        description: workspace.description,
        created_at: workspace.created_at,
        avatar: {
          color: workspace.avatar.color,
          content: workspace.avatar.content,
        },
        member_count: memberCount,
        published_apps: 0,
        compute_tier: "standard" as const,
      }
    })
  )

  const safeWorkspaces = workspacesWithStats

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Workspaces"
        description="All workspaces in this organization."
      />
      <Separator />
      <WorkspacesList
        workspaces={safeWorkspaces}
        canManage={isAdmin}
        currentWorkspaceId={authContext.currentWorkspace?.id ?? null}
      />
    </div>
  )
}
