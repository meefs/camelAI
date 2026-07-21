import { toast } from "sonner";

import { writePinnedGroupCountHint } from "@/lib/pinned-groups-cookie";

interface SaveChatGroupPinnedArgs {
  groupId: string;
  workspaceId: string;
  pinned: boolean;
  currentPinnedAt: number | null;
  currentPinnedCount: number;
  revalidate?: () => void;
}

interface SaveChatGroupPinnedDependencies {
  fetchFn?: typeof fetch;
  dispatchEvent?: (event: Event) => boolean;
  writePinnedCountHint?: typeof writePinnedGroupCountHint;
  showError?: (message: string) => void;
  now?: () => number;
}

function createPinnedEvent(groupId: string, pinnedAt: number | null): Event {
  return new CustomEvent("camelai:chat-group-pinned", {
    detail: { groupId, pinnedAt },
  });
}

export async function saveChatGroupPinned(
  {
    groupId,
    workspaceId,
    pinned,
    currentPinnedAt,
    currentPinnedCount,
    revalidate,
  }: SaveChatGroupPinnedArgs,
  {
    fetchFn = fetch,
    dispatchEvent = (event) => window.dispatchEvent(event),
    writePinnedCountHint = writePinnedGroupCountHint,
    showError = (message) => toast.error(message),
    now = Date.now,
  }: SaveChatGroupPinnedDependencies = {},
): Promise<boolean> {
  const optimisticPinnedAt = pinned ? now() : null;
  dispatchEvent(createPinnedEvent(groupId, optimisticPinnedAt));
  writePinnedCountHint(
    workspaceId,
    currentPinnedCount + (pinned ? 1 : -1),
  );

  let saved = false;
  try {
    const response = await fetchFn(
      `/api/chat-groups/${encodeURIComponent(groupId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      },
    );
    saved = response.ok;
  } catch {
    // The optimistic update is reverted below for both network and HTTP errors.
  }

  if (saved) {
    revalidate?.();
    return true;
  }

  dispatchEvent(createPinnedEvent(groupId, currentPinnedAt));
  writePinnedCountHint(workspaceId, currentPinnedCount);
  showError(
    pinned
      ? "Couldn't pin group. Please try again."
      : "Couldn't unpin group. Please try again.",
  );
  revalidate?.();
  return false;
}
