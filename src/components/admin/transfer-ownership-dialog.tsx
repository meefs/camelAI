"use client"

import { useEffect, useMemo, useState } from "react"
import { useFetcher } from "react-router"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { OrgRole } from "@/types"

interface MemberOption {
  id: string
  name: string | null
  email: string
  role: OrgRole
}

interface TransferOwnershipDialogProps {
  orgId: string
  orgName: string
  members: MemberOption[]
}

export function TransferOwnershipDialog({
  orgId,
  orgName,
  members,
}: TransferOwnershipDialogProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const loading = fetcher.state !== "idle"

  const eligibleMembers = useMemo(
    () => members.filter((member) => member.role !== "owner"),
    [members]
  )

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("Ownership transferred")
        setOpen(false)
        setSelectedId("")
        setError(null)
      } else if (fetcher.data.error) {
        setError(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data])

  const handleTransfer = () => {
    if (!selectedId) return
    setError(null)
    fetcher.submit(
      { intent: "transferOwnership", newOwnerId: selectedId },
      { method: "POST" }
    )
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Transfer Ownership
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer Ownership</DialogTitle>
            <DialogDescription>
              Select a new owner for {orgName}. The current owner will be downgraded to admin. This action is irreversible. 
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {eligibleMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No eligible members to transfer ownership.
            </p>
          ) : (
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger>
                <SelectValue placeholder="Select new owner" />
              </SelectTrigger>
              <SelectContent>
                {eligibleMembers.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.name || member.email} ({member.role})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button
              onClick={handleTransfer}
              disabled={loading || !selectedId || eligibleMembers.length === 0}
            >
              {loading ? "Transferring..." : "Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
