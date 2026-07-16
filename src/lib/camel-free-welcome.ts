interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type BillingAccessMode =
  | "enterprise"
  | "subscription"
  | "byok"
  | "credits"
  | "selfhost"
  | "camel_free"
  | null;

export function getCamelFreeWelcomeStorageKey(
  userId: string,
  orgId: string,
): string {
  return `camel-free-welcome-dismissed:${userId}:${orgId}`;
}

export function shouldShowCamelFreeWelcome(
  storage: StorageLike,
  {
    billingAccessMode,
    userId,
    orgId,
    hasActiveThread,
  }: {
    billingAccessMode: BillingAccessMode;
    userId: string | null;
    orgId: string | null;
    hasActiveThread: boolean;
  },
): boolean {
  if (
    billingAccessMode !== "camel_free" ||
    !userId ||
    !orgId ||
    hasActiveThread
  ) {
    return false;
  }

  try {
    return storage.getItem(getCamelFreeWelcomeStorageKey(userId, orgId)) === null;
  } catch {
    return false;
  }
}

export function recordCamelFreeWelcomeDismissal(
  storage: StorageLike,
  userId: string | null,
  orgId: string | null,
): void {
  if (!userId || !orgId) return;

  try {
    storage.setItem(getCamelFreeWelcomeStorageKey(userId, orgId), "1");
  } catch {
    // Storage is optional. The dialog remains dismissed for this render.
  }
}
