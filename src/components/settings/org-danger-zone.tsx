"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DeleteOrgDialog } from "@/components/settings/delete-org-dialog"
import { TransferOwnershipDialog } from "@/components/settings/transfer-ownership-dialog"
import { useAuth } from "@/contexts/AuthContext"
import type { OrgRole, User } from "@/types"

interface OrgMemberRow {
  user: User
  role: OrgRole
}

interface OrgDangerZoneProps {
  orgId: string
  orgName: string
  members: OrgMemberRow[]
  isOwner: boolean
}

export function OrgDangerZone({
  orgId,
  orgName,
  members,
  isOwner,
}: OrgDangerZoneProps) {
  const router = useRouter()
  const { logout, refreshAuth } = useAuth()
  const [selectedNewOwner, setSelectedNewOwner] = useState<string | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const ownerOptions = useMemo(
    () => members.filter((member) => member.role !== "owner"),
    [members]
  )

  return (
    <div className="space-y-8">
      <div className="space-y-4 max-w-2xl">
        <div>
          <h3 className="text-base font-medium text-destructive">Transfer ownership</h3>
          <p className="text-sm text-muted-foreground">
            Transfer this organization to another member. You will become an
            admin. This action is irreversible. 
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Select
            disabled={!isOwner}
            value={selectedNewOwner ?? ""}
            onValueChange={(value) => setSelectedNewOwner(value)}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select new owner" />
            </SelectTrigger>
            <SelectContent>
              {ownerOptions.map((member) => (
                <SelectItem key={member.user.id} value={member.user.id}>
                  {member.user.name || member.user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="destructive"
            disabled={!isOwner || !selectedNewOwner}
            onClick={() => setTransferOpen(true)}
          >
            Transfer
          </Button>
        </div>
        {!isOwner ? (
          <p className="text-xs text-muted-foreground">
            Only the organization owner can transfer ownership.
          </p>
        ) : null}
      </div>

      <Separator />

      <div className="space-y-4 max-w-2xl">
        <div>
          <h3 className="text-base font-medium text-destructive">Delete organization</h3>
          <p className="text-sm text-muted-foreground">
            Permanently delete this organization and all its workspaces. This
            cannot be undone.
          </p>
        </div>
        <Button
          variant="destructive"
          disabled={!isOwner}
          onClick={() => setDeleteOpen(true)}
        >
          Delete organization
        </Button>
        {!isOwner ? (
          <p className="text-xs text-muted-foreground">
            Only the organization owner can delete the organization.
          </p>
        ) : null}
      </div>

      <TransferOwnershipDialog
        orgId={orgId}
        newOwnerId={selectedNewOwner}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onTransferred={() => {
          refreshAuth()
        }}
      />

      <DeleteOrgDialog
        orgId={orgId}
        orgName={orgName}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={async () => {
          await logout()
          router.push("/login")
        }}
      />
    </div>
  )
}
