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
import { forceAdminOrphanUser } from "@/lib/server-actions/admin"

interface ForceOrphanDialogProps {
  userId: string
  userLabel: string
  disabled?: boolean
}

export function ForceOrphanDialog({
  userId,
  userLabel,
  disabled = false,
}: ForceOrphanDialogProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleForce = async () => {
    setLoading(true)
    setError(null)
    try {
      await forceAdminOrphanUser(userId)
      setOpen(false)
      setConfirmText("")
      // TODO: implement refresh
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to orphan user")
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
        Force Orphan User
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Force Orphan User</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the user from all organizations, leaving them without access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="force-orphan-confirm">
            Type &quot;{userLabel}&quot; to confirm
          </Label>
          <Input
            id="force-orphan-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleForce}
            disabled={loading || confirmText !== userLabel}
            variant="destructive"
          >
            {loading ? "Removing..." : "Confirm"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
