import { describe, expect, it } from "vitest";
import { recordFreeCompletedTurn } from "@/hooks/use-free-tier-upgrade-prompt";

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
  userId: "user_123",
  orgId: "org_123",
  completedTurnId: "turn_1",
  isOrgAdmin: true,
  isAnyBillingDialogOpen: false,
};

describe("free-tier automatic upgrade prompt", () => {
  it("shows on the second completed turn and only once", () => {
    const storage = new MemoryStorage();

    expect(recordFreeCompletedTurn(storage, context)).toBe(false);
    expect(
      recordFreeCompletedTurn(storage, {
        ...context,
        completedTurnId: "turn_2",
      }),
    ).toBe(true);
    expect(
      recordFreeCompletedTurn(storage, {
        ...context,
        completedTurnId: "turn_3",
      }),
    ).toBe(false);
    expect(storage.getItem("free-completed-turns:user_123:org_123")).toBe("3");
    expect(storage.getItem("upgrade-auto-shown:user_123:org_123")).toBe("1");
  });

  it("counts the same completed turn only once across hook remounts", () => {
    const storage = new MemoryStorage();

    expect(recordFreeCompletedTurn(storage, context)).toBe(false);
    expect(recordFreeCompletedTurn(storage, context)).toBe(false);
    expect(storage.getItem("free-completed-turns:user_123:org_123")).toBe("1");
    expect(
      storage.getItem("free-last-counted-turn:user_123:org_123"),
    ).toBe("turn_1");

    expect(
      recordFreeCompletedTurn(storage, {
        ...context,
        completedTurnId: "turn_2",
      }),
    ).toBe(true);
  });

  it("marks the impression consumed when another billing dialog is open", () => {
    const storage = new MemoryStorage();
    recordFreeCompletedTurn(storage, context);

    expect(
      recordFreeCompletedTurn(storage, {
        ...context,
        completedTurnId: "turn_2",
        isAnyBillingDialogOpen: true,
      }),
    ).toBe(false);
    expect(storage.getItem("upgrade-auto-shown:user_123:org_123")).toBe("1");
  });

  it("never shows to a non-admin member", () => {
    const storage = new MemoryStorage();

    recordFreeCompletedTurn(storage, { ...context, isOrgAdmin: false });
    expect(
      recordFreeCompletedTurn(storage, {
        ...context,
        completedTurnId: "turn_2",
        isOrgAdmin: false,
      }),
    ).toBe(false);
    expect(storage.getItem("upgrade-auto-shown:user_123:org_123")).toBeNull();
  });

  it("skips silently when storage is unavailable", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(recordFreeCompletedTurn(unavailableStorage, context)).toBe(false);
  });
});
