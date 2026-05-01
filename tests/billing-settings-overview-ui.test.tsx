import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  loaderData: { current: undefined as unknown },
  fetcher: {
    state: "idle",
    data: undefined,
    submit: vi.fn(),
  },
}));

vi.mock("react-router", () => ({
  Form: (props: ComponentProps<"form">) => <form {...props} />,
  redirect: vi.fn(),
  useFetcher: () => testState.fetcher,
  useLoaderData: () => testState.loaderData.current,
  useSearchParams: () => [new URLSearchParams()],
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
    getStripeDefaultPaymentMethodSummary: vi.fn(),
    getStripeSubscriptionSummary: vi.fn(),
    hasOrgUsedSubscriptionTrial: vi.fn(),
    isStripeBillingConfigured: vi.fn(),
    listStripeInvoicesForOrg: vi.fn(),
    migrateLegacyStripeSubscription: vi.fn(),
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
    paymentMethod: null,
    invoices: [],
    subscription: null,
    trialAvailable: false,
    legacyMigration: null,
  };
}

describe("BillingPage overview", () => {
  it("shows the billed Team seat count in the plan heading", () => {
    testState.loaderData.current = makeLoaderData();

    render(<BillingPage />);

    expect(
      screen.getByRole("heading", { name: "Team plan - 4 seats" }),
    ).toBeInTheDocument();
  });
});
