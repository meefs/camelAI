"use client"

import { useEffect, useState } from "react"
import { Form, useActionData, useNavigation, useRevalidator } from "react-router"
import { useForm, getFormProps, getInputProps, type SubmissionResult } from "@conform-to/react"
import { parseWithZod } from "@conform-to/zod/v4"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AvatarPicker } from "@/components/settings/avatar-picker"
import { getContrastTextColor } from "@/lib/avatar"
import { profileFormSchema } from "@/lib/schemas"
import type { User } from "@/types"

interface ProfileFormProps {
  user: User
}

export function ProfileForm({ user }: ProfileFormProps) {
  const revalidator = useRevalidator()
  const actionData = useActionData<{ result?: SubmissionResult<string[]>; success?: boolean }>()
  const navigation = useNavigation()
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [avatar, setAvatar] = useState(user.avatar)
  const saving = navigation.state === "submitting"

  const [form, fields] = useForm({
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: profileFormSchema })
    },
    defaultValue: {
      name: user.name ?? "",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  // Reset avatar when user changes
  useEffect(() => {
    setAvatar(user.avatar)
  }, [user.avatar])

  // Handle success
  useEffect(() => {
    if (actionData?.success && navigation.state === "idle") {
      toast.success("Profile updated")
      revalidator.revalidate()
    }
  }, [actionData?.success, navigation.state, revalidator])

  const nameErrors = fields.name.errors

  return (
    <div className="space-y-8 max-w-2xl">
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
        <Button variant="outline" type="button" onClick={() => setAvatarOpen(true)}>
          Change avatar
        </Button>
      </div>

      <Form method="post" {...getFormProps(form)} className="space-y-6">
        <input type="hidden" name="intent" value="updateProfile" />
        <input type="hidden" name="avatarColor" value={avatar.color} />
        <input type="hidden" name="avatarContent" value={avatar.content} />

        <div className="space-y-2">
          <Label htmlFor={fields.name.id}>Display name</Label>
          <Input
            {...getInputProps(fields.name, { type: "text" })}
            placeholder="Your name"
          />
          {nameErrors && nameErrors.length > 0 && (
            <p className="text-sm text-destructive">{nameErrors[0]}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Email</Label>
          <Input value={user.email} disabled readOnly />
          <p className="text-xs text-muted-foreground">
            Email cannot be changed.
          </p>
        </div>

        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </Form>

      <AvatarPicker
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        value={avatar}
        onChange={setAvatar}
      />
    </div>
  )
}
