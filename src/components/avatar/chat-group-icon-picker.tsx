"use client"

import { Search } from "lucide-react"
import { useMemo, useState } from "react"

import { ChatGroupIcon } from "@/components/avatar/chat-group-icon"
import { Input } from "@/components/ui/input"
import { POPULAR_CHAT_GROUP_ICONS } from "@/lib/chat-group-icons"
import { LUCIDE_ICON_NAMES } from "@/lib/lucide-icon-names.generated"
import { cn } from "@/lib/utils"

const MAX_SEARCH_RESULTS = 90

function humanizeIconName(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export function ChatGroupIconPicker({
  value,
  onSelect,
  className,
}: {
  value?: string
  onSelect: (name: string) => void
  className?: string
}) {
  const [search, setSearch] = useState("")
  const names = useMemo(() => {
    const query = search.trim().toLowerCase().replace(/\s+/g, "-")
    if (!query) return POPULAR_CHAT_GROUP_ICONS
    return LUCIDE_ICON_NAMES.filter((name) => name.includes(query)).slice(
      0,
      MAX_SEARCH_RESULTS,
    )
  }, [search])

  return (
    <div className={cn("space-y-2", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search all icons"
          aria-label="Search icons"
          className="pl-8"
        />
      </div>
      <div className="rounded-md border bg-popover">
        <div className="max-h-[13.5rem] overflow-y-auto p-2">
          {names.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">
              No icons found.
            </div>
          ) : (
            <div className="grid grid-cols-8 gap-1">
              {names.map((name) => {
                const isSelected = value === name
                const label = humanizeIconName(name)
                return (
                  <button
                    key={name}
                    type="button"
                    className={cn(
                      "grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected && "bg-accent text-foreground ring-2 ring-ring",
                    )}
                    onClick={() => onSelect(name)}
                    aria-label={`Select ${label}`}
                    aria-pressed={isSelected}
                    title={label}
                  >
                    <ChatGroupIcon name={name} className="size-4" />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
