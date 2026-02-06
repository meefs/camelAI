"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArchiveOrgDialog } from "@/components/admin/archive-org-dialog"
import { TransferOwnershipDialog } from "@/components/admin/transfer-ownership-dialog"
import { DeleteOrgDialog } from "@/components/admin/delete-org-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { OrgRole } from "@/types"

interface OrgMemberOption {
  id: string
  name: string | null
  email: string
  role: OrgRole
}

interface OrgDangerZoneProps {
  orgId: string
  orgName: string
  archived: boolean
  members: OrgMemberOption[]
  workspaceCount: number
}

export function OrgDangerZone({
  orgId,
  orgName,
  archived,
  members,
  workspaceCount,
}: OrgDangerZoneProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger Zone</CardTitle>
        <CardDescription>High-impact organization actions</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>
            This is only for test account purposes. If you&apos;re just trying to delete a user&apos;s org, please use archive instead.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap items-center gap-3">
          <TransferOwnershipDialog orgId={orgId} orgName={orgName} members={members} />
          <ArchiveOrgDialog orgId={orgId} orgName={orgName} disabled={archived} />
          <DeleteOrgDialog
            orgId={orgId}
            orgName={orgName}
            memberCount={members.length}
            workspaceCount={workspaceCount}
          />
          {archived ? (
            <span className="text-xs text-muted-foreground">Organization is archived.</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
