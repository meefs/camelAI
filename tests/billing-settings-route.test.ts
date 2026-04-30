import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();
const createBillingPortalSessionMock = vi.fn();
const createSubscriptionCheckoutSessionMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    createBillingPortalSession: createBillingPortalSessionMock,
    createSubscriptionCheckoutSession: createSubscriptionCheckoutSessionMock,
  };
});

const { action } = await import("@/routes/_app.settings.organization.billing");

function makeFormRequest(plan: string) {
  const formData = new FormData();
  formData.set("intent", "changePlan");
  formData.set("plan", plan);
  return new Request("https://camelai.test/settings/organization/billing", {
    method: "POST",
    body: formData,
  });
}

function makeEnv(
  org: Record<string, unknown>,
  memberCount = 1,
  invitations: Array<{ expires_at: number }> = [],
) {
  const orgStub = {
    getInfo: vi.fn(async () => org),
    getMemberCount: vi.fn(async () => memberCount),
    getInvitations: vi.fn(async () => invitations),
    updateBillingState: vi.fn(async (updates: Record<string, unknown>) => {
      Object.assign(org, updates);
      return org;
    }),
  };
  return {
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    orgStub,
  };
}

describe("billing settings plan changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
    createBillingPortalSessionMock.mockResolvedValue(
      "https://billing.stripe.test/session",
    );
    createSubscriptionCheckoutSessionMock.mockResolvedValue(
      "https://checkout.stripe.test/session",
    );
  });

  it("creates Checkout for a free org selecting a paid plan", async () => {
    const org = {
      id: "org_123",
      name: "Free Org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeFormRequest("pro"),
      context: {},
    } as never);

    expect(result).toEqual({
      checkoutUrl: "https://checkout.stripe.test/session",
    });
    expect(createSubscriptionCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        customerEmail: "owner@example.com",
        plan: "pro",
        seatCount: 1,
      }),
    );
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
  });

  it("uses the Billing Portal for active subscribers changing plans", async () => {
    const org = {
      id: "org_123",
      name: "Paid Org",
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org, 4);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeFormRequest("free"),
      context: {},
    } as never);

    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        customerEmail: "owner@example.com",
      }),
    );
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("uses the Billing Portal for unpaid subscribers changing plans", async () => {
    const org = {
      id: "org_123",
      name: "Unpaid Org",
      billing_status: "past_due",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "unpaid",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeFormRequest("team"),
      context: {},
    } as never);

    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    expect(createBillingPortalSessionMock).toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("uses billable team seats when creating Team Checkout", async () => {
    const org = {
      id: "org_123",
      name: "Free Org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
    };
    const env = makeEnv(org, 2, [
      { expires_at: Date.now() + 60_000 },
      { expires_at: Date.now() - 60_000 },
    ]);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeFormRequest("team"),
      context: {},
    } as never);

    expect(result).toEqual({
      checkoutUrl: "https://checkout.stripe.test/session",
    });
    expect(createSubscriptionCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: "team",
        seatCount: 3,
      }),
    );
  });

  it("clears canceled paid-plan state when selecting Free", async () => {
    const org = {
      id: "org_123",
      name: "Canceled Org",
      billing_status: "canceled",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_canceled",
      billing_subscription_status: "canceled",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeFormRequest("free"),
      context: {},
    } as never);

    expect(result).toEqual({ planChanged: true });
    expect(env.orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
      billing_subscription_id: null,
      billing_subscription_status: null,
    });
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns a form error when subscription Checkout creation fails", async () => {
    const org = {
      id: "org_123",
      name: "Free Org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    createSubscriptionCheckoutSessionMock.mockRejectedValueOnce(
      new Error("missing price"),
    );

    const result = await action({
      request: makeFormRequest("pro"),
      context: {},
    } as never);

    expect(result).toEqual({
      error:
        "We couldn't start checkout for that plan. Please try again in a moment.",
    });
  });
});
