"use client"

import { useEffect, useState } from "react"
import { Form, useActionData, useNavigation, useRevalidator } from "react-router"
import { useForm, getFormProps, getInputProps, getTextareaProps, type SubmissionResult } from "@conform-to/react"
import { parseWithZod } from "@conform-to/zod/v4"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { AvatarPicker } from "@/components/settings/avatar-picker"
import { getContrastTextColor } from "@/lib/avatar"
import { workspaceFormSchema } from "@/lib/schemas"
import type { Workspace } from "@/types"

interface WorkspaceGeneralFormProps {
  workspace: Workspace
  workspaceEmailAddress?: string | null
  canEdit: boolean
}

export function WorkspaceGeneralForm({
  workspace,
  workspaceEmailAddress,
  canEdit,
}: WorkspaceGeneralFormProps) {
  const revalidator = useRevalidator()
  const actionData = useActionData<{ result?: SubmissionResult<string[]>; success?: boolean }>()
  const navigation = useNavigation()
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [avatar, setAvatar] = useState(workspace.avatar)
  const saving = navigation.state === "submitting"

  const [form, fields] = useForm({
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: workspaceFormSchema })
    },
    defaultValue: {
      name: workspace.name,
      description: workspace.description ?? "",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  // Reset avatar when workspace changes
  useEffect(() => {
    setAvatar(workspace.avatar)
  }, [workspace.avatar])

  // Handle success
  useEffect(() => {
    if (actionData?.success && navigation.state === "idle") {
      toast.success("Workspace updated")
      revalidator.revalidate()
    }
  }, [actionData?.success, navigation.state, revalidator])

  const nameErrors = fields.name.errors
  const descriptionErrors = fields.description.errors

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Avatar size="xl">
          <AvatarFallback
            content={avatar.content}
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

      <Form method="post" {...getFormProps(form)} className="space-y-6 max-w-2xl">
        <input type="hidden" name="intent" value="updateWorkspace" />
        <input type="hidden" name="avatarColor" value={avatar.color} />
        <input type="hidden" name="avatarContent" value={avatar.content} />

        <div className="space-y-2">
          <Label htmlFor={fields.name.id}>Workspace name</Label>
          <Input
            {...getInputProps(fields.name, { type: "text" })}
            disabled={!canEdit}
          />
          {nameErrors && nameErrors.length > 0 && (
            <p className="text-sm text-destructive">{nameErrors[0]}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={fields.description.id}>Description</Label>
          <Textarea
            {...getTextareaProps(fields.description)}
            placeholder="Optional description"
            className="min-h-[120px]"
            disabled={!canEdit}
          />
          {descriptionErrors && descriptionErrors.length > 0 && (
            <p className="text-sm text-destructive">{descriptionErrors[0]}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="workspace-email-address">Workspace email</Label>
          <Input
            id="workspace-email-address"
            value={workspaceEmailAddress ?? "Not configured"}
            readOnly
          />
          {workspaceEmailAddress ? (
            <p className="text-sm text-muted-foreground">
              Send a message to this address to chat with camelAI from email. Replies stay in the same camelAI thread
              using email reply headers.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Workspace email routing is not configured in this environment.
            </p>
          )}
        </div>

        {canEdit ? (
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
        ) : null}
      </Form>

      <AvatarPicker
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        value={avatar}
        onChange={setAvatar}
        title="Workspace avatar"
        description="Update the workspace avatar and initials."
      />
    </div>
  )
}
