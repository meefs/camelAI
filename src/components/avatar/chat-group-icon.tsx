"use client"

import type { SVGProps } from "react"

import lucideSpriteUrl from "@/assets/lucide-icon-sprite.generated.svg?url"
import { resolveChatGroupIconName } from "@/lib/chat-group-icons"

type ChatGroupIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name?: string | null
}

/**
 * Renders any supported chat-group icon from one generated Lucide SVG sprite.
 * The external symbol keeps the full catalog out of the JavaScript module graph.
 */
export function ChatGroupIcon({ name, className, ...props }: ChatGroupIconProps) {
  const iconName = resolveChatGroupIconName(name)

  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-lucide={iconName}
    >
      <use href={`${lucideSpriteUrl}#${iconName}`} />
    </svg>
  )
}
