"use client"

import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

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
import { Label } from "@/components/ui/label"
import { useAuth } from "@/contexts/AuthContext"
import { updateUserProfile } from "@/lib/server-actions/user"
import { AvatarPicker } from "@/components/settings/avatar-picker"
import { getContrastTextColor } from "@/lib/avatar"
import type { User } from "@/types"

const profileSchema = z.object({
  name: z.string().max(100, "Name must be 100 characters or less").optional(),
})

type ProfileFormValues = z.infer<typeof profileSchema>

interface ProfileFormProps {
  user: User
}

export function ProfileForm({ user }: ProfileFormProps) {
  const { refreshAuth } = useAuth()
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [avatar, setAvatar] = useState(user.avatar)
  const [saving, setSaving] = useState(false)

  const defaultValues = useMemo(
    () => ({
      name: user.name ?? "",
    }),
    [user.name]
  )

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
    setAvatar(user.avatar)
  }, [defaultValues, form, user.avatar])

  const onSubmit = async (values: ProfileFormValues) => {
    setSaving(true)
    try {
      const nextName = values.name?.trim() || null
      await updateUserProfile({
        name: nextName,
        avatar,
      })
      toast.success("Profile updated")
      await refreshAuth()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update profile"
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-4">
        <Avatar className="h-20 w-20">
          <AvatarFallback
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

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl>
                  <Input placeholder="Your name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

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
        </form>
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
