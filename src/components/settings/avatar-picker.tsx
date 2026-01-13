"use client"

import { useEffect, useMemo, useState } from "react"

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
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { AVATAR_COLORS, getContrastTextColor, validateAvatarContent } from "@/lib/avatar"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import type { Avatar as AvatarShape } from "@/types"

const EMOJI_OPTIONS = [
  "😀",
  "😎",
  "🤖",
  "👽",
  "🦊",
  "🐱",
  "🐶",
  "🦁",
  "🐼",
  "🦄",
  "🌿",
  "🍄",
  "🌞",
  "🌙",
  "⭐",
  "⚡",
  "🔥",
  "🌊",
  "🎯",
  "🎧",
  "🎮",
  "🧠",
  "💡",
  "📌",
  "🚀",
  "🪐",
  "🧩",
  "🎨",
]

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
  description = "Choose a color and initials or emoji.",
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
    () => ({ color, content: content.trim() || value.content }),
    [color, content, value.content]
  )
  const previewTextColor = useMemo(
    () => getContrastTextColor(preview.color),
    [preview.color]
  )

  const handleSave = () => {
    const trimmed = content.trim()
    if (!validateAvatarContent(trimmed)) {
      setError("Use 2 letters or a single emoji.")
      return
    }
    onChange({ color, content: trimmed })
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

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Color</p>
        <div className="grid grid-cols-8 gap-2">
          {AVATAR_COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setColor(preset)}
              className={cn(
                "h-7 w-7 rounded-full border border-border",
                color === preset && "ring-2 ring-foreground"
              )}
              style={{ backgroundColor: preset }}
              aria-label={`Select color ${preset}`}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Quick emoji</p>
        <div className="grid grid-cols-9 gap-2">
          {EMOJI_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                setContent(emoji)
                setError(null)
              }}
              className="rounded-md border border-border p-1.5 text-lg leading-none hover:border-primary/50"
              aria-label={`Select ${emoji} avatar`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor="avatar-content"
        >
          Or enter custom initials
        </label>
        <Input
          id="avatar-content"
          value={content}
          onChange={(event) => {
            setContent(event.target.value)
            setError(null)
          }}
          placeholder="JS"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="py-6">{body}</div>
          <SheetFooter>
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
