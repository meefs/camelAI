"use client"

import { useEffect, useState } from "react"
import { HexColorPicker } from "react-colorful"

import { Input } from "@/components/ui/input"
import { normalizeAvatarColor } from "@/lib/avatar"
import { cn } from "@/lib/utils"

export function ColorPicker({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (hex: string) => void
  className?: string
}) {
  const normalized = normalizeAvatarColor(value) ?? "#3B82F6"
  const [draft, setDraft] = useState(normalized)

  useEffect(() => {
    setDraft(normalized)
  }, [normalized])

  const formatDraft = (next: string) => {
    const hex = next.replace(/^#/, "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6)
    return `#${hex.toUpperCase()}`
  }

  const setNormalizedColor = (next: string) => {
    const color = normalizeAvatarColor(next)
    if (!color) return
    setDraft(color)
    onChange(color)
  }

  const handleDraftChange = (next: string) => {
    const formatted = formatDraft(next)
    setDraft(formatted)
    const color = normalizeAvatarColor(formatted)
    if (color) onChange(color)
  }

  return (
    <div className={cn("space-y-2", className)}>
      <HexColorPicker
        color={normalized}
        onChange={setNormalizedColor}
        className="!h-40 !w-full"
      />
      <div className="flex items-center gap-2 rounded-md border px-3 py-2">
        <span
          aria-hidden
          className="size-4 rounded-sm border"
          style={{ backgroundColor: normalized }}
        />
        <Input
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          onBlur={() => {
            if (!normalizeAvatarColor(draft)) setDraft(normalized)
          }}
          inputMode="text"
          maxLength={7}
          className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 py-0 font-mono text-sm uppercase shadow-none focus-visible:border-transparent focus-visible:ring-0"
          aria-label="Custom avatar color"
        />
      </div>
    </div>
  )
}
