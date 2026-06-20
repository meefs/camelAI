"use client"

import { useEffect, useMemo, useState } from "react"

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

export function AvatarPicker({
  open,
  onOpenChange,
  value,
  onChange,
  title = "Edit avatar",
  description = "Choose a color and emoji or initials.",
}: AvatarPickerProps) {
  const isMobile = useIsMobile()
  const [color, setColor] = useState(value.color)
  const [content, setContent] = useState(value.content)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setColor(value.color)
      setContent(value.content)
      setError(null)
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
      setError("Choose a valid color.")
      return
    }
    if (!validateAvatarContent(trimmed)) {
      setError("Use 2 letters or a single emoji.")
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
          setColor(nextColor)
          setError(null)
        }}
        onContentChange={(nextContent) => {
          setContent(nextContent)
          setError(null)
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
