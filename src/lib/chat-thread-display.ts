import type { UIMessage } from "ai";
import type { TodoItem } from "@/components/floating-todo";
import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
import type { Message } from "@/types";

/**
 * Message-bearing fields of the chat loader payload that an instant-paint
 * snapshot overrides on a thread switch. `initialUiMessages` seeds the remounted
 * Chat/useAgentChat, so it MUST be overridden alongside `messages`/`todos`.
 */
export interface DisplaySnapshotFields {
  messages: Message[];
  initialUiMessages: UIMessage[];
  todos: TodoItem[];
}

/**
 * Merge the instant-paint snapshot over the loader payload for a thread switch.
 * When a cached snapshot drives the render, EVERY message-bearing field comes
 * from the snapshot — including `initialUiMessages`. Reusing the loader's
 * `initialUiMessages` here would seed the newly-selected thread with the PREVIOUS
 * loader result's render history and briefly paint another thread's transcript
 * (Chat prefers non-empty `piChat.messages` over the legacy fallback) until the
 * second loader fetch resolves.
 */
export function resolveDisplayChatData<T extends DisplaySnapshotFields>(
  resolvedChatData: T,
  cachedSnapshot: ChatThreadSnapshot | null,
  shouldUseCachedSnapshot: boolean,
): T {
  if (!shouldUseCachedSnapshot || !cachedSnapshot) return resolvedChatData;
  return {
    ...resolvedChatData,
    messages: cachedSnapshot.messages,
    initialUiMessages: cachedSnapshot.uiMessages,
    todos: cachedSnapshot.todos,
  };
}
