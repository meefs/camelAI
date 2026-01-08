"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { ArchiveWorkspaceDialog } from "@/components/settings/archive-workspace-dialog"
import { useAuth } from "@/contexts/AuthContext"

interface WorkspaceDangerZoneProps {
  workspaceId: string
  workspaceName: string
  isAdmin: boolean
  isLastWorkspace: boolean
}

export function WorkspaceDangerZone({
  workspaceId,
  workspaceName,
  isAdmin,
  isLastWorkspace,
}: WorkspaceDangerZoneProps) {
  const router = useRouter()
  const { currentOrg, workspaces, switchWorkspace, refreshAuth } = useAuth()
  const [archiveOpen, setArchiveOpen] = useState(false)

  const fallbackWorkspaceId = useMemo(() => {
    if (!currentOrg) return null
    return (
      workspaces?.find(
        (workspace) =>
          workspace.org_id === currentOrg.id && workspace.id !== workspaceId
      )?.id ?? null
    )
  }, [currentOrg, workspaces, workspaceId])

  const handleArchived = async () => {
    if (fallbackWorkspaceId) {
      await switchWorkspace(fallbackWorkspaceId)
    } else {
      await refreshAuth()
    }
    router.push("/settings/workspace/general")
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h3 className="text-base font-medium">Archive workspace</h3>
        <p className="text-sm text-muted-foreground">
          Archive this workspace. It will be hidden but data will be preserved.
        </p>
      </div>
      <Button
        variant="destructive"
        disabled={!isAdmin || isLastWorkspace}
        onClick={() => setArchiveOpen(true)}
      >
        Archive workspace
      </Button>
      {isLastWorkspace ? (
        <p className="text-xs text-muted-foreground">
          Cannot archive the only workspace in an organization.
        </p>
      ) : null}
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Only admins with full access can archive workspaces.
        </p>
      ) : null}

      <ArchiveWorkspaceDialog
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        onArchived={handleArchived}
      />
    </div>
  )
}
