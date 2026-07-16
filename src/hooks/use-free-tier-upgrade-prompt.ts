import { useEffect, useRef } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function recordFreeCompletedTurn(
  storage: StorageLike,
  {
    userId,
    orgId,
    completedTurnId,
    isOrgAdmin,
    isAnyBillingDialogOpen,
  }: {
    userId: string;
    orgId: string;
    completedTurnId: string;
    isOrgAdmin: boolean;
    isAnyBillingDialogOpen: boolean;
  },
): boolean {
  try {
    const counterKey = `free-completed-turns:${userId}:${orgId}`;
    const lastCountedTurnKey = `free-last-counted-turn:${userId}:${orgId}`;
    const shownKey = `upgrade-auto-shown:${userId}:${orgId}`;
    if (storage.getItem(lastCountedTurnKey) === completedTurnId) {
      return false;
    }

    const storedCount = Number.parseInt(
      storage.getItem(counterKey) ?? "0",
      10,
    );
    const nextCount =
      (Number.isFinite(storedCount) ? Math.max(0, storedCount) : 0) + 1;
    storage.setItem(lastCountedTurnKey, completedTurnId);
    storage.setItem(counterKey, String(nextCount));

    if (nextCount < 2 || storage.getItem(shownKey) !== null || !isOrgAdmin) {
      return false;
    }

    storage.setItem(shownKey, "1");
    return !isAnyBillingDialogOpen;
  } catch {
    return false;
  }
}

export function useFreeTierUpgradePrompt({
  freshlyCompletedTurnId,
  enabled,
  userId,
  orgId,
  isOrgAdmin,
  isAnyBillingDialogOpen,
  onShow,
}: {
  freshlyCompletedTurnId: string | null;
  enabled: boolean;
  userId: string | null;
  orgId: string | null;
  isOrgAdmin: boolean;
  isAnyBillingDialogOpen: boolean;
  onShow: () => void;
}) {
  const processedTurnRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !freshlyCompletedTurnId || !userId || !orgId) return;
    const turnKey = `${userId}:${orgId}:${freshlyCompletedTurnId}`;
    if (processedTurnRef.current === turnKey) return;
    processedTurnRef.current = turnKey;

    try {
      if (
        recordFreeCompletedTurn(window.localStorage, {
          userId,
          orgId,
          completedTurnId: freshlyCompletedTurnId,
          isOrgAdmin,
          isAnyBillingDialogOpen,
        })
      ) {
        onShow();
      }
    } catch {
      // Storage is optional. Never interrupt a completed chat turn.
    }
  }, [
    enabled,
    freshlyCompletedTurnId,
    isAnyBillingDialogOpen,
    isOrgAdmin,
    onShow,
    orgId,
    userId,
  ]);
}
