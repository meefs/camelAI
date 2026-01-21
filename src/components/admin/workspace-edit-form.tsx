"use client"

import { useState } from "react"
import { useNavigate } from 'react-router';

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AvatarPicker } from "@/components/settings/avatar-picker"
import { updateAdminWorkspace } from "@/lib/server-actions/admin"
import { getContrastTextColor } from "@/lib/avatar"
import type { Workspace } from "@/types"

interface WorkspaceEditFormProps {
  workspace: Workspace
}

export function WorkspaceEditForm({ workspace }: WorkspaceEditFormProps) {
  const navigate = useNavigate()
  const [name, setName] = useState(workspace.name)
  const [description, setDescription] = useState(workspace.description ?? "")
  const [avatar, setAvatar] = useState(workspace.avatar)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      await updateAdminWorkspace(workspace.id, {
        name: name.trim(),
        description: description.trim() || null,
        avatar,
      })
      setSuccess(true)
      // TODO: implement refresh
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>Workspace updated successfully</AlertDescription>
        </Alert>
      )}

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

      <Button type="submit" disabled={loading}>
        {loading ? "Saving..." : "Save Changes"}
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
