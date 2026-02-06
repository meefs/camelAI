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

interface DeleteOrgDialogProps {
  orgId: string
  orgName: string
  memberCount: number
  workspaceCount: number
  disabled?: boolean
}

interface DeleteOrgActionResult {
  success?: boolean
  error?: string
  warnings?: string[]
}

export function DeleteOrgDialog({
  orgId,
  orgName,
  memberCount,
  workspaceCount,
  disabled = false,
}: DeleteOrgDialogProps) {
  const navigate = useNavigate()
  const fetcher = useFetcher<DeleteOrgActionResult>()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const loading = fetcher.state !== "idle"

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        const warningCount = fetcher.data.warnings?.length ?? 0
        if (warningCount > 0) {
          toast.warning(`Organization deleted with ${warningCount} cleanup warning${warningCount === 1 ? "" : "s"}`)
        } else {
          toast.success("Organization permanently deleted")
        }
        setOpen(false)
        setConfirmText("")
        setError(null)
        navigate("/qaml-backdoor/orgs")
      } else if (fetcher.data.error) {
        setError(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, navigate])

  const handleDelete = () => {
    setError(null)
    fetcher.submit(
      { intent: "hardDeleteOrg", orgId },
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
        <Trash2 className="mr-2 h-4 w-4" />
        Permanently Delete Org
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Permanently Delete Organization</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete this organization and wipe its workspaces, members, app records,
            sessions, and related storage. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Alert variant="destructive">
          <AlertDescription>
            Test accounts only. If you just need to remove normal access, use Archive Organization instead.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            About to delete {memberCount} {memberCount === 1 ? "member" : "members"} and {workspaceCount}{" "}
            {workspaceCount === 1 ? "workspace" : "workspaces"}.
          </p>
          <Label htmlFor="delete-org-confirm">
            Type &quot;{orgName}&quot; to confirm permanent deletion
          </Label>
          <Input
            id="delete-org-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleDelete}
            disabled={loading || confirmText !== orgName}
            variant="destructive"
          >
            {loading ? "Deleting..." : "Delete Forever"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
