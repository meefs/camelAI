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
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const loading = fetcher.state !== "idle"

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("User orphaned")
        setOpen(false)
        setConfirmText("")
        setError(null)
      } else if (fetcher.data.error) {
        setError(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data])

  const handleForce = () => {
    setError(null)
    fetcher.submit(
      { intent: "forceOrphan" },
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
