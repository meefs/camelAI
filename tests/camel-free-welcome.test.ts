import { describe, expect, it } from "vitest";
import {
  recordCamelFreeWelcomeDismissal,
  shouldShowCamelFreeWelcome,
} from "@/lib/camel-free-welcome";

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

describe("Camel Free welcome", () => {
  it("shows only for an eligible new Camel Free chat", () => {
    const storage = new MemoryStorage();

    expect(shouldShowCamelFreeWelcome(storage, context)).toBe(true);
    expect(
      shouldShowCamelFreeWelcome(storage, {
        ...context,
        billingAccessMode: "subscription",
      }),
    ).toBe(false);
    expect(
      shouldShowCamelFreeWelcome(storage, {
        ...context,
        hasActiveThread: true,
      }),
    ).toBe(false);
  });

  it("reuses the existing dismissal key and never shows after a close", () => {
    const storage = new MemoryStorage();

    recordCamelFreeWelcomeDismissal(storage, context.userId, context.orgId);

    expect(
      storage.getItem(
        "camel-free-welcome-dismissed:user_123:org_123",
      ),
    ).toBe("1");
    expect(shouldShowCamelFreeWelcome(storage, context)).toBe(false);
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

    expect(shouldShowCamelFreeWelcome(unavailableStorage, context)).toBe(false);
  });
});
