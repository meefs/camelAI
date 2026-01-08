"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { archiveAdminOrg } from "@/lib/server-actions/admin"

interface ArchiveOrgDialogProps {
  orgId: string
  orgName: string
  disabled?: boolean
}

export function ArchiveOrgDialog({
  orgId,
  orgName,
  disabled = false,
}: ArchiveOrgDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleArchive = async () => {
    setLoading(true)
    setError(null)
    try {
      await archiveAdminOrg(orgId)
      setOpen(false)
      setConfirmText("")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive organization")
    } finally {
      setLoading(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        Archive Organization
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive Organization</AlertDialogTitle>
          <AlertDialogDescription>
            This will archive the organization and all its workspaces. Members will lose access
            until it is restored by a superuser.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="archive-org-confirm">
            Type &quot;{orgName}&quot; to confirm
          </Label>
          <Input
            id="archive-org-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleArchive}
            disabled={loading || confirmText !== orgName}
            variant="destructive"
          >
            {loading ? "Archiving..." : "Archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
