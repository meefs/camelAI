"use client"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { getContrastTextColor, isEmoji, normalizeAvatarColor } from "@/lib/avatar"
import { cn } from "@/lib/utils"
import type { ChatGroupAvatar as AvatarShape } from "@/types"

type ChatGroupAvatarSize = "sm" | "md" | "lg" | "xl"

export function ChatGroupAvatar({
  avatar,
  fallbackName,
  size = "sm",
  className,
}: {
  avatar: AvatarShape | null | undefined
  fallbackName?: string
  size?: ChatGroupAvatarSize
  className?: string
}) {
  const color = normalizeAvatarColor(avatar?.color) ?? "#3B82F6"
  const emoji = avatar?.content?.trim()
  const status = avatar?.status ?? "fallback"
  const fallbackInitial = Array.from(fallbackName?.trim() || "?")[0] ?? "?"
  const content =
    (emoji && isEmoji(emoji) ? emoji : "") ||
    fallbackInitial.toUpperCase()
  const isPending = status === "pending"
  const shouldAnimateContent =
    isEmoji(content) && (status === "generated" || status === "user")

  return (
    <Avatar
      size={size}
      shape="rounded"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <AvatarFallback
        content={content}
        style={{
          backgroundColor: color,
          color: getContrastTextColor(color),
        }}
      >
        {isPending ? (
          <span
            aria-hidden
            className="size-1/2 animate-pulse rounded-[28%] bg-current opacity-30 motion-reduce:animate-none"
          />
        ) : (
          <span
            className={cn(
              "leading-none",
              shouldAnimateContent &&
                "animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none",
            )}
          >
            {content}
          </span>
        )}
      </AvatarFallback>
    </Avatar>
  )
}
