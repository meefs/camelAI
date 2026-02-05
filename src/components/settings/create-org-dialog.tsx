"use client"

import { useEffect, useRef } from "react"
import { useFetcher } from "react-router"
import { useForm, getFormProps, getInputProps, type SubmissionResult } from "@conform-to/react"
import { parseWithZod } from "@conform-to/zod/v4"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useIsMobile } from "@/hooks/use-mobile"
import { useSwitchOrg } from "@/hooks/use-auth-actions"
import { createOrgFormSchema } from "@/lib/schemas"

interface CreateOrgDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  switchToNewOrg?: boolean
}

export function CreateOrgDialog({
  open,
  onOpenChange,
  switchToNewOrg = true,
}: CreateOrgDialogProps) {
  const isMobile = useIsMobile()
  const { switchOrg } = useSwitchOrg()
  const fetcher = useFetcher<{ result?: SubmissionResult<string[]>; success?: boolean; error?: string; orgId?: string }>()
  const saving = fetcher.state !== "idle"
  const processedOrgIdRef = useRef<string | null>(null)

  const [form, fields] = useForm({
    lastResult: fetcher.data?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: createOrgFormSchema })
    },
    defaultValue: {
      name: "",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  // Reset processed ref when dialog opens
  useEffect(() => {
    if (open) {
      processedOrgIdRef.current = null
    }
  }, [open])

  // Handle response - use ref to prevent processing the same response multiple times
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success && fetcher.data.orgId) {
        // Skip if we already processed this org creation
        if (processedOrgIdRef.current === fetcher.data.orgId) {
          return
        }
        processedOrgIdRef.current = fetcher.data.orgId

        toast.success("Organization created")
        onOpenChange(false)
        // Switch to new org if requested - React Router will auto-revalidate
        if (switchToNewOrg) {
          switchOrg(fetcher.data.orgId)
        }
        // React Router will auto-revalidate after the fetcher action
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, onOpenChange, switchToNewOrg, switchOrg])

  const formContent = (
    <fetcher.Form method="post" {...getFormProps(form)} className="space-y-4">
      <input type="hidden" name="intent" value="createOrg" />

      <div className="space-y-2">
        <Label htmlFor={fields.name.id}>Organization name</Label>
        <Input
          {...getInputProps(fields.name, { type: "text" })}
          placeholder="New organization"
        />
        {fields.name.errors && fields.name.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.name.errors[0]}</p>
        )}
      </div>

      <div className="hidden md:flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Creating..." : "Create organization"}
        </Button>
      </div>
    </fetcher.Form>
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
          <div className="py-6">{formContent}</div>
          <SheetFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={form.id} disabled={saving}>
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
        {formContent}
        <DialogFooter className="md:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={form.id} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
