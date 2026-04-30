import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  loaderData: { current: undefined as unknown },
  fetcher: {
    state: "idle",
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
  },
  planPickerProps: undefined as
    | {
        legacyMigration?: unknown;
        disabledReason?: string | null;
        onSelectPlan: (cta: unknown) => void;
      }
    | undefined,
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();

  return {
    ...actual,
    useFetcher: () => testState.fetcher,
    useLoaderData: () => testState.loaderData.current,
    useSearchParams: () => [new URLSearchParams("view=plans")],
  };
});

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
    getOrgBillingOverview: vi.fn(),
    getStripeDefaultPaymentMethodSummary: vi.fn(),
    getStripeSubscriptionSummary: vi.fn(),
    hasOrgUsedSubscriptionTrial: vi.fn(),
    isStripeBillingConfigured: vi.fn(),
    listStripeInvoicesForOrg: vi.fn(),
    migrateLegacyStripeSubscription: vi.fn(),
  };
});

vi.mock("@/components/billing/plan-picker", () => ({
  PlanPicker: (props: {
    legacyMigration?: unknown;
    disabledReason?: string | null;
    onSelectPlan: (cta: unknown) => void;
  }) => {
    testState.planPickerProps = props;
    return (
      <button
        type="button"
        onClick={() => props.onSelectPlan({ kind: "migrate", plan: "pro" })}
      >
        Switch to Pro
      </button>
    );
  },
}));

const { default: BillingPage } = await import(
  "@/routes/_app.settings.organization.billing"
);

function makeLoaderData({
  activeLegacySubscriptionCount = 1,
}: {
  activeLegacySubscriptionCount?: number;
} = {}) {
  return {
    org: {
      id: "org_123",
      name: "Legacy Org",
      slug: "legacy-org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_id: null,
    },
    overview: {
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_status: null,
    },
    stripeConfigured: true,
    paymentMethod: null,
    invoices: [],
    subscription: null,
    trialAvailable: false,
    legacyMigration: {
      eligible: true,
      customerId: "cus_legacy",
      activeLegacySubscriptionCount,
      defaultPlan: "pro",
    },
  };
}

describe("BillingPage legacy migration plan picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.loaderData.current = makeLoaderData();
    testState.fetcher.state = "idle";
    testState.fetcher.data = undefined;
    testState.fetcher.formData = undefined;
    testState.planPickerProps = undefined;
  });

  it("submits paid legacy selections to the migration endpoint", async () => {
    const user = userEvent.setup();
    render(<BillingPage />);

    expect(testState.planPickerProps?.legacyMigration).toEqual(
      expect.objectContaining({
        eligible: true,
        customerId: "cus_legacy",
      }),
    );

    await user.click(screen.getByRole("button", { name: /switch to pro/i }));

    expect(testState.fetcher.submit).toHaveBeenCalledWith(
      { plan: "pro" },
      {
        method: "post",
        action: "/api/billing/legacy-migration",
      },
    );
  });

  it("disables paid migration CTAs for multiple active legacy subscriptions", () => {
    testState.loaderData.current = makeLoaderData({
      activeLegacySubscriptionCount: 2,
    });

    render(<BillingPage />);

    expect(testState.planPickerProps?.disabledReason).toMatch(
      /multiple active subscriptions/i,
    );
  });
});
