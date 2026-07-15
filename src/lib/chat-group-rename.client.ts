import { toast } from "sonner"

import type { Avatar } from "@/types"

export type ChatGroupRenameInput = {
  name: string
  avatar?: Avatar
}

type SaveChatGroupRenameOptions = {
  fetchFn?: typeof fetch
  dispatchEvent?: (event: Event) => boolean
  revalidate?: () => void
  now?: () => number
}

export async function saveChatGroupRename(
  groupId: string | null | undefined,
  next: ChatGroupRenameInput,
  {
    fetchFn = fetch,
    dispatchEvent = (event) => window.dispatchEvent(event),
    revalidate,
    now = Date.now,
  }: SaveChatGroupRenameOptions = {},
) {
  if (!groupId) return

  const response = await fetchFn(
    `/api/chat-groups/${encodeURIComponent(groupId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    },
  )

  if (response.ok) {
    if (next.avatar) {
      dispatchEvent(
        new CustomEvent("camelai:chat-group-avatar", {
          detail: {
            groupId,
            avatar: { ...next.avatar, status: "user" },
            updatedAt: now(),
          },
        }),
      )
    }
    toast.success("Chat group updated")
  } else {
    toast.error("Failed to update chat group")
  }

  revalidate?.()
}
