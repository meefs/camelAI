"use client"

import { useState } from "react"
import { useNavigate } from 'react-router';

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
import { archiveAdminWorkspace } from "@/lib/server-actions/admin"

interface ArchiveWorkspaceDialogProps {
  workspaceId: string
  workspaceName: string
  disabled?: boolean
}

export function ArchiveWorkspaceDialog({
  workspaceId,
  workspaceName,
  disabled = false,
}: ArchiveWorkspaceDialogProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleArchive = async () => {
    setLoading(true)
    setError(null)
    try {
      await archiveAdminWorkspace(workspaceId)
      setOpen(false)
      setConfirmText("")
      // TODO: implement refresh
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive workspace")
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
        Archive Workspace
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive Workspace</AlertDialogTitle>
          <AlertDialogDescription>
            This will archive the workspace and stop new activity. Members will
            lose access until it is restored by a superuser.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="archive-workspace-confirm">
            Type &quot;{workspaceName}&quot; to confirm
          </Label>
          <Input
            id="archive-workspace-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleArchive}
            disabled={loading || confirmText !== workspaceName}
            variant="destructive"
          >
            {loading ? "Archiving..." : "Archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
