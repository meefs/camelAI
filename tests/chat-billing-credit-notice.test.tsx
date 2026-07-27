import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingCreditNotice } from "@/components/chat-billing-credit-notice";
import type { BillingCreditStatus } from "@/lib/chat-credit-status";
import type { ModelPausedReason } from "@/lib/model-picker-access";

const exhaustedStatus: BillingCreditStatus = {
  availableCreditsCents: 0,
  totalCreditLimitCents: 1_000,
  isExhausted: true,
  hasByokProvider: false,
};

function renderNotice(
  pauseReason: ModelPausedReason | null,
  canTopUp = true,
) {
  return render(
    <BillingCreditNotice
      status={exhaustedStatus}
      onOpenUsage={vi.fn()}
      onTopUp={vi.fn()}
      canTopUp={canTopUp}
      pauseReason={pauseReason}
    />,
  );
}

describe("BillingCreditNotice", () => {
  afterEach(cleanup);

  it.each([
    [
      "payg_credits_exhausted",
      "Out of hosted credits",
      "camelCode is still available. Add credits to restore premium models.",
    ],
    [
      "included_credits_exhausted",
      "Plan credits used",
      "camelCode is still available. Premium models return at renewal or after adding credits.",
    ],
    [
      "trial_credits_exhausted",
      "Trial credits used",
      "camelCode is still available. Upgrade or add credits to restore premium models.",
    ],
    [
      "subscription_unavailable",
      "Payment issue",
      "camelCode is still available. Fix payment to restore premium models.",
    ],
  ] satisfies Array<[ModelPausedReason, string, string]>)(
    "shows direct %s pause guidance",
    (pauseReason, title, description) => {
      const { container } = renderNotice(pauseReason);

      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      expect(container).not.toHaveTextContent(/this month|keep going/i);
      expect(container.textContent).not.toContain("\u2014");
    },
  );

  it("directs members to an admin without implying camelCode is blocked", () => {
    renderNotice("trial_credits_exhausted", false);

    expect(
      screen.getByText(
        "camelCode is still available. Ask an admin to upgrade or add credits.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Top up" }),
    ).not.toBeInTheDocument();
  });

  it("omits the top-up action for payment issues", () => {
    renderNotice("subscription_unavailable");

    expect(screen.getByText("Payment issue")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Top up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View usage" }),
    ).toBeInTheDocument();
  });

  it("removes the monthly claim from generic exhausted-credit copy", () => {
    const { container } = renderNotice(null);

    expect(screen.getByText("You're out of hosted credits")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("this month");
  });
});
