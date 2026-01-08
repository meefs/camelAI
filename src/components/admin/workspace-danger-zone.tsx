"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArchiveWorkspaceDialog } from "@/components/admin/archive-workspace-dialog"

interface WorkspaceDangerZoneProps {
  workspaceId: string
  workspaceName: string
  archived: boolean
}

export function WorkspaceDangerZone({
  workspaceId,
  workspaceName,
  archived,
}: WorkspaceDangerZoneProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger Zone</CardTitle>
        <CardDescription>Destructive actions for this workspace</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <ArchiveWorkspaceDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          disabled={archived}
        />
        {archived ? (
          <span className="text-xs text-muted-foreground">Workspace is archived.</span>
        ) : null}
      </CardContent>
    </Card>
  )
}
