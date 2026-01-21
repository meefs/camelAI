"use client"

import { useEffect, useState } from "react"
import { useFetcher } from "react-router"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { AvatarPicker } from "@/components/settings/avatar-picker"
import { getContrastTextColor } from "@/lib/avatar"
import type { Workspace } from "@/types"

interface WorkspaceEditFormProps {
  workspace: Workspace
}

export function WorkspaceEditForm({ workspace }: WorkspaceEditFormProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [name, setName] = useState(workspace.name)
  const [description, setDescription] = useState(workspace.description ?? "")
  const [avatar, setAvatar] = useState(workspace.avatar)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const saving = fetcher.state !== "idle"

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("Workspace updated")
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    fetcher.submit(
      {
        intent: "updateWorkspace",
        name: name.trim(),
        description: description.trim() || "",
        avatarColor: avatar.color,
        avatarContent: avatar.content,
      },
      { method: "POST" }
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
        <Button
          variant="outline"
          type="button"
          onClick={() => setAvatarOpen(true)}
        >
          Change avatar
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="workspace-name">Name</Label>
        <Input
          id="workspace-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Workspace name"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="workspace-description">Description</Label>
        <Textarea
          id="workspace-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Optional workspace description"
          className="min-h-[120px]"
        />
      </div>

      <Button type="submit" disabled={saving}>
        {saving ? "Saving..." : "Save Changes"}
      </Button>

      <AvatarPicker
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        value={avatar}
        onChange={setAvatar}
        title="Workspace avatar"
        description="Update the workspace avatar and initials."
      />
    </form>
  )
}
