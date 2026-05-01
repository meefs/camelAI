import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  LegacyMigrationConfirmDialog,
  type LegacyMigrationConfirmation,
} from "@/components/billing/legacy-migration-confirm-dialog";

function makeConfirmation(
  overrides: Partial<LegacyMigrationConfirmation["preview"]> = {},
): LegacyMigrationConfirmation {
  return {
    billingPortalUrl: "https://billing.stripe.test/session",
    preview: {
      plan: "starter",
      seatCount: 1,
      currency: "usd",
      monthlyPriceCents: 4000,
      amountDueTodayCents: 996,
      legacyCreditCents: 3004,
      newPlanProrationCents: 4000,
      includedCreditCents: 1000,
      ...overrides,
    },
  };
}

describe("LegacyMigrationConfirmDialog", () => {
  it("explains the old subscription cancellation before Stripe", () => {
    render(
      <LegacyMigrationConfirmDialog
        confirmation={makeConfirmation()}
        onOpenChange={() => {}}
        onContinue={() => {}}
      />,
    );

    expect(
      screen.getByText(/will not renew or bill again next month/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not create a second subscription/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/estimated amount due/i)).not.toBeInTheDocument();
    expect(screen.queryByText("$9.96")).not.toBeInTheDocument();
  });

  it("continues to Stripe from the primary action", async () => {
    const user = userEvent.setup();
    const handleContinue = vi.fn();
    render(
      <LegacyMigrationConfirmDialog
        confirmation={makeConfirmation()}
        onOpenChange={() => {}}
        onContinue={handleContinue}
      />,
    );

    await user.click(screen.getByRole("button", { name: /continue to stripe/i }));

    expect(handleContinue).toHaveBeenCalledTimes(1);
  });
});
