"use client"

import { useEffect, useId, useMemo, useState } from "react"

import { ChatGroupAvatar } from "@/components/avatar/chat-group-avatar"
import { ChatGroupIconPicker } from "@/components/avatar/chat-group-icon-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-mobile"
import { normalizeAvatarColor } from "@/lib/avatar"
import { resolveChatGroupIconName } from "@/lib/chat-group-icons"
import type { Avatar as AvatarShape } from "@/types"

// Chat group avatars no longer carry a user-chosen color; the color field is
// preserved on the stored shape but ignored when rendering. We carry it through
// unchanged so we never widen the avatar contract.
const FALLBACK_AVATAR_COLOR = "#3B82F6"

function normalizeInitialAvatar(avatar: AvatarShape): AvatarShape {
  const color = normalizeAvatarColor(avatar.color) ?? FALLBACK_AVATAR_COLOR
  const content = resolveChatGroupIconName(avatar.content)
  return { color, content }
}

export function RenameChatGroupDialog({
  open,
  onOpenChange,
  initialName,
  initialAvatar,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialName: string
  initialAvatar: AvatarShape
  onSubmit: (next: { name: string; avatar?: AvatarShape }) => void
}) {
  const isMobile = useIsMobile()
  const nameInputId = useId()
  const formId = useId()
  const normalizedInitialAvatar = useMemo(
    () => normalizeInitialAvatar(initialAvatar),
    [initialAvatar.color, initialAvatar.content]
  )
  const [name, setName] = useState(initialName)
  const [color, setColor] = useState(normalizedInitialAvatar.color)
  const [content, setContent] = useState(normalizedInitialAvatar.content)

  useEffect(() => {
    if (!open) return
    setName(initialName)
    setColor(normalizedInitialAvatar.color)
    setContent(normalizedInitialAvatar.content)
  }, [initialName, normalizedInitialAvatar, open])

  const trimmedName = name.trim()
  const avatar = { color, content }
  const previewName = trimmedName || "Untitled group"
  const avatarChanged = content !== normalizedInitialAvatar.content
  const changed =
    trimmedName !== initialName.trim() ||
    avatarChanged
  const canSave = trimmedName.length > 0 && changed

  const submit = () => {
    if (!canSave) return
    onSubmit({
      name: trimmedName,
      ...(avatarChanged ? { avatar } : {}),
    })
    onOpenChange(false)
  }

  const body = (
    <form
      id={formId}
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex items-center gap-4">
        <ChatGroupAvatar avatar={avatar} fallbackName={previewName} size="xl" />
        <div className="min-w-0 text-lg font-semibold leading-tight">
          <span className={trimmedName ? "truncate" : "text-muted-foreground"}>
            {previewName}
          </span>
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={nameInputId}>Name</Label>
        <Input
          id={nameInputId}
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Marketing dashboards"
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Icon</p>
        <ChatGroupIconPicker value={content} onSelect={setContent} />
      </div>
    </form>
  )

  const footer = (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
      <Button type="submit" form={formId} disabled={!canSave}>
        Save
      </Button>
    </>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[90vh] overflow-hidden rounded-t-2xl"
        >
          <SheetHeader className="shrink-0">
            <SheetTitle>Rename chat group</SheetTitle>
            <SheetDescription>
              Pick a name and icon for this group.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {body}
          </div>
          <SheetFooter className="shrink-0">{footer}</SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>Rename chat group</DialogTitle>
          <DialogDescription>
            Pick a name and icon for this group.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {body}
        </div>
        <DialogFooter className="shrink-0">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
