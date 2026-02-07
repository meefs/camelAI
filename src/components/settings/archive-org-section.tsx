"use client"

import { useEffect, useState } from "react"
import { useFetcher, useNavigate } from "react-router"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface ArchiveOrgSectionProps {
  orgName: string
}

export function ArchiveOrgSection({ orgName }: ArchiveOrgSectionProps) {
  const fetcher = useFetcher<{ success?: boolean; archived?: boolean; error?: string }>()
  const navigate = useNavigate()
  const [confirmName, setConfirmName] = useState("")
  const [open, setOpen] = useState(false)
  const isSubmitting = fetcher.state !== "idle"

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.archived) {
        toast.success("Organization archived")
        navigate("/")
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, navigate])

  const handleArchive = () => {
    fetcher.submit(
      { intent: "archiveOrg" },
      { method: "POST" }
    )
    setOpen(false)
    setConfirmName("")
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Archive this organization</p>
        <p className="text-sm text-muted-foreground">
          Archiving will delete this organization and all its workspaces. This action cannot be undone.
        </p>
      </div>
      <AlertDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirmName(""); }}>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={isSubmitting}>
            {isSubmitting ? "Archiving..." : "Archive organization"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive organization?</AlertDialogTitle>
            <AlertDialogDescription>
              This will archive <strong>{orgName}</strong> and all its workspaces. All members will lose access. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="confirm-org-name">
              Type <strong>{orgName}</strong> to confirm
            </Label>
            <Input
              id="confirm-org-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={orgName}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              disabled={confirmName !== orgName}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Archive organization
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
