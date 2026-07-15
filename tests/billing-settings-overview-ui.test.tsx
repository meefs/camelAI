import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  loaderData: { current: undefined as unknown },
  fetcher: {
    state: "idle",
    data: undefined,
    formData: undefined as FormData | undefined,
    submit: vi.fn(),
  },
  revalidate: vi.fn(),
}));

vi.mock("react-router", () => ({
  Form: (props: ComponentProps<"form">) => <form {...props} />,
  redirect: vi.fn(),
  useFetcher: () => testState.fetcher,
  useLoaderData: () => testState.loaderData.current,
  useRevalidator: () => ({
    state: "idle",
    revalidate: testState.revalidate,
  }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: vi.fn(),
  requireOrgAdmin: vi.fn(),
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: vi.fn(),
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    createBillingPortalSession: vi.fn(),
    createSubscriptionCheckoutSession: vi.fn(),
    createSubscriptionUpdatePortalSession: vi.fn(),
    getOrgBillingOverview: vi.fn(),
    getStripeSubscriptionSummary: vi.fn(),
    hasOrgUsedSubscriptionTrial: vi.fn(),
    isStripeBillingConfigured: vi.fn(),
    listStripeInvoicesForOrg: vi.fn(),
    updateTrialingStripeSubscriptionPlan: vi.fn(),
  };
});

const { default: BillingPage } = await import(
  "@/routes/_app.settings.organization.billing"
);

function makeLoaderData() {
  return {
    org: {
      id: "org_123",
      name: "Team Org",
      slug: "team-org",
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 4,
      billing_subscription_id: "sub_team",
      billing_subscription_status: "active",
    },
    overview: {
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 4,
      billing_subscription_status: "active",
    },
    stripeConfigured: true,
    invoices: [],
    subscription: null,
  };
}

describe("BillingPage overview", () => {
  beforeEach(() => {
    testState.fetcher.state = "idle";
    testState.fetcher.data = undefined;
    testState.fetcher.formData = undefined;
    testState.fetcher.submit.mockClear();
  });

  it("shows the billed Team seat count in the plan heading", () => {
    testState.loaderData.current = makeLoaderData();

    render(<BillingPage />);

    expect(
      screen.getByRole("heading", { name: "Team plan - 4 seats" }),
    ).toBeInTheDocument();
  });

  it("shows pending cancellation as its own plan summary line", () => {
    testState.loaderData.current = {
      ...makeLoaderData(),
      org: {
        ...makeLoaderData().org,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      overview: {
        ...makeLoaderData().overview,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      subscription: {
        id: "sub_pro",
        status: "active",
        current_period_end_ms: Date.UTC(2026, 4, 8, 12),
        cancel_at_ms: null,
        cancellation_date_ms: Date.UTC(2026, 4, 8, 12),
        cancel_at_period_end: true,
        is_canceling: true,
        trial_end_ms: null,
      },
    };

    render(<BillingPage />);

    expect(
      screen.getByRole("heading", { name: "Pro plan" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cancels May 8, 2026")).toBeInTheDocument();
    expect(
      screen.getByText("$40/month in hosted credits."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cancellation" }),
    ).not.toBeInTheDocument();
  });

  it("shows renewal copy and cancellation controls for non-canceling subscriptions", () => {
    testState.loaderData.current = {
      ...makeLoaderData(),
      org: {
        ...makeLoaderData().org,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      overview: {
        ...makeLoaderData().overview,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      subscription: {
        id: "sub_pro",
        status: "active",
        current_period_end_ms: Date.UTC(2026, 5, 8, 12),
        cancel_at_ms: null,
        cancellation_date_ms: null,
        cancel_at_period_end: false,
        is_canceling: false,
        trial_end_ms: null,
      },
    };

    render(<BillingPage />);

    expect(screen.getByText("Renews Jun 8, 2026.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Cancellation" }),
    ).toBeInTheDocument();
  });

  it("does not render local payment-method details", () => {
    testState.loaderData.current = makeLoaderData();

    render(<BillingPage />);

    expect(screen.queryByRole("heading", { name: "Payment" })).not.toBeInTheDocument();
    expect(screen.queryByText(/payment method/i)).not.toBeInTheDocument();
  });

  it("shows an enabled current-plan Manage in Stripe action and submits the management intent", () => {
    testState.loaderData.current = {
      ...makeLoaderData(),
      org: {
        ...makeLoaderData().org,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      overview: {
        ...makeLoaderData().overview,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
    };

    render(<BillingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Manage plan" }));
    const manageButton = screen.getByRole("button", { name: "Manage in Stripe" });
    expect(manageButton).toBeEnabled();
    expect(screen.getByText("Current plan")).toBeInTheDocument();

    fireEvent.click(manageButton);
    expect(testState.fetcher.submit).toHaveBeenCalledWith(
      { intent: "manageBilling", plan: "pro" },
      { method: "post" },
    );
  });

  it("submits an active plan selection once and lets Stripe confirm it", async () => {
    const user = userEvent.setup();
    testState.loaderData.current = {
      ...makeLoaderData(),
      org: {
        ...makeLoaderData().org,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      overview: {
        ...makeLoaderData().overview,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
    };

    render(<BillingPage />);
    await user.click(screen.getByRole("button", { name: "Manage plan" }));
    await user.click(screen.getByRole("tab", { name: "Team" }));
    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(testState.fetcher.submit).toHaveBeenCalledWith(
      { intent: "changePlan", plan: "team" },
      { method: "post" },
    );
    expect(
      screen.queryByRole("heading", { name: "Confirm plan change" }),
    ).not.toBeInTheDocument();
  });

  it("disables Manage in Stripe and shows progress while its request is pending", () => {
    testState.loaderData.current = {
      ...makeLoaderData(),
      org: {
        ...makeLoaderData().org,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      overview: {
        ...makeLoaderData().overview,
        billing_plan: "pro",
        billing_seat_count: 1,
      },
    };
    const formData = new FormData();
    formData.set("intent", "manageBilling");
    formData.set("plan", "pro");
    testState.fetcher.state = "submitting";
    testState.fetcher.formData = formData;

    render(<BillingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Manage plan" }));

    expect(
      screen.getByRole("button", { name: "Opening Stripe…" }),
    ).toBeDisabled();
  });
});
