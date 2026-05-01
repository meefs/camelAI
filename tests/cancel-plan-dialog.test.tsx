import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CancelPlanDialog } from "@/components/billing/cancel-plan-dialog";

const fetcherState = vi.hoisted(() => ({
  current: {
    state: "idle",
    data: undefined as { billingPortalUrl?: string; error?: string } | undefined,
    submit: vi.fn(),
  },
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useFetcher: () => fetcherState.current,
  };
});

describe("CancelPlanDialog", () => {
  beforeEach(() => {
    fetcherState.current = {
      state: "idle",
      data: undefined,
      submit: vi.fn(),
    };
  });

  it("redirects to the Stripe billing portal when cancellation action returns a portal URL", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    fetcherState.current.data = {
      billingPortalUrl: "https://billing.stripe.test/session",
    };

    render(
      <CancelPlanDialog
        open
        onOpenChange={vi.fn()}
        planLabel="Pro"
        periodEndLabel="May 31, 2026"
      />,
    );

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        "https://billing.stripe.test/session",
      );
    });
  });
});
