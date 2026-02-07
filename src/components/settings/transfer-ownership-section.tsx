"use client"

import { useEffect, useState } from "react"
import { useFetcher } from "react-router"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface TransferCandidate {
  id: string
  name: string | null
  email: string
}

interface TransferOwnershipSectionProps {
  candidates: TransferCandidate[]
  orgName: string
}

export function TransferOwnershipSection({ candidates, orgName }: TransferOwnershipSectionProps) {
  const fetcher = useFetcher<{ success?: boolean; transferred?: boolean; error?: string }>()
  const [selectedId, setSelectedId] = useState<string>("")
  const [confirmName, setConfirmName] = useState("")
  const [open, setOpen] = useState(false)
  const isSubmitting = fetcher.state !== "idle"

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.transferred) {
        toast.success("Ownership transferred")
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data])

  const selectedCandidate = candidates.find((c) => c.id === selectedId)
  const canSubmit = selectedId && confirmName === orgName

  const handleTransfer = () => {
    fetcher.submit(
      { intent: "transferOwnership", newOwnerId: selectedId },
      { method: "POST" }
    )
    setOpen(false)
    setSelectedId("")
    setConfirmName("")
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Transfer ownership</p>
        <p className="text-sm text-muted-foreground">
          Transfer this organization to another admin. You will be demoted to admin.
        </p>
      </div>
      <AlertDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setSelectedId(""); setConfirmName(""); } }}>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={isSubmitting}>
            {isSubmitting ? "Transferring..." : "Transfer ownership"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer ownership</AlertDialogTitle>
            <AlertDialogDescription>
              Select a new owner for <strong>{orgName}</strong>. You will be demoted to admin. This action cannot be easily undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>New owner</Label>
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an admin" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name ?? c.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-transfer-name">
                Type <strong>{orgName}</strong> to confirm
              </Label>
              <Input
                id="confirm-transfer-name"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={orgName}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTransfer}
              disabled={!canSubmit}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Transfer ownership
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
