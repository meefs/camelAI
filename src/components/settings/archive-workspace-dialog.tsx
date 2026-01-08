"use client"

import { useState } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { archiveWorkspace } from "@/lib/server-actions/workspace"

interface ArchiveWorkspaceDialogProps {
  workspaceId: string
  workspaceName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchived?: () => void
}

export function ArchiveWorkspaceDialog({
  workspaceId,
  workspaceName,
  open,
  onOpenChange,
  onArchived,
}: ArchiveWorkspaceDialogProps) {
  const [saving, setSaving] = useState(false)

  const handleArchive = async () => {
    setSaving(true)
    try {
      await archiveWorkspace(workspaceId)
      toast.success("Workspace archived")
      onArchived?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to archive workspace"
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive workspace</AlertDialogTitle>
          <AlertDialogDescription>
            Archive {workspaceName}. It will be hidden but data will be
            preserved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={handleArchive} disabled={saving}>
            {saving ? "Archiving..." : "Archive"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
