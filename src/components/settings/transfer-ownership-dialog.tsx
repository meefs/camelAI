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
import { transferOrgOwnership } from "@/lib/server-actions/org"

interface TransferOwnershipDialogProps {
  orgId: string
  newOwnerId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onTransferred?: () => void
}

export function TransferOwnershipDialog({
  orgId,
  newOwnerId,
  open,
  onOpenChange,
  onTransferred,
}: TransferOwnershipDialogProps) {
  const [saving, setSaving] = useState(false)

  const handleTransfer = async () => {
    if (!newOwnerId) return
    setSaving(true)
    try {
      await transferOrgOwnership(orgId, newOwnerId)
      toast.success("Ownership transferred")
      onTransferred?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to transfer ownership"
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Transfer ownership?</AlertDialogTitle>
          <AlertDialogDescription>
            This will make the selected member the new owner. You will become an
            admin.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleTransfer} disabled={!newOwnerId || saving}>
            {saving ? "Transferring..." : "Transfer"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
