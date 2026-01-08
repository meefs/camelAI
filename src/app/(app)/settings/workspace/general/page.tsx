import { redirect } from "next/navigation"

import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"
import { WorkspaceDangerZone } from "@/components/settings/workspace-danger-zone"
import { WorkspaceGeneralForm } from "@/components/settings/workspace-general-form"
import { requireAuthContextLite } from "@/lib/server-guards"
import * as authDO from "@/lib/auth-do"

export default async function WorkspaceGeneralPage() {
  const authContext = await requireAuthContextLite()
  const currentWorkspace = authContext.currentWorkspace

  if (!currentWorkspace) {
    redirect("/")
  }

  const [isAdmin, workspaces] = await Promise.all([
    authDO.isOrgAdmin(authContext.user.id, authContext.currentOrg.id),
    authDO.listOrgWorkspaces(authContext.currentOrg.id),
  ])
  const canEdit = isAdmin && currentWorkspace.access_level === "full"
  const activeWorkspaceCount = workspaces.filter(
    (workspace) => !workspace.archived
  ).length
  const safeWorkspace = {
    id: currentWorkspace.id,
    org_id: currentWorkspace.org_id,
    name: currentWorkspace.name,
    description: currentWorkspace.description,
    created_by: currentWorkspace.created_by,
    created_at: currentWorkspace.created_at,
    avatar: {
      color: currentWorkspace.avatar.color,
      content: currentWorkspace.avatar.content,
    },
    archived: currentWorkspace.archived,
    archived_at: currentWorkspace.archived_at,
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Workspace"
        description="Manage settings for the current workspace."
      />
      <Separator />
      <WorkspaceGeneralForm
        workspace={safeWorkspace}
        canEdit={canEdit}
      />

      <Separator className="my-8" />
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
          <p className="text-sm text-muted-foreground">
            Irreversible actions for this workspace.
          </p>
        </div>
        <WorkspaceDangerZone
          workspaceId={currentWorkspace.id}
          workspaceName={currentWorkspace.name}
          isAdmin={canEdit}
          isLastWorkspace={activeWorkspaceCount <= 1}
        />
      </div>
    </div>
  )
}
