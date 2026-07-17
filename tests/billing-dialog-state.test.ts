import { describe, expect, it } from "vitest";
import {
  getBillingDialogIdentityKey,
  getWelcomeAutoOpenState,
  hasActiveBillingDialog,
  transitionBillingDialogState,
  type BillingDialogState,
} from "@/lib/billing-dialog-state";
import {
  recordCamelCodeWelcomeDismissal,
  shouldShowCamelCodeWelcome,
} from "@/lib/camel-code-welcome";

describe("billing dialog state", () => {
  it("transitions welcome to unlock with a dismissal effect and only unlock active", () => {
    const transition = transitionBillingDialogState(
      { kind: "welcome" },
      { kind: "unlock", triggerModel: null },
    );

    expect(transition).toEqual({
      state: { kind: "unlock", triggerModel: null },
      shouldRecordWelcomeDismissal: true,
    });
  });

  it("does not auto-open welcome while another billing dialog is active", () => {
    expect(
      getWelcomeAutoOpenState(
        { kind: "unlock", triggerModel: "sonnet" },
        new Set(),
        getBillingDialogIdentityKey("user_123", "org_123"),
        true,
      ),
    ).toBeNull();
  });

  it("includes billing dialogs owned outside Chat in the active-dialog guard", () => {
    expect(hasActiveBillingDialog({ kind: "none" }, true)).toBe(true);
    expect(hasActiveBillingDialog({ kind: "none" }, false)).toBe(false);
  });

  it("auto-opens once per user and org when dismissal persistence fails", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
    const welcomeContext = {
      billingAccessMode: "camel_free" as const,
      userId: "user_123",
      orgId: "org_123",
      hasActiveThread: false,
    };
    let state: BillingDialogState = { kind: "none" };
    const autoOpenedIdentityKeys = new Set<string>();
    const orgAIdentityKey = getBillingDialogIdentityKey(
      welcomeContext.userId,
      welcomeContext.orgId,
    );
    expect(orgAIdentityKey).not.toBeNull();

    const firstAutoOpen = getWelcomeAutoOpenState(
      state,
      autoOpenedIdentityKeys,
      orgAIdentityKey,
      shouldShowCamelCodeWelcome(storage, welcomeContext),
    );
    expect(firstAutoOpen).toEqual({ kind: "welcome" });
    state = firstAutoOpen!;
    autoOpenedIdentityKeys.add(orgAIdentityKey!);

    const closeTransition = transitionBillingDialogState(state, {
      kind: "none",
    });
    expect(closeTransition.shouldRecordWelcomeDismissal).toBe(true);
    expect(() =>
      recordCamelCodeWelcomeDismissal(
        storage,
        welcomeContext.userId,
        welcomeContext.orgId,
      ),
    ).not.toThrow();
    state = closeTransition.state;

    expect(shouldShowCamelCodeWelcome(storage, welcomeContext)).toBe(true);
    expect(
      getWelcomeAutoOpenState(
        state,
        autoOpenedIdentityKeys,
        orgAIdentityKey,
        shouldShowCamelCodeWelcome(storage, welcomeContext),
      ),
    ).toBeNull();

    const orgBContext = { ...welcomeContext, orgId: "org_456" };
    const orgBIdentityKey = getBillingDialogIdentityKey(
      orgBContext.userId,
      orgBContext.orgId,
    );
    expect(
      getWelcomeAutoOpenState(
        state,
        autoOpenedIdentityKeys,
        orgBIdentityKey,
        shouldShowCamelCodeWelcome(storage, orgBContext),
      ),
    ).toEqual({ kind: "welcome" });

    autoOpenedIdentityKeys.add(orgBIdentityKey!);
    expect(
      getWelcomeAutoOpenState(
        state,
        autoOpenedIdentityKeys,
        orgAIdentityKey,
        shouldShowCamelCodeWelcome(storage, welcomeContext),
      ),
    ).toBeNull();
  });
});
