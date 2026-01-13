"use client"

import * as React from "react"
import { Avatar as AvatarPrimitive } from "radix-ui"

import { isEmoji } from "@/lib/avatar"
import { cn } from "@/lib/utils"

const avatarSizes = {
  "2xs": {
    container: "size-3.5",
    font1: "text-[8px]",
    font2: "text-[7px]",
  },
  xs: {
    container: "size-4",
    font1: "text-[9px]",
    font2: "text-[8px]",
  },
  sm: {
    container: "size-5",
    font1: "text-[11px]",
    font2: "text-[10px]",
  },
  md: {
    container: "size-6",
    font1: "text-[13px]",
    font2: "text-[12px]",
  },
  default: {
    container: "size-8",
    font1: "text-[16px]",
    font2: "text-[14px]",
  },
  lg: {
    container: "size-10",
    font1: "text-[20px]",
    font2: "text-[18px]",
  },
  xl: {
    container: "size-16",
    font1: "text-[32px]",
    font2: "text-[28px]",
  },
} as const

type AvatarSize = keyof typeof avatarSizes

const AvatarSizeContext = React.createContext<AvatarSize>("default")

function getCharacterCount(content: string): 1 | 2 {
  const trimmed = content.trim()
  if (!trimmed) return 2
  if (isEmoji(trimmed)) return 1
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null
  const segments = segmenter
    ? Array.from(segmenter.segment(trimmed), (segment) => segment.segment)
    : Array.from(trimmed)
  return segments.length <= 1 ? 1 : 2
}

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: AvatarSize
}) {
  return (
    <AvatarSizeContext.Provider value={size}>
      <AvatarPrimitive.Root
        data-slot="avatar"
        data-size={size}
        className={cn(
          "rounded-full after:rounded-full after:border-border group/avatar relative flex shrink-0 select-none after:absolute after:inset-0 after:border after:mix-blend-darken dark:after:mix-blend-lighten",
          avatarSizes[size]?.container ?? avatarSizes.default.container,
          className
        )}
        {...props}
      />
    </AvatarSizeContext.Provider>
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "rounded-full aspect-square size-full object-cover",
        className
      )}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  content,
  children,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback> & {
  content?: string
}) {
  const size = React.useContext(AvatarSizeContext)
  const fallbackContent =
    typeof content === "string"
      ? content
      : typeof children === "string"
        ? children
        : ""
  const charCount = fallbackContent ? getCharacterCount(fallbackContent) : 2
  const sizeClasses = avatarSizes[size] ?? avatarSizes.default
  const fontClass = charCount === 1 ? sizeClasses.font1 : sizeClasses.font2
  const displayContent = children ?? content

  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted text-muted-foreground rounded-full flex size-full items-center justify-center",
        fontClass,
        className
      )}
      {...props}
    >
      {displayContent}
    </AvatarPrimitive.Fallback>
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "bg-primary text-primary-foreground ring-background absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-blend-color ring-2 select-none",
        "group-data-[size=2xs]/avatar:size-1.5 group-data-[size=2xs]/avatar:[&>svg]:hidden",
        "group-data-[size=xs]/avatar:size-1.5 group-data-[size=xs]/avatar:[&>svg]:hidden",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=md]/avatar:size-2 group-data-[size=md]/avatar:[&>svg]:size-2",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2.5",
        "group-data-[size=xl]/avatar:size-3.5 group-data-[size=xl]/avatar:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "*:data-[slot=avatar]:ring-background group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "bg-muted text-muted-foreground rounded-full text-xs/relaxed ring-background relative flex shrink-0 items-center justify-center ring-2",
        "size-8 group-has-data-[size=2xs]/avatar-group:size-3.5 group-has-data-[size=xs]/avatar-group:size-4 group-has-data-[size=sm]/avatar-group:size-5 group-has-data-[size=md]/avatar-group:size-6 group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=xl]/avatar-group:size-16",
        "[&>svg]:size-4 group-has-data-[size=2xs]/avatar-group:[&>svg]:size-2 group-has-data-[size=xs]/avatar-group:[&>svg]:size-2.5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3 group-has-data-[size=md]/avatar-group:[&>svg]:size-3.5 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=xl]/avatar-group:[&>svg]:size-6",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
}
