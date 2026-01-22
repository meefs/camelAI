"use client"

import { useEffect, useState } from "react"
import { useFetcher } from "react-router"
import { toast } from "sonner"

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
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const loading = fetcher.state !== "idle"

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("Organization archived")
        setOpen(false)
        setConfirmText("")
        setError(null)
      } else if (fetcher.data.error) {
        setError(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data])

  const handleArchive = () => {
    setError(null)
    fetcher.submit(
      { intent: "archiveOrg" },
      { method: "POST" }
    )
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
