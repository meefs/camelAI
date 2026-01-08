"use client"

import { useEffect, useState } from "react"
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
import { Input } from "@/components/ui/input"
import { archiveOrg } from "@/lib/server-actions/org"

interface DeleteOrgDialogProps {
  orgId: string
  orgName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function DeleteOrgDialog({
  orgId,
  orgName,
  open,
  onOpenChange,
  onDeleted,
}: DeleteOrgDialogProps) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setValue("")
      setSaving(false)
    }
  }, [open])

  const handleDelete = async () => {
    setSaving(true)
    try {
      await archiveOrg(orgId)
      toast.success("Organization deleted")
      onDeleted?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete organization"
      )
    } finally {
      setSaving(false)
    }
  }

  const canDelete = value.trim() === orgName

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete organization</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. Type the organization name to
            confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={orgName}
          />
          <p className="text-xs text-muted-foreground">
            Enter <span className="font-medium">{orgName}</span> to confirm.
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleDelete}
            disabled={!canDelete || saving}
          >
            {saving ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
