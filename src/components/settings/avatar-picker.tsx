"use client"

import { useLayoutEffect, useMemo, useState } from "react"

import { AvatarEditor } from "@/components/avatar/avatar-editor"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import {
  getContrastTextColor,
  normalizeAvatarColor,
  validateAvatarContent,
} from "@/lib/avatar"
import { useIsMobile } from "@/hooks/use-mobile"
import type { Avatar as AvatarShape } from "@/types"

interface AvatarPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: AvatarShape
  onChange: (avatar: AvatarShape) => void
  title?: string
  description?: string
}

interface AvatarDraftState {
  color: string
  content: string
  error: string | null
}

export function AvatarPicker({
  open,
  onOpenChange,
  value,
  onChange,
  title = "Edit avatar",
  description = "Choose a color and emoji or initials.",
}: AvatarPickerProps) {
  const isMobile = useIsMobile()
  const [draft, setDraft] = useState<AvatarDraftState>(() => ({
    color: value.color,
    content: value.content,
    error: null,
  }))
  const { color, content, error } = draft

  useLayoutEffect(() => {
    if (open) {
      setDraft({ color: value.color, content: value.content, error: null })
    }
  }, [open, value.color, value.content])

  const preview = useMemo(
    () => ({
      color: normalizeAvatarColor(color) ?? value.color,
      content: content.trim() || value.content,
    }),
    [color, content, value.color, value.content]
  )
  const previewTextColor = useMemo(
    () => getContrastTextColor(preview.color),
    [preview.color]
  )

  const handleSave = () => {
    const trimmed = content.trim()
    const normalizedColor = normalizeAvatarColor(color)
    if (!normalizedColor) {
      setDraft((prev) => ({ ...prev, error: "Choose a valid color." }))
      return
    }
    if (!validateAvatarContent(trimmed)) {
      setDraft((prev) => ({ ...prev, error: "Use 2 letters or a single emoji." }))
      return
    }
    onChange({ color: normalizedColor, content: trimmed })
    onOpenChange(false)
  }

  const body = (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Avatar size="xl">
          <AvatarFallback
            content={preview.content}
            style={{ backgroundColor: preview.color, color: previewTextColor }}
          >
            {preview.content}
          </AvatarFallback>
        </Avatar>
        <div className="text-sm text-muted-foreground">
          Pick a color and enter two letters or one emoji.
        </div>
      </div>

      <AvatarEditor
        shape="circle"
        allowInitials
        color={color}
        content={content}
        onColorChange={(nextColor) => {
          setDraft((prev) => ({ ...prev, color: nextColor, error: null }))
        }}
        onContentChange={(nextContent) => {
          setDraft((prev) => ({ ...prev, content: nextContent, error: null }))
        }}
        error={error}
      />
    </div>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[90vh] overflow-hidden rounded-t-2xl"
        >
          <SheetHeader className="shrink-0">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {body}
          </div>
          <SheetFooter className="shrink-0">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {body}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
