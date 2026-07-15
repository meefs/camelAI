import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();
const createBillingPortalSessionMock = vi.fn();
const previewLegacyStripeMigrationMock = vi.fn();
const migrateLegacyStripeSubscriptionMock = vi.fn();
const createSubscriptionCancellationPortalSessionMock = vi.fn();
const createSubscriptionUpdatePortalSessionMock = vi.fn();
const createSubscriptionCheckoutSessionMock = vi.fn();
const updateTrialingStripeSubscriptionPlanMock = vi.fn();

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
    previewLegacyStripeMigration: previewLegacyStripeMigrationMock,
    migrateLegacyStripeSubscription: migrateLegacyStripeSubscriptionMock,
    createSubscriptionCancellationPortalSession:
      createSubscriptionCancellationPortalSessionMock,
    createSubscriptionUpdatePortalSession:
      createSubscriptionUpdatePortalSessionMock,
    createSubscriptionCheckoutSession: createSubscriptionCheckoutSessionMock,
    updateTrialingStripeSubscriptionPlan:
      updateTrialingStripeSubscriptionPlanMock,
  };
});

const { action } = await import("@/routes/_app.settings.organization.billing");
const {
  StaleTrialingSubscriptionStatusError,
  StripeSubscriptionRequiresManagementError,
} =
  await import("@/lib/billing.server");

function makeIntentRequest(
  intent: string,
  fields: Record<string, string> = {},
) {
  const formData = new FormData();
  formData.set("intent", intent);
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new Request("https://camelai.test/settings/organization/billing", {
    method: "POST",
    body: formData,
  });
}

