"use client"

import { useState } from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CreateOrgDialog } from "@/components/settings/create-org-dialog"

export function CreateOrgSection() {
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="font-medium mb-2">Create new organization</h3>
        <p className="text-sm text-muted-foreground">
          Start a new organization with its own workspaces.
        </p>
      </div>
      <Button variant="outline" type="button" onClick={() => setOpen(true)}>
        <Plus className="mr-2 size-4" />
        Create organization
      </Button>
      <CreateOrgDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}
