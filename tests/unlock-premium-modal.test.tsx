import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnlockPremiumModal } from "@/components/billing/unlock-premium-modal";
import type { UnlockPremiumModalVariant } from "@/components/billing/unlock-premium-modal";
import type { LlmModel } from "@/types";

function renderModal({
  triggerModel = "sonnet",
  isOrgAdmin = true,
  variant = "unlock",
}: {
  triggerModel?: LlmModel;
  isOrgAdmin?: boolean;
  variant?: UnlockPremiumModalVariant;
} = {}) {
  render(
    <UnlockPremiumModal
      open
      onOpenChange={vi.fn()}
      triggerModel={triggerModel}
      isOrgAdmin={isOrgAdmin}
      orgId="org_123"
      onSeePlans={vi.fn()}
      onTopUp={vi.fn()}
      onAddKey={vi.fn()}
      onOpenAiSignIn={vi.fn()}
      variant={variant}
    />,
  );
}

describe("UnlockPremiumModal", () => {
  it("keeps the methods in their static groups and marks OpenAI for GPT triggers", () => {
    renderModal({ triggerModel: "gpt-5.6-sol", isOrgAdmin: true });

    const camelAiTag = screen.getByText("Pay through camelAI");
    const existingPlanTag = screen.getByText("Use what you already pay for");
    expect(camelAiTag.tagName).toBe("SPAN");
    expect(existingPlanTag.tagName).toBe("SPAN");
    for (const tag of [camelAiTag, existingPlanTag]) {
      expect(tag).toHaveClass(
        "rounded-none",
        "bg-primary/10",
        "text-primary",
      );
    }
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(
      screen.getByText("Best value for GPT models"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("unlock-method-subscribe")).toHaveClass(
      "py-0",
      "ring-2",
      "ring-primary",
    );
    expect(screen.getByText("Subscribe")).toHaveClass(
      "text-sm",
      "font-medium",
    );
    expect(existingPlanTag.parentElement).toHaveClass("space-y-3", "pt-1");
    expect(
      screen
        .getAllByTestId(/^unlock-method-/)
        .map((element) => element.getAttribute("data-testid")),
    ).toEqual([
      "unlock-method-subscribe",
      "unlock-method-credits",
      "unlock-method-openai",
      "unlock-method-key",
    ]);

    const separator = document.querySelector('[data-slot="separator"]');
    const openAiMethod = screen.getByTestId("unlock-method-openai");
    const keyMethod = screen.getByTestId("unlock-method-key");
    expect(separator).not.toBeNull();
    expect(openAiMethod.compareDocumentPosition(separator!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(separator!.compareDocumentPosition(keyMethod)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it.each(["sonnet", "grok-4.5"] satisfies LlmModel[])(
    "does not show the OpenAI value badge for %s",
    (triggerModel) => {
      renderModal({ triggerModel, isOrgAdmin: true });

      expect(
        screen.queryByText("Best value for GPT models"),
      ).not.toBeInTheDocument();
    },
  );

  it("shows guidance without action buttons to non-admin members", () => {
    renderModal({ triggerModel: "sonnet", isOrgAdmin: false });

    expect(screen.getAllByText("Ask an org admin")).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "See plans" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Top up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add key" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "payg_credits_exhausted",
      "Out of credits",
      "used all your camelAI credits",
      "unlock-method-credits",
      "Buy credits",
    ],
    [
      "included_credits_exhausted",
      "Monthly credits used",
      "used this month's included credits",
      "unlock-method-credits",
      "Buy credits",
    ],
    [
      "trial_credits_exhausted",
      "Trial credits used",
      "used your trial credits",
      "unlock-method-subscribe",
      "Subscribe",
    ],
  ] satisfies Array<
    [
      UnlockPremiumModalVariant,
      string,
      string,
      string,
      string,
    ]
  >)(
    "renders the %s recovery variant",
    (variant, title, description, recommendedTestId, recommendedTitle) => {
      renderModal({ variant });

      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.getByText(new RegExp(description))).toBeInTheDocument();
      const recommended = screen.getByTestId(recommendedTestId);
      expect(recommended).toHaveClass("ring-2", "ring-primary");
      expect(recommended).toHaveTextContent(recommendedTitle);
      expect(screen.getAllByText("Recommended")).toHaveLength(1);
    },
  );

  it("offers an upgrade-plan row after included credits are used", () => {
    renderModal({ variant: "included_credits_exhausted" });

    expect(screen.getByText("Upgrade plan")).toBeInTheDocument();
    expect(
      screen.getByText("Higher plans include more monthly credits."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Extra credits on top of your plan. Available immediately.",
      ),
    ).toBeInTheDocument();
  });
});
