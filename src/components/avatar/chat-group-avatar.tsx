"use client"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ChatGroupIcon } from "@/components/avatar/chat-group-icon"
import { cn } from "@/lib/utils"
import type { ChatGroupAvatar as AvatarShape } from "@/types"

type ChatGroupAvatarSize = "sm" | "md" | "lg" | "xl"

// Chat group avatars read as a single, consistent idiom: a Lucide icon with no
// background or outline — just the glyph in a fixed muted color.
const iconSizeClasses: Record<ChatGroupAvatarSize, string> = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-6",
  xl: "size-9",
}

export function ChatGroupAvatar({
  avatar,
  fallbackName: _fallbackName,
  size = "sm",
  className,
}: {
  avatar: AvatarShape | null | undefined
  /** Unused; kept for API compatibility with call sites. */
  fallbackName?: string
  size?: ChatGroupAvatarSize
  className?: string
}) {
  const status = avatar?.status ?? "default"
  const isPending = status === "pending"
  const shouldAnimateContent = status === "generated" || status === "user"

  return (
    <Avatar
      size={size}
      shape="rounded"
      aria-hidden
      // No background fill and no outline (the primitive's ::after ring is
      // suppressed): the icon stands on its own.
      className={cn("shrink-0 after:hidden", className)}
    >
      <AvatarFallback className="bg-transparent text-muted-foreground">
        {isPending ? (
          <span
            aria-hidden
            className="size-1/2 animate-pulse rounded-[28%] bg-current opacity-30 motion-reduce:animate-none"
          />
        ) : (
          <ChatGroupIcon
            name={avatar?.content}
            className={cn(
              iconSizeClasses[size],
              shouldAnimateContent &&
                "animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none",
            )}
          />
        )}
      </AvatarFallback>
    </Avatar>
  )
}
