"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArchiveOrgDialog } from "@/components/admin/archive-org-dialog"
import { TransferOwnershipDialog } from "@/components/admin/transfer-ownership-dialog"
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
}

export function OrgDangerZone({
  orgId,
  orgName,
  archived,
  members,
}: OrgDangerZoneProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger Zone</CardTitle>
        <CardDescription>High-impact organization actions</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <TransferOwnershipDialog orgId={orgId} orgName={orgName} members={members} />
        <ArchiveOrgDialog orgId={orgId} orgName={orgName} disabled={archived} />
        {archived ? (
          <span className="text-xs text-muted-foreground">Organization is archived.</span>
        ) : null}
      </CardContent>
    </Card>
  )
}