function makeFormRequest(plan: string) {
  return makeIntentRequest("changePlan", { plan });
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
    createSubscriptionUpdatePortalSessionMock.mockResolvedValue(
      "https://billing.stripe.test/confirm",
    );
    previewLegacyStripeMigrationMock.mockResolvedValue({
      plan: "pro",
      seatCount: 1,
      currency: "usd",
      monthlyPriceCents: 15000,
      amountDueTodayCents: 11996,
      legacyCreditCents: 3004,
      newPlanProrationCents: 15000,
      includedCreditCents: 3000,
    });
    migrateLegacyStripeSubscriptionMock.mockResolvedValue({});
    createSubscriptionCancellationPortalSessionMock.mockResolvedValue({
      kind: "portal",
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    updateTrialingStripeSubscriptionPlanMock.mockResolvedValue({});
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

  it("previews a legacy-eligible plan selection before applying it", async () => {
    const org = {
      id: "org_123",
      name: "Legacy Org",
      slug: "legacy-org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
      billing_subscription_id: null,
    };
    const env = {
      ...makeEnv(org),
      LEGACY_STRIPE_MIGRATION_CUSTOMERS: [
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids,total_legacy_quantity",
        "owner@example.com,cus_legacy,1,sub_legacy,si_legacy,price_1QIfnqGvliMKf4vHaDTMG2Mu,1",
      ].join("\n"),
    };
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
      legacyMigrationPreview: {
        plan: "pro",
        seatCount: 1,
        currency: "usd",
        monthlyPriceCents: 15000,
        amountDueTodayCents: 11996,
        legacyCreditCents: 3004,
        newPlanProrationCents: 15000,
        includedCreditCents: 3000,
      },
    });
    expect(previewLegacyStripeMigrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        userEmail: "owner@example.com",
        plan: "pro",
        seatCount: 1,
      }),
    );
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
  });

  it("applies a legacy migration only after the app confirmation", async () => {
    const org = {
      id: "org_123",
      name: "Legacy Org",
      slug: "legacy-org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
      billing_subscription_id: null,
    };
    const env = {
      ...makeEnv(org),
      LEGACY_STRIPE_MIGRATION_CUSTOMERS: [
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids,total_legacy_quantity",
        "owner@example.com,cus_legacy,1,sub_legacy,si_legacy,price_1QIfnqGvliMKf4vHaDTMG2Mu,1",
      ].join("\n"),
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeIntentRequest("changePlan", {
        plan: "pro",
        confirmLegacyMigration: "true",
      }),
      context: {},
    } as never);

    expect(result).toEqual({ planChanged: true });
    expect(migrateLegacyStripeSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        userEmail: "owner@example.com",
        plan: "pro",
        seatCount: 1,
      }),
    );
    expect(previewLegacyStripeMigrationMock).not.toHaveBeenCalled();
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

  it("uses the management portal for unpaid subscribers changing plans", async () => {
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
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        customerEmail: "owner@example.com",
      }),
    );
    expect(createSubscriptionUpdatePortalSessionMock).not.toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("opens a Stripe-hosted exact price and quantity change", async () => {
    const org = {
      id: "org_123",
      name: "Paid Org",
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org, 2, [{ expires_at: Date.now() + 60_000 }]);
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
      billingPortalUrl: "https://billing.stripe.test/confirm",
    });
    expect(createSubscriptionUpdatePortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        plan: "team",
        seatCount: 3,
        returnUrl: "https://camelai.test/settings/organization/billing",
      }),
    );
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("falls back to management when the live paid subscription is not updateable", async () => {
    const org = {
      id: "org_123",
      name: "Canceling Org",
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    createSubscriptionUpdatePortalSessionMock.mockRejectedValueOnce(
      new StripeSubscriptionRequiresManagementError("active"),
    );

    const result = await action({
      request: makeFormRequest("starter"),
      context: {},
    } as never);

    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    expect(createBillingPortalSessionMock).toHaveBeenCalled();
  });

  it("opens management for a current recoverable paid subscription", async () => {
    const org = {
      id: "org_123",
      name: "Paid Org",
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    await expect(
      action({
        request: makeIntentRequest("manageBilling"),
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 302 });
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ env, org, customerEmail: "owner@example.com" }),
    );
  });

  it.each([
    ["inactive", "payg"],
    ["enterprise", "enterprise"],
  ])("rejects spoofed management for %s organizations", async (billingStatus, billingPlan) => {
    const org = {
      id: "org_123",
      name: "Non Stripe Org",
      billing_status: billingStatus,
      billing_plan: billingPlan,
      billing_seat_count: 1,
      billing_subscription_id: null,
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    await expect(
      action({
        request: makeIntentRequest("manageBilling"),
        context: {},
      } as never),
    ).resolves.toEqual({
      error: "A recoverable paid Stripe subscription is required to manage billing.",
    });
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
  });

  it("updates trialing subscriptions directly so Stripe does not end the trial in the portal", async () => {
    const org = {
      id: "org_123",
      name: "Trial Org",
      billing_status: "trialing",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_subscription_id: "sub_trial",
      billing_subscription_status: "trialing",
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

    expect(result).toEqual({ planChanged: true });
    expect(updateTrialingStripeSubscriptionPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        plan: "pro",
        seatCount: 1,
      }),
    );
    expect(createSubscriptionUpdatePortalSessionMock).not.toHaveBeenCalled();
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("opens the hosted active update when local trial status is stale", async () => {
    const org = {
      id: "org_123",
      name: "Stale Trial Org",
      billing_status: "trialing",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_subscription_id: "sub_trial",
      billing_subscription_status: "trialing",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    updateTrialingStripeSubscriptionPlanMock.mockRejectedValueOnce(
      new StaleTrialingSubscriptionStatusError("active"),
    );

    const result = await action({
      request: makeFormRequest("pro"),
      context: {},
    } as never);

    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/confirm",
    });
    expect(updateTrialingStripeSubscriptionPlanMock).toHaveBeenCalled();
    expect(createSubscriptionUpdatePortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        plan: "pro",
        seatCount: 1,
        returnUrl: "https://camelai.test/settings/organization/billing",
      }),
    );
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("falls back to the billing portal when stale trial status needs recovery", async () => {
    const org = {
      id: "org_123",
      name: "Paused Trial Org",
      billing_status: "trialing",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_subscription_id: "sub_trial",
      billing_subscription_status: "trialing",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    updateTrialingStripeSubscriptionPlanMock.mockRejectedValueOnce(
      new StaleTrialingSubscriptionStatusError("paused"),
    );

    const result = await action({
      request: makeFormRequest("pro"),
      context: {},
    } as never);

    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    expect(updateTrialingStripeSubscriptionPlanMock).toHaveBeenCalled();
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        customerEmail: "owner@example.com",
      }),
    );
    expect(createSubscriptionUpdatePortalSessionMock).not.toHaveBeenCalled();
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("uses the Billing Portal for incomplete subscriptions changing paid plans", async () => {
    const org = {
      id: "org_123",
      name: "Incomplete Org",
      billing_status: "past_due",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_subscription_id: "sub_incomplete",
      billing_subscription_status: "incomplete",
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
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        customerEmail: "owner@example.com",
      }),
    );
    expect(createSubscriptionUpdatePortalSessionMock).not.toHaveBeenCalled();
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

  it("clears canceled paid-plan state when selecting the legacy Free action", async () => {
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
      billing_plan: "payg",
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

  it("opens a Stripe cancellation portal flow for active subscriptions", async () => {
    const org = {
      id: "org_123",
      name: "Paid Org",
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });

    const result = await action({
      request: makeIntentRequest("cancelSubscription"),
      context: {},
    } as never);

    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/session",
    });
    expect(createSubscriptionCancellationPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.test/settings/organization/billing",
        afterCompletionReturnUrl:
          "https://camelai.test/settings/organization/billing?cancelled=1",
      }),
    );
    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
  });

  it("returns scheduled cancellation success without an error", async () => {
    const org = {
      id: "org_123",
      name: "Paid Org",
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    createSubscriptionCancellationPortalSessionMock.mockResolvedValueOnce({
      kind: "already_scheduled",
      cancellationDateMs: 1_778_342_400_000,
      subscriptionStatus: "active",
    });

    const result = await action({
      request: makeIntentRequest("cancelSubscription"),
      context: {},
    } as never);

    expect(result).toEqual({
      cancellationScheduled: true,
      cancellationDateMs: 1_778_342_400_000,
      subscriptionStatus: "active",
    });
    expect(result).not.toHaveProperty("error");
  });

  it("returns the cancellation error for unrecovered portal failures", async () => {
    const org = {
      id: "org_123",
      name: "Paid Org",
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_123",
      billing_subscription_status: "active",
    };
    const env = makeEnv(org);
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    createSubscriptionCancellationPortalSessionMock.mockRejectedValueOnce(
      new Error("portal failed"),
    );

    const result = await action({
      request: makeIntentRequest("cancelSubscription"),
      context: {},
    } as never);

    expect(result).toEqual({
      error:
        "We couldn't open your cancellation flow. Please try again in a moment.",
    });
  });
});
