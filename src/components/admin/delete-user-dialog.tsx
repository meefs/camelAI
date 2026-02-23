"use client"

import { useEffect, useState } from "react"
import { useFetcher, useNavigate } from "react-router"
import { toast } from "sonner"
import { Trash2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface DeleteUserDialogProps {
  userId: string
  userEmail: string
  orgCount: number
  disabled?: boolean
}

interface DeleteUserActionResult {
  success?: boolean
  error?: string
  warnings?: string[]
}

export function DeleteUserDialog({
  userId,
  userEmail,
  orgCount,
  disabled = false,
}: DeleteUserDialogProps) {
  const navigate = useNavigate()
  const fetcher = useFetcher<DeleteUserActionResult>()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const loading = fetcher.state !== "idle"

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setConfirmText("")
      setError(null)
    }
  }

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        const warningCount = fetcher.data.warnings?.length ?? 0
        if (warningCount > 0) {
          toast.warning(`User deleted with ${warningCount} cleanup warning${warningCount === 1 ? "" : "s"}`)
        } else {
          toast.success("User permanently deleted")
        }
        setOpen(false)
        setConfirmText("")
        setError(null)
        navigate("/qaml-backdoor/users")
      } else if (fetcher.data.error) {
        setError(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, navigate])

  const handleDelete = () => {
    setError(null)
    fetcher.submit(
      { intent: "hardDeleteUser", userId },
      { method: "POST" }
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <Button
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Permanently Delete User
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Permanently Delete User</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete this user account, remove them from all organizations,
            and wipe their profile, sessions, and related KV entries. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Alert variant="destructive">
          <AlertDescription>
            This should only be used for test accounts. If you need to remove a real user&apos;s access,
            use Force Orphan instead.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          {orgCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              This user will be removed from {orgCount} {orgCount === 1 ? "organization" : "organizations"}.
            </p>
          ) : null}
          <Label htmlFor="delete-user-confirm">
            Type &quot;{userEmail}&quot; to confirm permanent deletion
          </Label>
          <Input
            id="delete-user-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleDelete}
            disabled={loading || confirmText !== userEmail}
            variant="destructive"
          >
            {loading ? "Deleting..." : "Delete Forever"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
