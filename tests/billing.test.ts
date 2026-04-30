import { afterEach, describe, expect, it, vi } from "vitest";
import {
  billingStatusBadgeVariant,
  billingStatusLabel,
  canUsePaidWorkspace,
  formatCreditAmount,
  formatCreditBalance,
  formatCreditsFromUsd,
  formatUsdFromCents,
} from "@/lib/billing";
import {
  BILLING_PLAN_LIMITS,
  getIncludedCreditCentsForPlan,
  getOrgSeatLimit,
  normalizeBillingPlan,
  normalizeSeatCount,
} from "@/lib/billing-plans";
import {
  applySubscriptionIncludedCreditsFromInvoice,
  bestEffortSyncTeamSubscriptionSeatCount,
  createBillingPortalSession,
  createSubscriptionCheckoutSession,
  getBillableTeamSeatCount,
  getBillableTeamSeatCountForOrg,
  getBillingAllowanceConfig,
  getConfiguredSubscriptionPriceId,
  getLegacyStripeMigrationEligibility,
  hasOrgUsedSubscriptionTrial,
  isConfiguredEnterpriseOrg,
  isRecurringSubscriptionInvoice,
  isStripeSecretKeyAllowedForMode,
  migrateLegacyStripeSubscription,
  parseStripePriceIdList,
  syncTeamSubscriptionSeatCount,
} from "@/lib/billing.server";
import type { Organization } from "@/types";

