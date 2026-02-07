"use client"

import { useEffect, useState } from "react"
import { useFetcher } from "react-router"
import { useForm, getFormProps, getInputProps, getSelectProps, type SubmissionResult } from "@conform-to/react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useIsMobile } from "@/hooks/use-mobile"
import { inviteMemberFormSchema } from "@/lib/schemas"

interface InviteMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InviteMemberDialog({
  open,
  onOpenChange,
}: InviteMemberDialogProps) {
  const isMobile = useIsMobile()
  const fetcher = useFetcher<{
    result?: SubmissionResult<string[]>;
    success?: boolean;
    error?: string;
    warning?: string;
    invitation_url?: string;
  }>()
  const saving = fetcher.state !== "idle"

  const [selectedRole, setSelectedRole] = useState<string>("member")

  const roleDescriptions: Record<string, string> = {
    admin: "Full access to everything. Can manage team members, workspaces, and all settings.",
    member: "Can access assigned workspaces — chat, apps, computer, and connections. Cannot manage the team or org settings.",
  }

  const [form, fields] = useForm({
    lastResult: fetcher.data?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: inviteMemberFormSchema })
    },
    defaultValue: {
      email: "",
      role: "member",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        if (fetcher.data.warning) {
          toast.warning(fetcher.data.warning)
        } else {
          toast.success("Invitation sent")
        }
        onOpenChange(false)
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, onOpenChange])

  const formContent = (
    <fetcher.Form method="post" {...getFormProps(form)} className="space-y-4">
      <input type="hidden" name="intent" value="createInvitation" />

      <div className="space-y-2">
        <Label htmlFor={fields.email.id}>Email</Label>
        <Input
          {...getInputProps(fields.email, { type: "email" })}
          placeholder="name@example.com"
        />
        {fields.email.errors && fields.email.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.email.errors[0]}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={fields.role.id}>Role</Label>
        <Select
          name={fields.role.name}
          defaultValue={fields.role.initialValue}
          onValueChange={setSelectedRole}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="member">Member</SelectItem>
            {/* TODO: Viewer role (deferred) */}
          </SelectContent>
        </Select>
        {roleDescriptions[selectedRole] ? (
          <p className="text-xs text-muted-foreground">{roleDescriptions[selectedRole]}</p>
        ) : null}
        {fields.role.errors && fields.role.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.role.errors[0]}</p>
        )}
      </div>

      <div className="hidden md:flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Sending..." : "Send invite"}
        </Button>
      </div>
    </fetcher.Form>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Invite member</SheetTitle>
            <SheetDescription>
              Add someone to your organization and assign a role.
            </SheetDescription>
          </SheetHeader>
          <div className="py-6">{formContent}</div>
          <SheetFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={form.id} disabled={saving}>
              {saving ? "Sending..." : "Send"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Add someone to your organization and assign a role.
          </DialogDescription>
        </DialogHeader>
        {formContent}
        <DialogFooter className="md:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={form.id} disabled={saving}>
            {saving ? "Sending..." : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
