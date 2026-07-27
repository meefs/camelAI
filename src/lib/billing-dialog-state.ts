import type { LlmModel } from "@/types";
import type { ModelPausedReason } from "@/lib/model-picker-access";

export type BillingDialogState =
  | { kind: "none" }
  | { kind: "welcome" }
  | { kind: "unlock"; triggerModel: LlmModel | null }
  | { kind: "plans" }
  | { kind: "topup" }
  | { kind: "byok" }
  | { kind: "openai" };

export interface BillingDialogTransition {
  state: BillingDialogState;
  shouldRecordWelcomeDismissal: boolean;
}

export function transitionBillingDialogState(
  previous: BillingDialogState,
  next: BillingDialogState,
): BillingDialogTransition {
  return {
    state: next,
    shouldRecordWelcomeDismissal: previous.kind === "welcome",
  };
}

export function getWelcomeAutoOpenState(
  current: BillingDialogState,
  autoOpenedIdentityKeys: ReadonlySet<string>,
  identityKey: string | null,
  shouldShowWelcome: boolean,
): BillingDialogState | null {
  if (
    current.kind !== "none" ||
    !identityKey ||
    autoOpenedIdentityKeys.has(identityKey) ||
    !shouldShowWelcome
  ) {
    return null;
  }

  return { kind: "welcome" };
}

export function getBillingDialogIdentityKey(
  userId: string | null | undefined,
  orgId: string | null | undefined,
): string | null {
  return userId && orgId ? JSON.stringify([userId, orgId]) : null;
}

export function hasActiveBillingDialog(
  current: BillingDialogState,
  isExternalDialogOpen: boolean,
): boolean {
  return current.kind !== "none" || isExternalDialogOpen;
}

export function shouldNavigateToBillingForPausedModel(
  reason: ModelPausedReason | null | undefined,
  isOrgAdmin: boolean,
): boolean {
  return isOrgAdmin && reason === "subscription_unavailable";
}