describe("billing helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeBillingOrgEnv(args: {
    org: Partial<Organization>;
    memberCount: number;
    invitations?: Array<{ expires_at: number }>;
  }) {
    const org = {
      id: "org_team",
      name: "Team Org",
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
      billing_subscription_id: "sub_team",
      ...args.org,
    } as Organization;
    const orgStub = {
      getInfo: vi.fn(async () => org),
      getMemberCount: vi.fn(async () => args.memberCount),
      getInvitations: vi.fn(async () => args.invitations ?? []),
      updateBillingState: vi.fn(async (updates: Partial<Organization>) => {
        Object.assign(org, updates);
        return org;
      }),
    };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_TEAM_PRICE_ID: "price_team",
    };
    return { env, org, orgStub };
  }

  it("treats trialing, active, and enterprise orgs as allowed", () => {
    expect(canUsePaidWorkspace("trialing")).toBe(true);
    expect(canUsePaidWorkspace("active")).toBe(true);
    expect(canUsePaidWorkspace("enterprise")).toBe(true);
    expect(canUsePaidWorkspace("inactive")).toBe(false);
  });

  it("maps billing statuses to stable labels and variants", () => {
    expect(billingStatusLabel("inactive")).toBe("Free");
    expect(billingStatusLabel("enterprise")).toBe("Enterprise");
    expect(billingStatusLabel("past_due")).toBe("Past due");
    expect(billingStatusBadgeVariant("active")).toBe("default");
    expect(billingStatusBadgeVariant("enterprise")).toBe("default");
    expect(billingStatusBadgeVariant("past_due")).toBe("destructive");
  });

  it("formats credits and usd values from cents", () => {
    expect(formatCreditAmount(1.2345, { maximumFractionDigits: 4 })).toBe(
      "1.2345 credits",
    );
    expect(formatCreditBalance(2500)).toBe("25.00 credits");
    expect(formatCreditsFromUsd(0.1234)).toBe("0.1234 credits");
    expect(formatUsdFromCents(2500)).toBe("$25.00");
  });

  it("normalizes billing plans, seats, and included credits", () => {
    expect(normalizeBillingPlan(undefined, "active")).toBe("starter");
    expect(normalizeBillingPlan(undefined, "inactive")).toBe("free");
    expect(normalizeSeatCount("team", 2)).toBe(3);
    expect(getIncludedCreditCentsForPlan("starter", 1)).toBe(1000);
    expect(getIncludedCreditCentsForPlan("pro", 1)).toBe(3000);
    expect(getIncludedCreditCentsForPlan("team", 4)).toBe(4000);
    expect(
      getOrgSeatLimit({
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 4,
      }),
    ).toBe(4);
    expect(
      getOrgSeatLimit({
        billing_status: "enterprise",
        billing_plan: "enterprise",
        billing_seat_count: 1,
      }),
    ).toBeNull();
  });

  it("computes billable team seats from members and active invitations", async () => {
    const { env } = makeBillingOrgEnv({
      org: { billing_seat_count: 4 },
      memberCount: 3,
      invitations: [
        { expires_at: Date.now() + 60_000 },
        { expires_at: Date.now() - 60_000 },
      ],
    });

    await expect(
      getBillableTeamSeatCount(env as never, "org_team"),
    ).resolves.toBe(4);
    await expect(
      getBillableTeamSeatCount(env as never, "org_team", 1),
    ).resolves.toBe(5);
  });

  it("computes billable team checkout seats before the org is on Team", async () => {
    const { env } = makeBillingOrgEnv({
      org: { billing_status: "inactive", billing_plan: "free" },
      memberCount: 2,
      invitations: [
        { expires_at: Date.now() + 60_000 },
        { expires_at: Date.now() - 60_000 },
      ],
    });

    await expect(
      getBillableTeamSeatCount(env as never, "org_team"),
    ).resolves.toBeNull();
    await expect(
      getBillableTeamSeatCountForOrg(env as never, "org_team"),
    ).resolves.toBe(3);
  });

  it("matches the v1 billing design plan matrix", () => {
    expect(BILLING_PLAN_LIMITS.free).toMatchObject({
      monthlyPriceCents: 0,
      minimumSeats: 1,
      includedWorkspaceCount: 1,
      storageGbPerWorkspace: 5,
      includedCreditCentsBase: 0,
      includedCreditCentsPerSeat: 0,
      maxDeployedAppsPerWorkspace: 3,
      maxCustomDomains: 0,
      maxCronJobsPerWorkspace: 2,
      maxCronJobsPerUser: null,
      minCronIntervalMs: 24 * 60 * 60 * 1000,
      byokOnly: true,
      emailInbox: false,
    });

    expect(BILLING_PLAN_LIMITS.starter).toMatchObject({
      monthlyPriceCents: 4000,
      minimumSeats: 1,
      includedWorkspaceCount: 1,
      storageGbPerWorkspace: 50,
      includedCreditCentsBase: 1000,
      includedCreditCentsPerSeat: 0,
      maxDeployedAppsPerWorkspace: 30,
      maxCustomDomains: 10,
      maxCronJobsPerWorkspace: 10,
      maxCronJobsPerUser: null,
      minCronIntervalMs: 60 * 60 * 1000,
      byokOnly: false,
      emailInbox: false,
    });

    expect(BILLING_PLAN_LIMITS.pro).toMatchObject({
      monthlyPriceCents: 15000,
      minimumSeats: 1,
      includedWorkspaceCount: 1,
      storageGbPerWorkspace: 100,
      includedCreditCentsBase: 3000,
      includedCreditCentsPerSeat: 0,
      maxDeployedAppsPerWorkspace: null,
      maxCustomDomains: null,
      maxCronJobsPerWorkspace: 50,
      maxCronJobsPerUser: null,
      minCronIntervalMs: 5 * 60 * 1000,
      byokOnly: false,
      emailInbox: true,
    });

    expect(BILLING_PLAN_LIMITS.team).toMatchObject({
      monthlyPriceCents: 5000,
      minimumSeats: 3,
      includedWorkspaceCount: 2,
      storageGbPerWorkspace: 100,
      includedCreditCentsBase: 0,
      includedCreditCentsPerSeat: 1000,
      maxDeployedAppsPerWorkspace: null,
      maxCustomDomains: null,
      maxCronJobsPerWorkspace: null,
      maxCronJobsPerUser: 50,
      minCronIntervalMs: 5 * 60 * 1000,
      byokOnly: false,
      emailInbox: true,
    });
  });

  it("parses configured stripe credit pack ids", () => {
    expect(
      parseStripePriceIdList("price_a, price_b,price_a,, price_c "),
    ).toEqual(["price_a", "price_b", "price_c"]);
  });

  it("detects legacy migration eligibility from the private CSV allowlist", () => {
    const csv = [
      "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_names,legacy_price_ids,total_legacy_quantity,customer_name,customer_user_id",
      "owner@example.com,cus_123,1,sub_123,si_123,Individual,price_1QIfnqGvliMKf4vHaDTMG2Mu,1,Owner,user_123",
      "team@example.com,cus_team,1,sub_team,si_team,Team,price_1S6NRLGvliMKf4vHtFDiA07o,5,Team,user_team",
    ].join("\n");
    const org = {
      id: "org_123",
      name: "Org",
      slug: "org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_id: null,
    } as Organization;

    expect(
      getLegacyStripeMigrationEligibility({
        env: { LEGACY_STRIPE_MIGRATION_CUSTOMERS: csv },
        org,
        userEmail: "OWNER@example.com",
      }),
    ).toEqual({
      eligible: true,
      customerId: "cus_123",
      activeLegacySubscriptionCount: 1,
      defaultPlan: "pro",
    });
    expect(
      getLegacyStripeMigrationEligibility({
        env: { LEGACY_STRIPE_MIGRATION_CUSTOMERS: csv },
        org,
        userEmail: "team@example.com",
      })?.defaultPlan,
    ).toBe("team");
  });

  it("does not offer legacy migration to orgs already on v2 billing", () => {
    expect(
      getLegacyStripeMigrationEligibility({
        env: {
          LEGACY_STRIPE_MIGRATION_CUSTOMERS:
            "email,customer_id\nowner@example.com,cus_123",
        },
        org: {
          id: "org_123",
          name: "Org",
          slug: "org",
          billing_status: "active",
          billing_plan: "pro",
          billing_subscription_id: "sub_v2",
        } as Organization,
        userEmail: "owner@example.com",
      }),
    ).toBeNull();
  });

  it("requires manual migration for multiple active legacy subscriptions", async () => {
    await expect(
      migrateLegacyStripeSubscription({
        env: {
          LEGACY_STRIPE_MIGRATION_CUSTOMERS:
            "email,customer_id,active_legacy_subscription_count\nowner@example.com,cus_123,2",
        } as never,
        org: {
          id: "org_123",
          name: "Org",
          slug: "org",
          billing_status: "inactive",
          billing_plan: "free",
          billing_subscription_id: null,
        } as Organization,
        userEmail: "owner@example.com",
        plan: "pro",
      }),
    ).rejects.toThrow("multiple active legacy subscriptions");
  });

  it("treats configured enterprise org slugs as enterprise", () => {
    expect(
      isConfiguredEnterpriseOrg(
        { BILLING_ENTERPRISE_ORG_SLUGS: "seclock,other-org" },
        {
          id: "org_123",
          name: "SecLock",
          slug: "seclock",
          billing_status: "inactive",
        } as Organization,
      ),
    ).toBe(true);
  });

  it("uses configurable capped credit allowances", () => {
    expect(getBillingAllowanceConfig({})).toEqual({
      trialCreditCents: 1000,
      subscriptionIncludedCreditCents: 1000,
    });
    expect(
      getBillingAllowanceConfig({
        BILLING_TRIAL_CREDIT_CENTS: "500",
        BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS: "2500",
      }),
    ).toEqual({
      trialCreditCents: 500,
      subscriptionIncludedCreditCents: 2500,
    });
  });

  it("enforces stripe key mode when configured", () => {
    expect(isStripeSecretKeyAllowedForMode("sk_test_123", "test")).toBe(true);
    expect(isStripeSecretKeyAllowedForMode("rk_test_123", "test")).toBe(true);
    expect(isStripeSecretKeyAllowedForMode("sk_live_123", "test")).toBe(false);
    expect(isStripeSecretKeyAllowedForMode("sk_live_123", "live")).toBe(true);
    expect(isStripeSecretKeyAllowedForMode("rk_live_123", "live")).toBe(true);
    expect(isStripeSecretKeyAllowedForMode("sk_test_123", "live")).toBe(false);
    expect(isStripeSecretKeyAllowedForMode("sk_test_123", undefined)).toBe(
      true,
    );
    expect(isStripeSecretKeyAllowedForMode("sk_test_123", "sandbox")).toBe(
      false,
    );
  });

  it("only treats recurring subscription cycle invoices as included-credit grants", () => {
    expect(
      isRecurringSubscriptionInvoice({
        id: "in_cycle",
        subscription: "sub_123",
        billing_reason: "subscription_cycle",
      }),
    ).toBe(true);

    for (const billingReason of [
      "subscription_create",
      "subscription_update",
      "subscription_threshold",
      "manual",
      null,
    ]) {
      expect(
        isRecurringSubscriptionInvoice({
          id: `in_${billingReason ?? "missing"}`,
          subscription: "sub_123",
          billing_reason: billingReason,
        }),
      ).toBe(false);
    }
  });

  it("does not apply included credits for subscription update invoices", async () => {
    await expect(
      applySubscriptionIncludedCreditsFromInvoice({} as never, {
        id: "in_update",
        subscription: "sub_123",
        status: "paid",
        amount_paid: 1000,
        billing_reason: "subscription_update",
        metadata: { org_id: "org_123" },
      }),
    ).resolves.toBeNull();
  });

  it("passes a configured billing portal configuration to Stripe", async () => {
    let portalRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }),
    );

    await expect(
      createBillingPortalSession({
        env: {
          ORG: {} as never,
          STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: "sk_test_123",
          STRIPE_BILLING_PORTAL_CONFIGURATION_ID: " bpc_v2 ",
        },
        org: {
          id: "org_123",
          name: "Test Org",
          billing_customer_id: "cus_123",
        } as never,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).resolves.toBe("https://billing.stripe.test/session");

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("customer")).toBe("cus_123");
    expect(portalParams.get("configuration")).toBe("bpc_v2");
  });

  it("uses tier-specific subscription price, quantity, and included credit metadata", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        checkoutRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://checkout.stripe.test/session" }),
        };
      }),
    );

    await expect(
      createSubscriptionCheckoutSession({
        env: {
          ORG: {} as never,
          STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: "sk_test_123",
          STRIPE_TEAM_PRICE_ID: "price_team",
        },
        org: {
          id: "org_123",
          name: "Test Org",
          billing_status: "inactive",
          billing_plan: "free",
          billing_seat_count: 1,
          billing_customer_id: "cus_123",
        } as never,
        customerEmail: "owner@example.com",
        successUrl: "https://camelai.dev/success",
        cancelUrl: "https://camelai.dev/cancel",
        plan: "team",
        seatCount: 2,
      }),
    ).resolves.toBe("https://checkout.stripe.test/session");

    const params = new URLSearchParams(checkoutRequestBody ?? "");
    expect(params.get("line_items[0][price]")).toBe("price_team");
    expect(params.get("line_items[0][quantity]")).toBe("3");
    expect(params.get("subscription_data[metadata][billing_plan]")).toBe(
      "team",
    );
    expect(params.get("subscription_data[trial_period_days]")).toBe("7");
    expect(params.get("subscription_data[metadata][trial_credit_cents]")).toBe(
      "1000",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("3000");
  });

  it("blocks Checkout for configured enterprise orgs", async () => {
    await expect(
      createSubscriptionCheckoutSession({
        env: {
          ORG: {} as never,
          STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: "sk_test_123",
          STRIPE_PRO_PRICE_ID: "price_pro",
          BILLING_ENTERPRISE_ORG_SLUGS: "seclock",
        },
        org: {
          id: "org_123",
          name: "SecLock",
          slug: "seclock",
          billing_status: "inactive",
          billing_plan: "free",
          billing_seat_count: 1,
          billing_customer_id: "cus_123",
        } as never,
        customerEmail: "owner@example.com",
        successUrl: "https://camelai.dev/success",
        cancelUrl: "https://camelai.dev/cancel",
        plan: "pro",
      }),
    ).rejects.toThrow("Enterprise orgs are billed outside Stripe Checkout");
  });

  it("does not scale team trial credits with seat count", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        checkoutRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://checkout.stripe.test/session" }),
        };
      }),
    );

    await createSubscriptionCheckoutSession({
      env: {
        ORG: {} as never,
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_TEAM_PRICE_ID: "price_team",
      },
      org: {
        id: "org_123",
        name: "Test Org",
        billing_status: "inactive",
        billing_plan: "free",
        billing_seat_count: 1,
        billing_customer_id: "cus_123",
      } as never,
      customerEmail: "owner@example.com",
      successUrl: "https://camelai.dev/success",
      cancelUrl: "https://camelai.dev/cancel",
      plan: "team",
      seatCount: 25,
    });

    const params = new URLSearchParams(checkoutRequestBody ?? "");
    expect(params.get("line_items[0][quantity]")).toBe("25");
    expect(params.get("subscription_data[metadata][trial_credit_cents]")).toBe(
      "1000",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("25000");
  });

  it("omits Stripe trial days after the org has already used a trial", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        checkoutRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://checkout.stripe.test/session" }),
        };
      }),
    );

    expect(
      hasOrgUsedSubscriptionTrial({
        billing_trial_started_at: 123,
        billing_trial_ends_at: null,
        billing_trial_credit_granted_at: null,
      }),
    ).toBe(true);

    await createSubscriptionCheckoutSession({
      env: {
        ORG: {} as never,
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_PRO_PRICE_ID: "price_pro",
      },
      org: {
        id: "org_123",
        name: "Test Org",
        billing_status: "inactive",
        billing_plan: "free",
        billing_seat_count: 1,
        billing_customer_id: "cus_123",
        billing_trial_started_at: 123,
        billing_trial_ends_at: 456,
        billing_trial_credit_granted_at: 789,
      } as never,
      customerEmail: "owner@example.com",
      successUrl: "https://camelai.dev/success",
      cancelUrl: "https://camelai.dev/cancel",
      plan: "pro",
    });

    const params = new URLSearchParams(checkoutRequestBody ?? "");
    expect(params.has("subscription_data[trial_period_days]")).toBe(false);
    expect(params.get("subscription_data[metadata][trial_credit_cents]")).toBe(
      "0",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("3000");
    expect(
      params.get("subscription_data[metadata][initial_included_credit_cents]"),
    ).toBe("3000");
  });

  it("applies included credits for explicit no-trial initial paid subscription invoices", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });

    await expect(
      applySubscriptionIncludedCreditsFromInvoice(env as never, {
        id: "in_initial_paid",
        subscription: {
          id: "sub_pro",
          status: "active",
          metadata: {
            org_id: "org_team",
            billing_plan: "pro",
            seat_count: "1",
            subscription_included_credit_cents: "3000",
            initial_included_credit_cents: "3000",
          },
        },
        status: "paid",
        paid: true,
        amount_paid: 15000,
        billing_reason: "subscription_create",
      }),
    ).resolves.toMatchObject({
      billing_credit_grant_total_cents: 3000,
      billing_last_included_credit_invoice_id: "in_initial_paid",
    });

    expect(orgStub.updateBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_plan: "pro",
        billing_credit_grant_total_cents: 3000,
        billing_last_included_credit_invoice_id: "in_initial_paid",
      }),
    );
  });

  it("updates Stripe subscription item quantity and metadata for team seats", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 3,
      invitations: [{ expires_at: Date.now() + 60_000 }],
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            items: {
              data: [
                {
                  id: "si_team",
                  quantity: 3,
                  price: { id: "price_team" },
                },
              ],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          id: url.includes("subscription_items") ? "si_team" : "sub_team",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team"),
    ).resolves.toMatchObject({ billing_seat_count: 4 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const itemUpdate = fetchMock.mock.calls[1];
    expect(String(itemUpdate[0])).toBe(
      "https://api.stripe.com/v1/subscription_items/si_team",
    );
    const itemParams = new URLSearchParams(itemUpdate[1]?.body as string);
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("create_prorations");

    const subscriptionUpdate = fetchMock.mock.calls[2];
    expect(String(subscriptionUpdate[0])).toBe(
      "https://api.stripe.com/v1/subscriptions/sub_team",
    );
    const subscriptionParams = new URLSearchParams(
      subscriptionUpdate[1]?.body as string,
    );
    expect(subscriptionParams.get("metadata[billing_plan]")).toBe("team");
    expect(subscriptionParams.get("metadata[seat_count]")).toBe("4");
    expect(
      subscriptionParams.get("metadata[subscription_included_credit_cents]"),
    ).toBe("4000");
    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_seat_count: 4,
    });
  });

  it("does not update a Stripe subscription item when the configured team price is missing", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 4,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "sub_team",
        status: "active",
        items: {
          data: [
            {
              id: "si_other",
              quantity: 3,
              price: { id: "price_other" },
            },
          ],
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team"),
    ).rejects.toThrow(
      "Stripe subscription does not have an item for configured price price_team",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
  });

  it("does not throw when best-effort team seat sync cannot reach Stripe", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 4,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        text: async () => "stripe unavailable",
      })),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      bestEffortSyncTeamSubscriptionSeatCount(env as never, "org_team", {
        reason: "test",
      }),
    ).resolves.toBeNull();

    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("honors explicit billing credit overrides in subscription checkout metadata", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        checkoutRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://checkout.stripe.test/session" }),
        };
      }),
    );

    await createSubscriptionCheckoutSession({
      env: {
        ORG: {} as never,
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_PRO_PRICE_ID: "price_pro",
        BILLING_TRIAL_CREDIT_CENTS: "700",
        BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS: "4500",
      },
      org: {
        id: "org_123",
        name: "Test Org",
        billing_status: "inactive",
        billing_plan: "free",
        billing_seat_count: 1,
        billing_customer_id: "cus_123",
      } as never,
      customerEmail: "owner@example.com",
      successUrl: "https://camelai.dev/success",
      cancelUrl: "https://camelai.dev/cancel",
      plan: "pro",
    });

    const params = new URLSearchParams(checkoutRequestBody ?? "");
    expect(params.get("subscription_data[metadata][trial_credit_cents]")).toBe(
      "700",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("4500");
  });

  it("falls back from starter price to the legacy subscription price id", () => {
    expect(
      getConfiguredSubscriptionPriceId(
        { STRIPE_SUBSCRIPTION_PRICE_ID: "price_legacy" },
        "starter",
      ),
    ).toBe("price_legacy");
    expect(
      getConfiguredSubscriptionPriceId(
        { STRIPE_PRO_PRICE_ID: "price_pro" },
        "pro",
      ),
    ).toBe("price_pro");
  });
});
