"use server"

import * as authDO from "@/lib/auth-do"
import { validateAvatarContent } from "@/lib/avatar"
import { requireUser } from "@/lib/server-guards"
import type { User } from "@/types"

interface UpdateUserProfileInput {
  name?: string | null
  avatar?: { color: string; content: string }
}

function toSafeUser(user: User): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
    avatar: {
      color: user.avatar.color,
      content: user.avatar.content,
    },
    is_orphaned: user.is_orphaned,
  }
}

export async function updateUserProfile(input: UpdateUserProfileInput) {
  const { user } = await requireUser()

  const updates: UpdateUserProfileInput = {}

  if (input.name !== undefined) {
    const trimmed = input.name?.trim() || null
    if (trimmed && trimmed.length > 100) {
      throw new Error("Name must be 100 characters or less")
    }
    updates.name = trimmed
  }

  if (input.avatar) {
    if (!validateAvatarContent(input.avatar.content)) {
      throw new Error("Invalid avatar content")
    }
    updates.avatar = {
      color: input.avatar.color,
      content: input.avatar.content.trim(),
    }
  }

  const updated = await authDO.updateUserProfile(user.id, updates)
  if (!updated) {
    throw new Error("User not found")
  }

  return toSafeUser(updated)
}
