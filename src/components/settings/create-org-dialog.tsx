"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { createOrg } from "@/lib/server-actions/org"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAuth } from "@/contexts/AuthContext"
import type { Organization } from "@/types"

const orgSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100),
})

type OrgFormValues = z.infer<typeof orgSchema>

interface CreateOrgDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (org: Organization) => void
  switchToNewOrg?: boolean
}

export function CreateOrgDialog({
  open,
  onOpenChange,
  onCreated,
  switchToNewOrg = true,
}: CreateOrgDialogProps) {
  const isMobile = useIsMobile()
  const router = useRouter()
  const { refreshAuth, switchOrg } = useAuth()
  const [saving, setSaving] = useState(false)

  const form = useForm<OrgFormValues>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: "",
    },
  })

  const onSubmit = async (values: OrgFormValues) => {
    setSaving(true)
    try {
      const org = await createOrg(values.name.trim())
      if (switchToNewOrg) {
        try {
          await switchOrg(org.id)
        } catch {
          await refreshAuth()
        }
      } else {
        await refreshAuth()
      }
      router.refresh()
      toast.success("Organization created")
      onCreated?.(org)
      form.reset({ name: "" })
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create organization"
      )
    } finally {
      setSaving(false)
    }
  }

  const body = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Organization name</FormLabel>
              <FormControl>
                <Input placeholder="New organization" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="hidden md:flex items-center justify-end gap-2">
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating..." : "Create organization"}
          </Button>
        </div>
      </form>
    </Form>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Create organization</SheetTitle>
            <SheetDescription>
              Start a new organization with its own workspaces.
            </SheetDescription>
          </SheetHeader>
          <div className="py-6">{body}</div>
          <SheetFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={form.handleSubmit(onSubmit)} disabled={saving}>
              {saving ? "Creating..." : "Create"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            Start a new organization with its own workspaces.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter className="md:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={form.handleSubmit(onSubmit)} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
