import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CancelPlanDialog } from "@/components/billing/cancel-plan-dialog";

const toastSuccessMock = vi.hoisted(() => vi.fn());

const fetcherState = vi.hoisted(() => ({
  current: {
    state: "idle",
    data: undefined as
      | {
          billingPortalUrl?: string;
          cancellationScheduled?: boolean;
          cancellationDateMs?: number | null;
          error?: string;
        }
      | undefined,
    submit: vi.fn(),
  },
  revalidate: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useFetcher: () => fetcherState.current,
    useRevalidator: () => ({
      state: "idle",
      revalidate: fetcherState.revalidate,
    }),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
  },
}));

describe("CancelPlanDialog", () => {
  beforeEach(() => {
    fetcherState.current = {
      state: "idle",
      data: undefined,
      submit: vi.fn(),
    };
    fetcherState.revalidate.mockClear();
    toastSuccessMock.mockClear();
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

  it("closes, revalidates, and toasts when cancellation is already scheduled", async () => {
    const onOpenChange = vi.fn();
    fetcherState.current.data = {
      cancellationScheduled: true,
      cancellationDateMs: Date.UTC(2026, 4, 8, 12),
    };

    render(
      <CancelPlanDialog
        open
        onOpenChange={onOpenChange}
        planLabel="Pro"
        periodEndLabel="May 31, 2026"
      />,
    );

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(fetcherState.revalidate).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("Plan cancels May 8, 2026.");
    expect(
      screen.queryByText("We couldn't open your cancellation flow."),
    ).not.toBeInTheDocument();
  });

  it("does not render an accidental error when cancellation success wins", async () => {
    fetcherState.current.data = {
      cancellationScheduled: true,
      cancellationDateMs: null,
      error: "We couldn't open your cancellation flow.",
    };

    render(
      <CancelPlanDialog
        open
        onOpenChange={vi.fn()}
        planLabel="Pro"
        periodEndLabel="May 31, 2026"
      />,
    );

    expect(
      screen.queryByText("We couldn't open your cancellation flow."),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Plan cancellation is scheduled.",
      );
    });
  });

  it("still renders cancellation action errors", () => {
    fetcherState.current.data = {
      error: "We couldn't open your cancellation flow.",
    };

    render(
      <CancelPlanDialog
        open
        onOpenChange={vi.fn()}
        planLabel="Pro"
        periodEndLabel="May 31, 2026"
      />,
    );

    expect(
      screen.getByText("We couldn't open your cancellation flow."),
    ).toBeInTheDocument();
  });
});
