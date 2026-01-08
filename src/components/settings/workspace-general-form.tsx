"use client"

import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { Plus } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { updateWorkspaceInfo } from "@/lib/server-actions/workspace"
import { AvatarPicker } from "@/components/settings/avatar-picker"
import { CreateWorkspaceDialog } from "@/components/settings/create-workspace-dialog"
import { useAuth } from "@/contexts/AuthContext"
import { getContrastTextColor } from "@/lib/avatar"
import type { Workspace } from "@/types"

const workspaceSchema = z.object({
  name: z.string().min(1, "Workspace name is required").max(100),
  description: z.string().max(200).optional(),
})

type WorkspaceFormValues = z.infer<typeof workspaceSchema>

interface WorkspaceGeneralFormProps {
  workspace: Workspace
  canEdit: boolean
}

export function WorkspaceGeneralForm({
  workspace,
  canEdit,
}: WorkspaceGeneralFormProps) {
  const { refreshAuth } = useAuth()
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [avatar, setAvatar] = useState(workspace.avatar)
  const [saving, setSaving] = useState(false)

  const defaultValues = useMemo(
    () => ({
      name: workspace.name,
      description: workspace.description ?? "",
    }),
    [workspace.name, workspace.description]
  )

  const form = useForm<WorkspaceFormValues>({
    resolver: zodResolver(workspaceSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
    setAvatar(workspace.avatar)
  }, [defaultValues, form, workspace.avatar])

  const onSubmit = async (values: WorkspaceFormValues) => {
    if (!canEdit) return
    setSaving(true)
    try {
      await updateWorkspaceInfo(workspace.id, {
        name: values.name.trim(),
        description: values.description?.trim() || null,
        avatar,
      })
      toast.success("Workspace updated")
      await refreshAuth()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update workspace"
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-4">
        <Avatar className="h-16 w-16">
          <AvatarFallback
            style={{
              backgroundColor: avatar.color,
              color: getContrastTextColor(avatar.color),
            }}
          >
            {avatar.content}
          </AvatarFallback>
        </Avatar>
        {canEdit ? (
          <Button variant="outline" type="button" onClick={() => setAvatarOpen(true)}>
            Change avatar
          </Button>
        ) : null}
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Workspace name</FormLabel>
                <FormControl>
                  <Input {...field} disabled={!canEdit} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Optional description"
                    className="min-h-[120px]"
                    {...field}
                    disabled={!canEdit}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {canEdit ? (
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          ) : null}
        </form>
      </Form>

      {canEdit ? (
        <>
          <Separator />
          <div>
            <h3 className="font-medium mb-2">Create new workspace</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Add another workspace to this organization.
            </p>
            <Button variant="outline" type="button" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 size-4" />
              Create workspace
            </Button>
          </div>
        </>
      ) : null}

      <AvatarPicker
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        value={avatar}
        onChange={setAvatar}
        title="Workspace avatar"
        description="Update the workspace avatar and initials."
      />

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          refreshAuth()
        }}
      />
    </div>
  )
}
