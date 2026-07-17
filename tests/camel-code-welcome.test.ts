import { describe, expect, it } from "vitest";
import {
  getCamelCodeWelcomeStorageKey,
  recordCamelCodeWelcomeDismissal,
  shouldShowCamelCodeWelcome,
} from "@/lib/camel-code-welcome";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const context = {
  billingAccessMode: "camel_free" as const,
  userId: "user_123",
  orgId: "org_123",
  hasActiveThread: false,
};

describe("camelCode welcome", () => {
  it("shows only for an eligible new camelCode chat", () => {
    const storage = new MemoryStorage();

    expect(shouldShowCamelCodeWelcome(storage, context)).toBe(true);
    expect(
      shouldShowCamelCodeWelcome(storage, {
        ...context,
        billingAccessMode: "subscription",
      }),
    ).toBe(false);
    expect(
      shouldShowCamelCodeWelcome(storage, {
        ...context,
        hasActiveThread: true,
      }),
    ).toBe(false);
  });

  it("reuses the existing dismissal key and never shows after a close", () => {
    const storage = new MemoryStorage();

    recordCamelCodeWelcomeDismissal(storage, context.userId, context.orgId);

    expect(
      getCamelCodeWelcomeStorageKey(context.userId, context.orgId),
    ).toBe("camel-free-welcome-dismissed:user_123:org_123");
    expect(
      storage.getItem(
        "camel-free-welcome-dismissed:user_123:org_123",
      ),
    ).toBe("1");
    expect(shouldShowCamelCodeWelcome(storage, context)).toBe(false);
  });

  it("does not auto-open when storage is unavailable", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(shouldShowCamelCodeWelcome(unavailableStorage, context)).toBe(false);
  });
});
