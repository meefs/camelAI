"use client"

import { useEffect } from "react"
import { useFetcher } from "react-router"
import { useForm, getFormProps, getInputProps, getTextareaProps, type SubmissionResult } from "@conform-to/react"
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
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"
import { createWorkspaceFormSchema } from "@/lib/schemas"

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const isMobile = useIsMobile()
  const fetcher = useFetcher<{ result?: SubmissionResult<string[]>; success?: boolean; error?: string }>()
  const saving = fetcher.state !== "idle"

  const [form, fields] = useForm({
    lastResult: fetcher.data?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: createWorkspaceFormSchema })
    },
    defaultValue: {
      name: "",
      description: "",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("Workspace created")
        onOpenChange(false)
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, onOpenChange])

  const formContent = (
    <fetcher.Form method="post" {...getFormProps(form)} className="space-y-4">
      <input type="hidden" name="intent" value="createWorkspace" />

      <div className="space-y-2">
        <Label htmlFor={fields.name.id}>Workspace name</Label>
        <Input
          {...getInputProps(fields.name, { type: "text" })}
          placeholder="New workspace"
        />
        {fields.name.errors && fields.name.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.name.errors[0]}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={fields.description.id}>Description</Label>
        <Textarea
          {...getTextareaProps(fields.description)}
          placeholder="Optional description"
          className="min-h-[96px]"
        />
        {fields.description.errors && fields.description.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.description.errors[0]}</p>
        )}
      </div>

      <div className="hidden md:flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Creating..." : "Create workspace"}
        </Button>
      </div>
    </fetcher.Form>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Create workspace</SheetTitle>
            <SheetDescription>
              Add a new workspace to this organization.
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
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            Add a new workspace to this organization.
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
