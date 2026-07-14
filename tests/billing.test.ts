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
  bestEffortSyncTeamSubscriptionSeatCount,
  createBillingPortalSession,
  createLegacyStripeMigrationPortalSession,
  createSubscriptionCancellationPortalSession,
  createSubscriptionCheckoutSession,
  createSubscriptionUpdatePortalSession,
  getBillableTeamSeatCount,
  getBillableTeamSeatCountForOrg,
  getBillingAllowanceConfig,
  getOrgBillingOverview,
  getConfiguredSubscriptionPriceId,
  getLegacyStripeMigrationEligibility,
  getOrCreateBillingPortalConfiguration,
  getInvoiceLinePriceId,
  getInvoiceSubscriptionId,
  getStripeSubscriptionSummary,
  getVerifiedLegacyStripeMigrationEligibility,
  isBillingSetupPath,
  isOrgBillingAccessReady,
  isRecurringSubscriptionInvoice,
  isStripeSecretKeyAllowedForMode,
  isStripeProrationLine,
  loadCanonicalPaidPlanCatalog,
  migrateLegacyStripeSubscription,
  parseStripePriceIdList,
  processPaidSubscriptionInvoice,
  resolveSubscriptionInvoiceGrant,
  resolveOrgBillingAccess,
  StaleTrialingSubscriptionStatusError,
  syncTeamSubscriptionSeatCount,
  syncOrgSubscriptionFromStripe,
  updateTrialingStripeSubscriptionPlan,
} from "@/lib/billing.server";
import type { CanonicalPaidPlanCatalogEntry } from "@/lib/billing.server";
import type { Organization } from "@/types";

// Unit amounts served for GET /v1/prices/{id} by checkout fetch stubs; must
// match BILLING_PLAN_LIMITS or createSubscriptionCheckoutSession fails closed.
const CONFIGURED_TEST_PRICE_UNIT_AMOUNTS: Record<string, number> = {
  price_starter: 1000,
  price_pro: 4000,
  price_team: 5000,
};

function configuredTestPrice(priceId: string) {
  return {
    id: priceId,
    unit_amount: CONFIGURED_TEST_PRICE_UNIT_AMOUNTS[priceId] ?? 0,
    currency: "usd",
    active: true,
    product: `prod_${priceId.replace(/^price_/, "")}`,
    recurring: { interval: "month", interval_count: 1 },
  };
}

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
      getUsageSpend: vi.fn(async () => ({
        total_cost_usd: 0,
        total_requests: 0,
      })),
      getUsageLogSum: vi.fn(async () => ({
        total_cost_usd: 0,
        total_requests: 0,
      })),
      updateBillingState: vi.fn(async (updates: Partial<Organization>) => {
        Object.assign(org, updates);
        return org;
      }),
      syncSubscriptionBillingState: vi.fn(
        async (updates: Partial<Organization>) => {
          Object.assign(org, updates);
          return { org, trialCreditGranted: false };
        },
      ),
      applyManualCreditGrant: vi.fn(
        async (
          amountCents: number,
          _reason?: string | null,
          _idempotencyKey?: string | null,
        ) => {
          org.billing_credit_grant_total_cents =
            (org.billing_credit_grant_total_cents ?? 0) + amountCents;
          return { org };
        },
      ),
      getSubscriptionInvoiceGrant: vi.fn(async () => null),
      applySubscriptionInvoiceGrant: vi.fn(async (command) => {
        org.billing_customer_id = command.customerId;
        org.billing_subscription_id = command.subscriptionId;
        org.billing_plan = command.plan;
        org.billing_seat_count = command.seatCount;
        org.billing_credit_grant_total_cents =
          (org.billing_credit_grant_total_cents ?? 0) + command.grantCents;
        if (command.grantCents > 0) {
          org.billing_last_included_credit_invoice_id = command.invoiceId;
        }
        return {
          org,
          applied: true,
          credited: command.grantCents > 0,
          legacyProcessed: false,
          invariantError: null,
        };
      }),
    };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_STARTER_PRICE_ID: "price_starter",
      STRIPE_PRO_PRICE_ID: "price_pro",
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
    expect(billingStatusLabel("inactive")).toBe("Pay as you go");
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
    expect(normalizeBillingPlan(undefined, "inactive")).toBe("payg");
    expect(normalizeSeatCount("team", 2)).toBe(3);
    expect(getIncludedCreditCentsForPlan("starter", 1)).toBe(1000);
    expect(getIncludedCreditCentsForPlan("pro", 1)).toBe(4000);
    expect(getIncludedCreditCentsForPlan("team", 4)).toBe(20000);
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

  it("builds billing overview from the provided org without rereading org info", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_credit_purchase_total_cents: 5000,
        billing_credit_grant_total_cents: 1000,
      },
      memberCount: 1,
    });
    orgStub.getInfo.mockRejectedValue(new Error("unexpected org info read"));
    orgStub.getUsageLogSum.mockResolvedValue({
      total_cost_usd: 12,
      total_requests: 4,
    });

    const overview = await getOrgBillingOverview(env as never, org);

    expect(orgStub.getInfo).not.toHaveBeenCalled();
    expect(overview.billing_plan).toBe("pro");
    expect(overview.total_credit_limit_cents).toBe(6000);
    expect(overview.available_credits_cents).toBe(4800);
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
      maxCronJobsPerWorkspace: 1,
      maxCronJobsPerUser: null,
      minCronIntervalMs: 24 * 60 * 60 * 1000,
      byokOnly: true,
      emailInbox: false,
    });

    expect(BILLING_PLAN_LIMITS.starter).toMatchObject({
      monthlyPriceCents: 1000,
      minimumSeats: 1,
      includedWorkspaceCount: 1,
      storageGbPerWorkspace: 50,
      includedCreditCentsBase: 1000,
      includedCreditCentsPerSeat: 0,
      maxDeployedAppsPerWorkspace: 30,
      maxCustomDomains: 10,
      maxCronJobsPerWorkspace: 1,
      maxCronJobsPerUser: null,
      minCronIntervalMs: 60 * 60 * 1000,
      byokOnly: false,
      emailInbox: true,
    });

    expect(BILLING_PLAN_LIMITS.pro).toMatchObject({
      monthlyPriceCents: 4000,
      minimumSeats: 1,
      includedWorkspaceCount: 1,
      storageGbPerWorkspace: 100,
      includedCreditCentsBase: 4000,
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
      includedCreditCentsPerSeat: 5000,
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

  it("treats blank legacy active subscription count as unknown", () => {
    expect(
      getLegacyStripeMigrationEligibility({
        env: {
          LEGACY_STRIPE_MIGRATION_CUSTOMERS:
            "email,customer_id,active_legacy_subscription_count\nowner@example.com,cus_123,",
        },
        org: {
          id: "org_123",
          name: "Org",
          slug: "org",
          billing_status: "inactive",
          billing_plan: "free",
          billing_subscription_id: null,
        } as Organization,
        userEmail: "owner@example.com",
      }),
    ).toMatchObject({
      eligible: true,
      customerId: "cus_123",
      activeLegacySubscriptionCount: 1,
    });
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

  it("does not offer legacy migration when the allowlist has no active legacy subscriptions", () => {
    expect(
      getLegacyStripeMigrationEligibility({
        env: {
          LEGACY_STRIPE_MIGRATION_CUSTOMERS:
            "email,customer_id,active_legacy_subscription_count\nowner@example.com,cus_123,0",
        },
        org: {
          id: "org_123",
          name: "Org",
          slug: "org",
          billing_status: "inactive",
          billing_plan: "free",
          billing_subscription_id: null,
        } as Organization,
        userEmail: "owner@example.com",
      }),
    ).toBeNull();
  });

  it("does not verify legacy migration eligibility when Stripe only has trialing legacy subscriptions", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
      },
      memberCount: 1,
    });
    Object.assign(env, {
      LEGACY_STRIPE_MIGRATION_CUSTOMERS:
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids\nowner@example.com,cus_123,1,sub_trial,si_trial,price_1QIfnqGvliMKf4vHaDTMG2Mu",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "sub_trial",
          status: "trialing",
          customer: "cus_123",
          items: {
            data: [
              {
                id: "si_trial",
                quantity: 1,
                price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
              },
            ],
          },
        }),
      })),
    );

    await expect(
      getVerifiedLegacyStripeMigrationEligibility({
        env: env as never,
        org,
        userEmail: "owner@example.com",
      }),
    ).resolves.toBeNull();
  });

  it("requires manual migration for multiple active legacy subscriptions", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      LEGACY_STRIPE_MIGRATION_CUSTOMERS:
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids\nowner@example.com,cus_123,2,sub_a|sub_b,si_a|si_b,price_1QIfnqGvliMKf4vHaDTMG2Mu",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => ({
          id: url.endsWith("/subscriptions/sub_a") ? "sub_a" : "sub_b",
          status: "active",
          customer: "cus_123",
          metadata: {},
          items: {
            data: [
              {
                id: url.endsWith("/subscriptions/sub_a") ? "si_a" : "si_b",
                quantity: 1,
                price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
              },
            ],
          },
        }),
      })),
    );

    await expect(
      migrateLegacyStripeSubscription({
        env: env as never,
        org,
        userEmail: "owner@example.com",
        plan: "pro",
      }),
    ).rejects.toThrow("multiple active legacy subscriptions");
  });

  it("rejects legacy migration when the allowlist has no active legacy subscriptions", async () => {
    await expect(
      migrateLegacyStripeSubscription({
        env: {
          LEGACY_STRIPE_MIGRATION_CUSTOMERS:
            "email,customer_id,active_legacy_subscription_count\nowner@example.com,cus_123,0",
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
    ).rejects.toThrow("not eligible");
  });

  it("does not migrate trialing legacy subscriptions", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
      },
      memberCount: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "sub_legacy_trial",
          status: "trialing",
          customer: "cus_123",
          metadata: {},
          items: {
            data: [
              {
                id: "si_legacy_trial",
                quantity: 1,
                price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
              },
            ],
          },
        }),
      })),
    );

    await expect(
      migrateLegacyStripeSubscription({
        env: {
          ...env,
          STRIPE_PRO_PRICE_ID: "price_pro",
          LEGACY_STRIPE_MIGRATION_CUSTOMERS:
            "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids\nowner@example.com,cus_123,1,sub_legacy_trial,si_legacy_trial,price_1QIfnqGvliMKf4vHaDTMG2Mu",
        } as never,
        org,
        userEmail: "owner@example.com",
        plan: "pro",
      }),
    ).rejects.toThrow("No active legacy subscription");
  });

  it("creates a Stripe portal confirmation session for legacy migrations", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      LEGACY_STRIPE_MIGRATION_CUSTOMERS:
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids\nowner@example.com,cus_123,2,sub_legacy,si_legacy,price_1QIfnqGvliMKf4vHaDTMG2Mu",
    });

    let customerRequestBody: string | null = null;
    let portalRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_legacy") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_legacy",
            status: "active",
            customer: "cus_123",
            metadata: {},
            items: {
              data: [
                {
                  id: "si_legacy",
                  quantity: 1,
                  price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/customers/cus_123")) {
        customerRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ id: "cus_123", metadata: {} }),
        };
      }
      if (url.includes("/invoices/create_preview?")) {
        return {
          ok: true,
          json: async () => ({
            amount_due: 996,
            total: 996,
            lines: {
              data: [
                {
                  amount: -3004,
                  currency: "usd",
                  proration: true,
                },
                {
                  amount: 4000,
                  currency: "usd",
                  proration: true,
                },
              ],
            },
          }),
        };
      }
      if (url.includes("/prices/")) {
        return { ok: true, json: async () => configuredTestPrice(url.split("/prices/")[1]) };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return { ok: true, json: async () => ({ id: "bpc_upgrade" }) };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createLegacyStripeMigrationPortalSession({
        env: env as never,
        org,
        userEmail: "owner@example.com",
        returnUrl: "https://camelai.test/onboarding",
        plan: "pro",
      }),
    ).resolves.toMatchObject({
      billingPortalUrl: "https://billing.stripe.test/session",
      preview: {
        amountDueTodayCents: 996,
        currency: "usd",
        includedCreditCents: 4000,
        legacyCreditCents: 3004,
        monthlyPriceCents: 4000,
        newPlanProrationCents: 4000,
        plan: "pro",
        seatCount: 1,
      },
    });

    const customerParams = new URLSearchParams(customerRequestBody ?? "");
    expect(customerParams.get("metadata[v2_mig_org]")).toBe("org_team");
    expect(customerParams.get("metadata[v2_mig_sub]")).toBe("sub_legacy");
    expect(customerParams.get("metadata[v2_mig_plan]")).toBe("pro");
    expect(customerParams.get("metadata[v2_mig_credits]")).toBe("4000");
    expect(
      customerParams.has(
        "metadata[pending_legacy_migration_included_credit_cents]",
      ),
    ).toBe(false);

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("customer")).toBe("cus_123");
    expect(portalParams.get("flow_data[type]")).toBe(
      "subscription_update_confirm",
    );
    expect(
      portalParams.get("flow_data[subscription_update_confirm][subscription]"),
    ).toBe("sub_legacy");
    expect(
      portalParams.get("flow_data[subscription_update_confirm][items][0][id]"),
    ).toBe("si_legacy");
    expect(
      portalParams.get(
        "flow_data[subscription_update_confirm][items][0][price]",
      ),
    ).toBe("price_pro");
    expect(
      portalParams.get("flow_data[after_completion][redirect][return_url]"),
    ).toBe("https://camelai.test/onboarding");
    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_customer_id: "cus_123",
    });
  });

  it("uses the direct Stripe confirmation page for Team legacy migrations", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
      },
      memberCount: 5,
    });
    Object.assign(env, {
      STRIPE_TEAM_PRICE_ID: "price_team",
      LEGACY_STRIPE_MIGRATION_CUSTOMERS:
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_ids,total_legacy_quantity\nowner@example.com,cus_123,1,sub_legacy,si_legacy,price_1S6NRLGvliMKf4vHtFDiA07o,5",
    });

    let portalRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_legacy") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_legacy",
            status: "active",
            customer: "cus_123",
            metadata: {},
            items: {
              data: [
                {
                  id: "si_legacy",
                  quantity: 5,
                  price: "price_1S6NRLGvliMKf4vHtFDiA07o",
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/customers/cus_123")) {
        return {
          ok: true,
          json: async () => ({ id: "cus_123", metadata: {} }),
        };
      }
      if (url.includes("/invoices/create_preview?")) {
        return {
          ok: true,
          json: async () => ({ amount_due: 0, total: 0, lines: { data: [] } }),
        };
      }
      if (url.includes("/prices/")) {
        return { ok: true, json: async () => configuredTestPrice(url.split("/prices/")[1]) };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return { ok: true, json: async () => ({ id: "bpc_upgrade" }) };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await createLegacyStripeMigrationPortalSession({
      env: env as never,
      org,
      userEmail: "owner@example.com",
      returnUrl: "https://camelai.test/onboarding",
      plan: "team",
    });

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("configuration")).toBe("bpc_upgrade");
    expect(portalParams.get("flow_data[type]")).toBe(
      "subscription_update_confirm",
    );
    expect(
      portalParams.get("flow_data[subscription_update_confirm][subscription]"),
    ).toBe("sub_legacy");
    expect(
      portalParams.get("flow_data[subscription_update_confirm][items][0][id]"),
    ).toBe("si_legacy");
    expect(
      portalParams.get(
        "flow_data[subscription_update_confirm][items][0][price]",
      ),
    ).toBe("price_team");
    expect(
      portalParams.get(
        "flow_data[subscription_update_confirm][items][0][quantity]",
      ),
    ).toBe("5");
  });

  it("syncs portal-confirmed legacy migrations without granting before invoice payment", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    let subscriptionMetadataBody: string | null = null;
    let customerClearBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/customers/cus_123") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "cus_123",
            metadata: {
              org_id: "org_stale",
              v2_mig_org: "org_team",
              v2_mig_sub: "sub_legacy",
              v2_mig_plan: "pro",
              v2_mig_credits: "3000",
            },
          }),
        };
      }
      if (url.endsWith("/subscriptions/sub_legacy") && init?.body) {
        subscriptionMetadataBody = init.body as string;
        return {
          ok: true,
          json: async () => ({ id: "sub_legacy" }),
        };
      }
      if (url.endsWith("/customers/cus_123") && init?.body) {
        customerClearBody = init.body as string;
        return {
          ok: true,
          json: async () => ({ id: "cus_123" }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_legacy",
        status: "active",
        customer: "cus_123",
        metadata: {},
        items: {
          data: [
            {
              id: "si_pro",
              quantity: 1,
              price: { id: "price_pro", unit_amount: 15000, currency: "usd" },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      billing_status: "active",
      billing_plan: "pro",
      billing_subscription_id: "sub_legacy",
      billing_credit_grant_total_cents: 0,
    });

    expect(orgStub.applyManualCreditGrant).not.toHaveBeenCalled();
    const subscriptionParams = new URLSearchParams(
      subscriptionMetadataBody ?? "",
    );
    expect(subscriptionParams.get("metadata[org_id]")).toBe("org_team");
    expect(subscriptionParams.get("metadata[billing_plan]")).toBe("pro");
    expect(customerClearBody).toBeNull();
  });

  it("respects zero included-credit override for portal-confirmed legacy migrations", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS: "0",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/customers/cus_123") && !init?.body) {
          return {
            ok: true,
            json: async () => ({
              id: "cus_123",
              metadata: {
                pending_legacy_migration_org_id: "org_team",
                pending_legacy_migration_subscription_id: "sub_legacy",
                pending_legacy_migration_target_plan: "pro",
                pending_legacy_migration_included_credit_cents: "3000",
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ id: "ok" }),
        };
      }),
    );

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_legacy",
        status: "active",
        customer: "cus_123",
        metadata: {},
        items: {
          data: [
            {
              id: "si_pro",
              quantity: 1,
              price: { id: "price_pro", unit_amount: 15000, currency: "usd" },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      billing_status: "active",
      billing_plan: "pro",
      billing_credit_grant_total_cents: 0,
    });

    expect(orgStub.applyManualCreditGrant).not.toHaveBeenCalled();
  });

  it("does not resolve pending legacy migration metadata before the subscription has a v2 price", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/customers/cus_123") && !init?.body) {
          return {
            ok: true,
            json: async () => ({
              id: "cus_123",
              metadata: {
                pending_legacy_migration_org_id: "org_team",
                pending_legacy_migration_subscription_id: "sub_legacy",
                pending_legacy_migration_target_plan: "pro",
                pending_legacy_migration_included_credit_cents: "3000",
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({}),
        };
      }),
    );

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_legacy",
        status: "active",
        customer: "cus_123",
        metadata: {},
        items: {
          data: [
            {
              id: "si_legacy",
              quantity: 1,
              price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
            },
          ],
        },
      }),
    ).resolves.toBeNull();

    expect(orgStub.syncSubscriptionBillingState).not.toHaveBeenCalled();
    expect(orgStub.applyManualCreditGrant).not.toHaveBeenCalled();
  });

  it("syncs Team legacy migration seats without granting before payment", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "inactive",
        billing_plan: "free",
        billing_subscription_id: null,
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/customers/cus_123") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "cus_123",
            metadata: {
              pending_legacy_migration_org_id: "org_team",
              pending_legacy_migration_subscription_id: "sub_legacy",
              pending_legacy_migration_target_plan: "team",
              pending_legacy_migration_included_credit_cents: "3000",
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ id: "ok" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_legacy",
        status: "active",
        customer: "cus_123",
        metadata: {},
        items: {
          data: [
            {
              id: "si_team",
              quantity: 5,
              price: { id: "price_team", unit_amount: 5000, currency: "usd" },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      billing_plan: "team",
      billing_seat_count: 5,
      billing_credit_grant_total_cents: 0,
    });

    expect(orgStub.applyManualCreditGrant).not.toHaveBeenCalled();
  });

  it("resolves org billing access from one shared rule", () => {
    expect(
      isOrgBillingAccessReady(
        resolveOrgBillingAccess({
          org: {
            billing_status: "inactive",
            billing_plan: "payg",
            billing_credit_purchase_total_cents: 0,
            billing_credit_grant_total_cents: 0,
          } as Organization,
        }),
      ),
    ).toBe(false);

    expect(
      resolveOrgBillingAccess({
        org: {
          billing_status: "inactive",
          billing_plan: "payg",
          billing_credit_purchase_total_cents: 500,
          billing_credit_grant_total_cents: 0,
        } as Organization,
      }),
    ).toMatchObject({ kind: "ready", mode: "credits" });

    expect(
      resolveOrgBillingAccess({
        org: {
          billing_status: "active",
          billing_plan: "starter",
          billing_credit_purchase_total_cents: 0,
          billing_credit_grant_total_cents: 0,
        } as Organization,
      }),
    ).toMatchObject({ kind: "ready", mode: "subscription" });

    expect(
      resolveOrgBillingAccess({
        env: { CF_ACCOUNT_ID: "selfhost" },
        org: {
          billing_status: "inactive",
          billing_plan: "free",
          billing_credit_purchase_total_cents: 0,
          billing_credit_grant_total_cents: 0,
        } as Organization,
      }),
    ).toMatchObject({ kind: "ready", mode: "selfhost" });

    expect(
      resolveOrgBillingAccess({
        org: {
          billing_status: "inactive",
          billing_plan: "free",
          billing_credit_purchase_total_cents: 0,
          billing_credit_grant_total_cents: 0,
        } as Organization,
        llmProviderConfig: { provider: "openrouter" },
      }),
    ).toMatchObject({ kind: "ready", mode: "byok" });
  });

  it("limits setup access to billing setup paths", () => {
    expect(isBillingSetupPath("/settings/organization/billing")).toBe(true);
    expect(isBillingSetupPath("/settings/organization/usage")).toBe(true);
    expect(isBillingSetupPath("/settings/organization/team")).toBe(false);
    expect(isBillingSetupPath("/chat")).toBe(false);

    expect(
      resolveOrgBillingAccess({
        org: {
          billing_status: "inactive",
          billing_plan: "payg",
          billing_credit_purchase_total_cents: 0,
          billing_credit_grant_total_cents: 0,
        } as Organization,
        pathname: "/settings/organization/usage",
      }),
    ).toMatchObject({
      kind: "setup_required",
      setupRouteAccessible: true,
    });
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

  it("creates and attaches the code-owned management portal configuration", async () => {
    let portalRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init) => {
        if (url.endsWith("/billing_portal/configurations")) {
          const params = new URLSearchParams(String(init?.body));
          expect(params.get("features[subscription_update][enabled]")).toBe("false");
          return { ok: true, json: async () => ({ id: "bpc_management" }) };
        }
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
    expect(portalParams.get("configuration")).toBe("bpc_management");
  });

  it("keeps general management separate from cancellation deep links", async () => {
    let portalRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init) => {
        if (url.endsWith("/billing_portal/configurations")) {
          return { ok: true, json: async () => ({ id: "bpc_management" }) };
        }
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
    expect(portalParams.has("flow_data[type]")).toBe(false);
  });

  it("reports Stripe subscription cancellation summary metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "sub_123",
          status: "active",
          current_period_end: 1_778_342_400,
          cancel_at: 1_778_342_400,
          cancel_at_period_end: true,
          trial_end: 1_776_787_200,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "sub_123",
          status: "active",
          current_period_end: 1_781_020_800,
          cancel_at: null,
          cancel_at_period_end: true,
          trial_end: null,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ORG: {} as never,
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
    };
    const org = {
      id: "org_123",
      billing_subscription_id: "sub_123",
    } as never;

    await expect(getStripeSubscriptionSummary(env, org)).resolves.toMatchObject(
      {
        cancel_at_ms: 1_778_342_400_000,
        cancellation_date_ms: 1_778_342_400_000,
        cancel_at_period_end: true,
        is_canceling: true,
      },
    );

    await expect(getStripeSubscriptionSummary(env, org)).resolves.toMatchObject(
      {
        cancel_at_ms: null,
        cancellation_date_ms: 1_781_020_800_000,
        cancel_at_period_end: true,
        is_canceling: true,
      },
    );
  });

  it("returns already scheduled cancellation without creating a portal session", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_customer_id: "cus_local",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_subscription",
            current_period_end: 1_778_342_400,
            cancel_at_period_end: true,
            metadata: {
              org_id: "org_team",
              billing_plan: "pro",
              seat_count: "1",
              subscription_included_credit_cents: "4000",
            },
            items: {
              data: [
                {
                  id: "si_pro",
                  quantity: 1,
                  price: { id: "price_pro" },
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return { ok: true, json: async () => ({ id: "bpc_management" }) };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionCancellationPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).resolves.toEqual({
      kind: "already_scheduled",
      cancellationDateMs: 1_778_342_400_000,
      subscriptionStatus: "active",
    });

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/billing_portal/sessions"),
      ),
    ).toBe(false);
    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_status: "active",
        billing_plan: "pro",
        billing_subscription_id: "sub_team",
      }),
      4000,
    );
  });

  it("treats portal creation failure as success when refresh shows cancellation", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_customer_id: "cus_subscription",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    const activeSubscription = {
      id: "sub_team",
      status: "active",
      customer: "cus_subscription",
      current_period_end: 1_778_342_400,
      cancel_at_period_end: false,
      metadata: {
        org_id: "org_team",
        billing_plan: "pro",
        seat_count: "1",
        subscription_included_credit_cents: "4000",
      },
      items: {
        data: [{ id: "si_pro", quantity: 1, price: { id: "price_pro" } }],
      },
    };
    let subscriptionFetchCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        subscriptionFetchCount += 1;
        const subscription =
          subscriptionFetchCount === 1
            ? activeSubscription
            : { ...activeSubscription, cancel_at_period_end: true };
        return {
          ok: true,
          json: async () => subscription,
        };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        return {
          ok: false,
          status: 400,
          text: async () => "portal failed",
        };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return { ok: true, json: async () => ({ id: "bpc_management" }) };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionCancellationPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).resolves.toEqual({
      kind: "already_scheduled",
      cancellationDateMs: 1_778_342_400_000,
      subscriptionStatus: "active",
    });
  });

  it("throws portal creation failures when refresh does not show cancellation", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_customer_id: "cus_subscription",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
    });
    const subscription = {
      id: "sub_team",
      status: "active",
      customer: "cus_subscription",
      current_period_end: 1_778_342_400,
      cancel_at_period_end: false,
      metadata: {
        org_id: "org_team",
        billing_plan: "pro",
        seat_count: "1",
        subscription_included_credit_cents: "4000",
      },
      items: {
        data: [{ id: "si_pro", quantity: 1, price: { id: "price_pro" } }],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/subscriptions/sub_team")) {
          return {
            ok: true,
            json: async () => subscription,
          };
        }
        if (url.endsWith("/billing_portal/sessions")) {
          return {
            ok: false,
            status: 400,
            text: async () => "portal failed",
          };
        }
        if (url.endsWith("/billing_portal/configurations")) {
          return { ok: true, json: async () => ({ id: "bpc_management" }) };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      }),
    );

    await expect(
      createSubscriptionCancellationPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).rejects.toThrow("Stripe /billing_portal/sessions returned 400");
  });

  it("uses the subscription customer for cancellation portal sessions", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_customer_id: "cus_stale",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    let portalRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_subscription",
            current_period_end: 1_778_342_400,
            cancel_at_period_end: false,
            metadata: {
              org_id: "org_team",
              billing_plan: "pro",
              seat_count: "1",
              subscription_included_credit_cents: "4000",
            },
            items: {
              data: [
                {
                  id: "si_pro",
                  quantity: 1,
                  price: { id: "price_pro" },
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/customers/cus_subscription")) {
        return {
          ok: true,
          json: async () => ({ id: "cus_subscription", metadata: { org_id: "org_team" } }),
        };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return { ok: true, json: async () => ({ id: "bpc_management" }) };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionCancellationPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
        afterCompletionReturnUrl:
          "https://camelai.dev/settings/organization/billing?cancelled=1",
      }),
    ).resolves.toEqual({
      kind: "portal",
      billingPortalUrl: "https://billing.stripe.test/session",
    });

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("customer")).toBe("cus_subscription");
    expect(portalParams.get("configuration")).toBe("bpc_management");
    expect(portalParams.get("flow_data[type]")).toBe("subscription_cancel");
    expect(
      portalParams.get("flow_data[subscription_cancel][subscription]"),
    ).toBe("sub_team");
    expect(
      portalParams.get("flow_data[after_completion][redirect][return_url]"),
    ).toBe("https://camelai.dev/settings/organization/billing?cancelled=1");
    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_customer_id: "cus_subscription",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/customers/"))).toBe(true);
  });

  it("creates an exact Stripe confirmation for Team with server-computed seats", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 3,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      STRIPE_TEAM_PRICE_ID: "price_team",
    });

    let portalConfigRequestBody: string | null = null;
    let portalRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: { org_id: "org_team", billing_plan: "pro" },
            items: {
              data: [
                {
                  id: "si_pro",
                  quantity: 1,
                  price: { id: "price_pro" },
                },
              ],
            },
          }),
        };
      }
      if (url.includes("/prices/") && !init?.body) {
        return { ok: true, json: async () => configuredTestPrice(url.split("/prices/")[1]) };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        portalConfigRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ id: "bpc_upgrade" }),
        };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionUpdatePortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
        plan: "team",
        seatCount: 8,
      }),
    ).resolves.toBe("https://billing.stripe.test/session");

    const portalConfigParams = new URLSearchParams(
      portalConfigRequestBody ?? "",
    );
    expect(portalConfigParams.get("features[subscription_update][proration_behavior]")).toBe("always_invoice");
    expect(
      portalConfigParams.getAll(
        "features[subscription_update][default_allowed_updates][]",
      ),
    ).toEqual(["price", "quantity"]);
    expect(portalConfigParams.get("features[subscription_update][products][2][adjustable_quantity][enabled]")).toBe("false");

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("customer")).toBe("cus_123");
    expect(portalParams.get("configuration")).toBe("bpc_upgrade");
    expect(portalParams.get("flow_data[type]")).toBe("subscription_update_confirm");
    expect(
      portalParams.get("flow_data[subscription_update_confirm][subscription]"),
    ).toBe("sub_team");
    expect(
      portalParams.get("flow_data[subscription_update_confirm][items][0][id]"),
    ).toBe("si_pro");
    expect(
      portalParams.get(
        "flow_data[subscription_update_confirm][items][0][quantity]",
      ),
    ).toBe("3");
    expect(portalParams.get("flow_data[after_completion][type]")).toBe(
      "redirect",
    );
    expect(
      portalParams.get("flow_data[after_completion][redirect][return_url]"),
    ).toBe("https://camelai.dev/settings/organization/billing");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("creates a Stripe portal confirmation session for individual plan changes", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_STARTER_PRICE_ID: "price_starter",
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    let portalRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: { org_id: "org_team", billing_plan: "starter" },
            items: {
              data: [
                {
                  id: "si_starter",
                  quantity: 1,
                  price: { id: "price_starter" },
                },
              ],
            },
          }),
        };
      }
      if (url.includes("/prices/") && !init?.body) {
        return {
          ok: true,
          json: async () => configuredTestPrice(url.split("/prices/")[1]),
        };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return {
          ok: true,
          json: async () => ({ id: "bpc_v2" }),
        };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionUpdatePortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
        plan: "pro",
        seatCount: 1,
      }),
    ).resolves.toBe("https://billing.stripe.test/session");

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("customer")).toBe("cus_123");
    expect(portalParams.get("configuration")).toBe("bpc_v2");
    expect(portalParams.get("flow_data[type]")).toBe(
      "subscription_update_confirm",
    );
    expect(
      portalParams.get("flow_data[subscription_update_confirm][subscription]"),
    ).toBe("sub_team");
    expect(
      portalParams.get("flow_data[subscription_update_confirm][items][0][id]"),
    ).toBe("si_starter");
    expect(
      portalParams.get(
        "flow_data[subscription_update_confirm][items][0][price]",
      ),
    ).toBe("price_pro");
    expect(
      portalParams.get(
        "flow_data[subscription_update_confirm][items][0][quantity]",
      ),
    ).toBe("1");
    expect(portalParams.get("flow_data[after_completion][type]")).toBe(
      "redirect",
    );
  });

  it("uses a no-proration exact confirmation for a lower monthly total", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 3,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 3,
    });
    let portalConfigRequestBody: string | null = null;
    let portalRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
          return {
            ok: true,
            json: async () => ({
              id: "sub_team",
              status: "active",
              customer: "cus_123",
              items: { data: [{ id: "si_team", quantity: 3, price: "price_team" }] },
            }),
          };
        }
        if (url.includes("/prices/") && !init?.body) {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        if (url.endsWith("/billing_portal/configurations")) {
          portalConfigRequestBody = init?.body as string;
          return { ok: true, json: async () => ({ id: "bpc_downgrade" }) };
        }
        if (url.endsWith("/billing_portal/sessions")) {
          portalRequestBody = init?.body as string;
          return {
            ok: true,
            json: async () => ({ url: "https://billing.stripe.test/session" }),
          };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      }),
    );

    await createSubscriptionUpdatePortalSession({
      env: env as never,
      org,
      customerEmail: "owner@example.com",
      returnUrl: "https://camelai.dev/settings/organization/billing",
      plan: "pro",
    });

    const config = new URLSearchParams(portalConfigRequestBody ?? "");
    expect(config.get("features[subscription_update][proration_behavior]")).toBe("none");
    const portal = new URLSearchParams(portalRequestBody ?? "");
    expect(portal.get("configuration")).toBe("bpc_downgrade");
    expect(portal.get("flow_data[type]")).toBe("subscription_update_confirm");
    expect(portal.get("flow_data[subscription_update_confirm][items][0][price]")).toBe("price_pro");
    expect(portal.get("flow_data[subscription_update_confirm][items][0][quantity]")).toBe("1");
  });

  it("uses the subscription customer for existing plan change portal sessions", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_customer_id: "cus_stale",
        billing_subscription_id: "sub_team",
      },
      memberCount: 3,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      STRIPE_TEAM_PRICE_ID: "price_team",
    });

    let portalRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_subscription",
            metadata: { org_id: "org_team", billing_plan: "pro" },
            items: {
              data: [
                {
                  id: "si_pro",
                  quantity: 1,
                  price: { id: "price_pro" },
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/customers/cus_subscription") && !init?.body) {
        return {
          ok: true,
          json: async () => ({ id: "cus_subscription", metadata: { org_id: "org_team" } }),
        };
      }
      if (url.includes("/prices/") && !init?.body) {
        return {
          ok: true,
          json: async () => configuredTestPrice(url.split("/prices/")[1]),
        };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return {
          ok: true,
          json: async () => ({ id: "bpc_team_dynamic" }),
        };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        portalRequestBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionUpdatePortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
        plan: "team",
        seatCount: 3,
      }),
    ).resolves.toBe("https://billing.stripe.test/session");

    const portalParams = new URLSearchParams(portalRequestBody ?? "");
    expect(portalParams.get("customer")).toBe("cus_subscription");
    expect(portalParams.get("configuration")).toBe("bpc_team_dynamic");
    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_customer_id: "cus_subscription",
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/customers")),
    ).toBe(false);
  });

  it("updates trialing subscription plans directly without ending the trial", async () => {
    const trialStart = 1_761_000_000;
    const trialEnd = 1_761_604_800;
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "trialing",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_trial",
        billing_subscription_id: "sub_trial",
        billing_trial_started_at: trialStart * 1000,
        billing_trial_ends_at: trialEnd * 1000,
        billing_trial_credit_grant_cents: 1000,
        billing_trial_credit_granted_at: Date.now(),
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_STARTER_PRICE_ID: "price_starter",
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    let updateRequestBody: string | null = null;
    let updateRequestHeaders: Headers | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_trial") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_trial",
            status: "trialing",
            customer: "cus_trial",
            trial_start: trialStart,
            trial_end: trialEnd,
            metadata: {
              org_id: "org_team",
              billing_plan: "starter",
              seat_count: "1",
              trial_credit_cents: "1000",
              subscription_included_credit_cents: "1000",
            },
            items: {
              data: [
                {
                  id: "si_starter",
                  quantity: 1,
                  price: { id: "price_starter" },
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/subscriptions/sub_trial") && init?.body) {
        updateRequestBody = init.body as string;
        updateRequestHeaders =
          init.headers instanceof Headers
            ? init.headers
            : new Headers(init.headers);
        return {
          ok: true,
          json: async () => ({
            id: "sub_trial",
            status: "trialing",
            customer: "cus_trial",
            trial_start: trialStart,
            trial_end: trialEnd,
            metadata: {
              org_id: "org_team",
              billing_plan: "pro",
              seat_count: "1",
              trial_credit_cents: "1000",
              subscription_included_credit_cents: "4000",
            },
            items: {
              data: [
                {
                  id: "si_starter",
                  quantity: 1,
                  price: { id: "price_pro" },
                },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateTrialingStripeSubscriptionPlan({
        env: env as never,
        org,
        plan: "pro",
        seatCount: 1,
      }),
    ).resolves.toMatchObject({
      billing_status: "trialing",
      billing_plan: "pro",
      billing_subscription_id: "sub_trial",
    });

    const updateParams = new URLSearchParams(updateRequestBody ?? "");
    expect(updateParams.get("items[0][id]")).toBe("si_starter");
    expect(updateParams.get("items[0][price]")).toBe("price_pro");
    expect(updateParams.get("items[0][quantity]")).toBe("1");
    expect(updateParams.get("proration_behavior")).toBe("none");
    expect(updateParams.get("trial_end")).toBeNull();
    expect(updateParams.get("metadata[trial_credit_cents]")).toBe("1000");
    expect(
      updateParams.get("metadata[subscription_included_credit_cents]"),
    ).toBe("4000");
    expect(
      (updateRequestHeaders as Headers | null)?.get("Idempotency-Key") ?? null,
    ).toBeNull();
    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_status: "trialing",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_subscription_id: "sub_trial",
      }),
      1000,
    );
  });

  it("syncs and reports stale local trial state when Stripe is no longer trialing", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "trialing",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_trial",
        billing_subscription_id: "sub_trial",
      },
      memberCount: 1,
    });
    Object.assign(env, {
      STRIPE_STARTER_PRICE_ID: "price_starter",
      STRIPE_PRO_PRICE_ID: "price_pro",
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_trial") && !init?.body) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_trial",
            status: "active",
            customer: "cus_trial",
            metadata: {
              org_id: "org_team",
              billing_plan: "starter",
              seat_count: "1",
              subscription_included_credit_cents: "1000",
            },
            items: {
              data: [
                {
                  id: "si_starter",
                  quantity: 1,
                  price: { id: "price_starter" },
                },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateTrialingStripeSubscriptionPlan({
        env: env as never,
        org,
        plan: "pro",
        seatCount: 1,
      }),
    ).rejects.toBeInstanceOf(StaleTrialingSubscriptionStatusError);

    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_status: "active",
        billing_plan: "starter",
        billing_subscription_id: "sub_trial",
      }),
      1000,
    );
  });

  it("syncs corrected Stripe subscription metadata when item price changed through the portal", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      memberCount: 4,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      STRIPE_TEAM_PRICE_ID: "price_team",
    });

    let subscriptionRequestBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && init?.body) {
        subscriptionRequestBody = init.body as string;
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "4",
              subscription_included_credit_cents: "4000",
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_team",
        status: "active",
        customer: "cus_123",
        metadata: {
          org_id: "org_team",
          billing_plan: "pro",
          seat_count: "1",
          subscription_included_credit_cents: "3000",
        },
        items: {
          data: [
            {
              id: "si_team",
              quantity: 4,
              price: {
                id: "price_team",
                unit_amount: 5000,
                currency: "usd",
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      billing_plan: "team",
      billing_seat_count: 4,
    });

    const subscriptionParams = new URLSearchParams(
      subscriptionRequestBody ?? "",
    );
    expect(subscriptionParams.get("metadata[billing_plan]")).toBe("team");
    expect(subscriptionParams.get("metadata[seat_count]")).toBe("4");
    expect(
      subscriptionParams.get("metadata[subscription_included_credit_cents]"),
    ).toBe("20000");
    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_plan: "team",
        billing_seat_count: 4,
      }),
      1000,
    );
  });

  it("infers subscription plan from configured Stripe item price when metadata is stale", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
      },
      memberCount: 4,
    });
    Object.assign(env, {
      STRIPE_PRO_PRICE_ID: "price_pro",
      STRIPE_TEAM_PRICE_ID: "price_team",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({}),
      })),
    );

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_team",
        status: "active",
        customer: "cus_123",
        metadata: {
          org_id: "org_team",
          billing_plan: "pro",
          seat_count: "1",
        },
        items: {
          data: [
            {
              id: "si_team",
              quantity: 4,
              price: {
                id: "price_team",
                unit_amount: 5000,
                currency: "usd",
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      billing_plan: "team",
      billing_seat_count: 4,
    });

    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_plan: "team",
        billing_seat_count: 4,
      }),
      1000,
    );
  });

  it("keeps pending-cancel active and trialing subscriptions non-terminal", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 3,
      },
      memberCount: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({}),
      })),
    );

    const baseSubscription = {
      id: "sub_team",
      customer: "cus_123",
      cancel_at_period_end: true,
      current_period_end: 1_778_342_400,
      metadata: {
        org_id: "org_team",
        billing_plan: "team",
        seat_count: "3",
        subscription_included_credit_cents: "3000",
      },
      items: {
        data: [
          {
            id: "si_team",
            quantity: 3,
            price: {
              id: "price_team",
              unit_amount: 5000,
              currency: "usd",
            },
          },
        ],
      },
    };

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        ...baseSubscription,
        status: "trialing",
      }),
    ).resolves.toMatchObject({
      billing_status: "trialing",
      billing_plan: "team",
      billing_subscription_id: "sub_team",
      billing_subscription_status: "trialing",
    });

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        ...baseSubscription,
        status: "active",
      }),
    ).resolves.toMatchObject({
      billing_status: "active",
      billing_plan: "team",
      billing_subscription_id: "sub_team",
      billing_subscription_status: "active",
    });

    expect(orgStub.syncSubscriptionBillingState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        billing_status: "active",
        billing_subscription_id: "sub_team",
      }),
      1000,
    );
  });

  it("uses tier-specific subscription price, quantity, and included credit metadata", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const priceId = String(url).split("/prices/")[1];
        if (priceId) {
          return {
            ok: true,
            json: async () => ({
              id: priceId,
              unit_amount: CONFIGURED_TEST_PRICE_UNIT_AMOUNTS[priceId] ?? 0,
              currency: "usd",
              active: true,
              product: `prod_${priceId.replace(/^price_/, "")}`,
              recurring: { interval: "month", interval_count: 1 },
            }),
          };
        }
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
    expect(
      params.get("line_items[0][adjustable_quantity][enabled]"),
    ).toBe("true");
    expect(
      params.get("line_items[0][adjustable_quantity][minimum]"),
    ).toBe("3");
    expect(
      params.get("line_items[0][adjustable_quantity][maximum]"),
    ).toBe("999999");
    expect(params.get("subscription_data[metadata][billing_plan]")).toBe(
      "team",
    );
    expect(params.has("subscription_data[trial_period_days]")).toBe(false);
    expect(params.get("subscription_data[metadata][trial_credit_cents]")).toBe(
      "0",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("15000");
    expect(
      params.get("subscription_data[metadata][initial_included_credit_cents]"),
    ).toBe("15000");
  });

  it("blocks Checkout for persisted enterprise orgs", async () => {
    await expect(
      createSubscriptionCheckoutSession({
        env: {
          ORG: {} as never,
          STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: "sk_test_123",
          STRIPE_PRO_PRICE_ID: "price_pro",
        },
        org: {
          id: "org_123",
          name: "SecLock",
          slug: "seclock",
          billing_status: "enterprise",
          billing_plan: "enterprise",
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

  it("sets team included credits with seat count and no trial credits", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const priceId = String(url).split("/prices/")[1];
        if (priceId) {
          return {
            ok: true,
            json: async () => ({
              id: priceId,
              unit_amount: CONFIGURED_TEST_PRICE_UNIT_AMOUNTS[priceId] ?? 0,
              currency: "usd",
              active: true,
              product: `prod_${priceId.replace(/^price_/, "")}`,
              recurring: { interval: "month", interval_count: 1 },
            }),
          };
        }
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
    expect(
      params.get("line_items[0][adjustable_quantity][enabled]"),
    ).toBe("true");
    expect(
      params.get("line_items[0][adjustable_quantity][minimum]"),
    ).toBe("25");
    expect(
      params.get("line_items[0][adjustable_quantity][maximum]"),
    ).toBe("999999");
    expect(params.get("subscription_data[metadata][trial_credit_cents]")).toBe(
      "0",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("125000");
    expect(
      params.get("subscription_data[metadata][initial_included_credit_cents]"),
    ).toBe("125000");
  });

  it("sets a Team checkout adjustable maximum above large starting quantities", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const priceId = String(url).split("/prices/")[1];
        if (priceId) {
          return {
            ok: true,
            json: async () => ({
              id: priceId,
              unit_amount: CONFIGURED_TEST_PRICE_UNIT_AMOUNTS[priceId] ?? 0,
              currency: "usd",
              active: true,
              product: `prod_${priceId.replace(/^price_/, "")}`,
              recurring: { interval: "month", interval_count: 1 },
            }),
          };
        }
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
      seatCount: 125,
    });

    const params = new URLSearchParams(checkoutRequestBody ?? "");
    expect(params.get("line_items[0][quantity]")).toBe("125");
    expect(
      params.get("line_items[0][adjustable_quantity][minimum]"),
    ).toBe("125");
    expect(
      params.get("line_items[0][adjustable_quantity][maximum]"),
    ).toBe("999999");
  });

  it("omits Stripe trial days for subscription checkout", async () => {
    let checkoutRequestBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const priceId = String(url).split("/prices/")[1];
        if (priceId) {
          return {
            ok: true,
            json: async () => ({
              id: priceId,
              unit_amount: CONFIGURED_TEST_PRICE_UNIT_AMOUNTS[priceId] ?? 0,
              currency: "usd",
              active: true,
              product: `prod_${priceId.replace(/^price_/, "")}`,
              recurring: { interval: "month", interval_count: 1 },
            }),
          };
        }
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
    ).toBe("4000");
    expect(
      params.get("subscription_data[metadata][initial_included_credit_cents]"),
    ).toBe("4000");
  });

  it("refuses subscription checkout when the Stripe price drifts from plan constants", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/prices/")) {
        return {
          ok: true,
          json: async () => ({
            id: "price_pro",
            unit_amount: 15000,
            currency: "usd",
            active: true,
            product: "prod_pro",
            recurring: { interval: "month", interval_count: 1 },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ url: "https://checkout.stripe.test/session" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSubscriptionCheckoutSession({
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
        } as never,
        customerEmail: "owner@example.com",
        successUrl: "https://camelai.dev/success",
        cancelUrl: "https://camelai.dev/cancel",
        plan: "pro",
      }),
    ).rejects.toThrow(/does not match the advertised/);

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/checkout/sessions"),
      ),
    ).toBe(false);
  });

  it.each([
    ["inactive", { active: false }],
    ["wrong currency", { currency: "eur" }],
    ["non-monthly", { recurring: { interval: "year", interval_count: 1 } }],
    ["missing product", { product: null }],
  ])("fails closed when a canonical catalog price is %s", async (_case, override) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const priceId = url.split("/prices/")[1];
        return {
          ok: true,
          json: async () => ({
            ...configuredTestPrice(priceId),
            ...(priceId === "price_pro" ? override : {}),
          }),
        };
      }),
    );

    await expect(
      loadCanonicalPaidPlanCatalog({
        ORG: {} as never,
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_STARTER_PRICE_ID: "price_starter",
        STRIPE_PRO_PRICE_ID: "price_pro",
        STRIPE_TEAM_PRICE_ID: "price_team",
      }),
    ).rejects.toThrow(/does not match the advertised/);
  });

  const paidPlanCatalog: CanonicalPaidPlanCatalogEntry[] = [
    { plan: "starter", priceId: "price_starter", productId: "prod_starter", unitAmount: 1000, currency: "usd", interval: "month", intervalCount: 1 },
    { plan: "pro", priceId: "price_pro", productId: "prod_pro", unitAmount: 4000, currency: "usd", interval: "month", intervalCount: 1 },
    { plan: "team", priceId: "price_team", productId: "prod_team", unitAmount: 5000, currency: "usd", interval: "month", intervalCount: 1 },
  ];

  it("caches immutable portal configurations by behavior and catalog fingerprint", async () => {
    const cache = new Map<string, string>();
    let configurationRequestBody: string | null = null;
    let idempotencyKey: string | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      configurationRequestBody = init?.body as string;
      idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
      return {
        ok: true,
        json: async () => ({ id: "bpc_cached_upgrade" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ORG: {} as never,
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      APP_KV: {
        get: vi.fn(async (key: string) => cache.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          cache.set(key, value);
        }),
      },
    };

    await expect(
      getOrCreateBillingPortalConfiguration(
        env as never,
        "upgrade",
        paidPlanCatalog,
      ),
    ).resolves.toBe("bpc_cached_upgrade");
    await expect(
      getOrCreateBillingPortalConfiguration(
        env as never,
        "upgrade",
        paidPlanCatalog,
      ),
    ).resolves.toBe("bpc_cached_upgrade");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(idempotencyKey).toMatch(/^camelai-billing-portal-v1:upgrade:/);
    const configurationBody = new URLSearchParams(
      configurationRequestBody ?? "",
    );
    expect(
      configurationBody.getAll(
        "features[subscription_update][default_allowed_updates][]",
      ),
    ).toEqual(["price", "quantity"]);
    expect(
      [0, 1, 2].map((index) =>
        configurationBody.get(
          `features[subscription_update][products][${index}][prices][]`,
        ),
      ),
    ).toEqual(["price_starter", "price_pro", "price_team"]);
  });

  it("reads both legacy and Dahlia invoice subscription and line shapes", () => {
    expect(
      getInvoiceSubscriptionId({
        id: "in_dahlia",
        subscription: "sub_legacy_fallback",
        parent: { subscription_details: { subscription: "sub_dahlia" } },
      }),
    ).toBe("sub_dahlia");
    expect(getInvoiceSubscriptionId({ id: "in_legacy", subscription: "sub_legacy" })).toBe(
      "sub_legacy",
    );
    expect(
      getInvoiceLinePriceId({
        price: "price_legacy_fallback",
        pricing: { price_details: { price: "price_dahlia" } },
      }),
    ).toBe("price_dahlia");
    expect(getInvoiceLinePriceId({ price: "price_legacy" })).toBe("price_legacy");
    expect(
      isStripeProrationLine({
        parent: { subscription_item_details: { proration: true } },
      }),
    ).toBe(true);
    expect(isStripeProrationLine({ proration: true })).toBe(true);
  });

  it.each([
    ["starter", 1, 1000],
    ["pro", 1, 4000],
    ["team", 3, 15000],
  ] as const)("computes exact full-cycle %s credits from the live subscription", (plan, quantity, grantCents) => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: `in_${plan}`,
        status: "paid",
        billing_reason: "subscription_cycle",
        parent: { subscription_details: { subscription: `sub_${plan}` } },
      },
      lines: [{ price: `price_${plan}`, quantity }],
      subscription: {
        id: `sub_${plan}`,
        status: "active",
        customer: "cus_123",
        items: { data: [{ id: `si_${plan}`, quantity, price: `price_${plan}` }] },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    });

    expect(resolution.command).toMatchObject({ plan, seatCount: quantity, grantCents, source: "renewal" });
  });

  it("uses signed Stripe proration lines and ignores taxes when computing plan-change credits", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_upgrade",
        status: "paid",
        billing_reason: "subscription_update",
        parent: { subscription_details: { subscription: "sub_123" } },
      },
      lines: [
        { amount: -500, quantity: 1, price: "price_starter", proration: true },
        { amount: 2000, quantity: 1, pricing: { price_details: { price: "price_pro" } }, parent: { subscription_item_details: { proration: true } } },
        { amount: 150, description: "Tax", proration: false },
      ],
      subscription: {
        id: "sub_123",
        status: "active",
        customer: "cus_123",
        items: { data: [{ id: "si_123", quantity: 1, price: "price_pro" }] },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    });

    expect(resolution.command).toMatchObject({ plan: "pro", grantCents: 1500, source: "plan_change" });
  });

  it("prorates the configured allowance override by the Stripe line fraction", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: { BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS: "8000" },
      invoice: {
        id: "in_override",
        status: "paid",
        billing_reason: "subscription_update",
        subscription: "sub_override",
      },
      lines: [
        {
          amount: 1000,
          quantity: 1,
          price: "price_pro",
          proration: true,
        },
      ],
      subscription: {
        id: "sub_override",
        status: "active",
        items: {
          data: [{ id: "si_override", quantity: 1, price: "price_pro" }],
        },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    });

    expect(resolution.command).toMatchObject({ grantCents: 2000 });
  });

  it("grants a full legacy-migration allowance only for the matching paid update", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_migration",
        status: "paid",
        billing_reason: "subscription_update",
        subscription: "sub_migration",
      },
      lines: [],
      subscription: {
        id: "sub_migration",
        status: "active",
        items: {
          data: [{ id: "si_migration", quantity: 1, price: "price_pro" }],
        },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_migration",
      customerMetadata: {
        org_id: "org_team",
        v2_mig_org: "org_team",
        v2_mig_sub: "sub_migration",
        v2_mig_plan: "pro",
        v2_mig_seats: "1",
      },
    });

    expect(resolution.command).toMatchObject({
      source: "legacy_migration",
      plan: "pro",
      grantCents: 4000,
    });
  });

  it("clamps downgrade grants to zero and fails closed on unknown proration prices", () => {
    const base: Omit<
      Parameters<typeof resolveSubscriptionInvoiceGrant>[0],
      "lines"
    > = {
      env: {},
      invoice: {
        id: "in_downgrade",
        status: "paid",
        billing_reason: "subscription_update",
        parent: { subscription_details: { subscription: "sub_123" } },
      },
      subscription: {
        id: "sub_123",
        status: "active",
        customer: "cus_123",
        items: { data: [{ id: "si_123", quantity: 1, price: "price_starter" }] },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    };
    expect(
      resolveSubscriptionInvoiceGrant({
        ...base,
        lines: [
          { amount: -4000, quantity: 1, price: "price_pro", proration: true },
          { amount: 1000, quantity: 1, price: "price_starter", proration: true },
        ],
      }).command,
    ).toMatchObject({ grantCents: 0 });
    expect(() =>
      resolveSubscriptionInvoiceGrant({
        ...base,
        lines: [{ amount: 100, quantity: 1, price: "price_unknown", proration: true }],
      }),
    ).toThrow(/unknown proration price/);
  });

  it("ignores invoices unless Stripe's canonical status is paid", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_open",
        status: "open",
        paid: true,
        billing_reason: "subscription_cycle",
        parent: { subscription_details: { subscription: "sub_123" } },
      },
      lines: [],
      subscription: { id: "sub_123", status: "active", items: { data: [] } },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    });
    expect(resolution).toEqual({ command: null, ignoredReason: "invoice_not_paid" });
  });

  it("retrieves every canonical invoice-line page before applying through the ledger", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "starter",
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });
    const fetchedLinePages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/invoices/in_process")) {
          return {
            ok: true,
            json: async () => ({
              id: "in_process",
              status: "paid",
              customer: "cus_process",
              billing_reason: "subscription_update",
              parent: {
                subscription_details: {
                  subscription: "sub_process",
                  metadata: { org_id: "org_team" },
                },
              },
            }),
          };
        }
        if (url.includes("/invoices/in_process/lines?")) {
          fetchedLinePages.push(url);
          const secondPage = url.includes("starting_after=line_debit");
          return {
            ok: true,
            json: async () =>
              secondPage
                ? {
                    data: [
                      {
                        id: "line_credit",
                        amount: 2000,
                        quantity: 1,
                        pricing: { price_details: { price: "price_pro" } },
                        parent: { subscription_item_details: { proration: true } },
                      },
                    ],
                    has_more: false,
                  }
                : {
                    data: [
                      {
                        id: "line_debit",
                        amount: -500,
                        quantity: 1,
                        price: "price_starter",
                        proration: true,
                      },
                    ],
                    has_more: true,
                  },
          };
        }
        if (url.endsWith("/subscriptions/sub_process") && !init?.body) {
          return {
            ok: true,
            json: async () => ({
              id: "sub_process",
              status: "active",
              customer: "cus_process",
              metadata: { org_id: "org_team", billing_plan: "pro" },
              items: { data: [{ id: "si_process", quantity: 1, price: "price_pro" }] },
            }),
          };
        }
        if (url.endsWith("/customers/cus_process") && !init?.body) {
          return {
            ok: true,
            json: async () => ({ id: "cus_process", metadata: { org_id: "org_team" } }),
          };
        }
        if (url.includes("/prices/") && !init?.body) {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        if (url.endsWith("/subscriptions/sub_process") && init?.body) {
          return { ok: true, json: async () => ({ id: "sub_process" }) };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      }),
    );

    await expect(
      processPaidSubscriptionInvoice(env as never, "in_process"),
    ).resolves.toMatchObject({
      status: "processed",
      grantCents: 1500,
      plan: "pro",
      source: "plan_change",
    });
    expect(fetchedLinePages).toHaveLength(2);
    expect(orgStub.applySubscriptionInvoiceGrant).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_process", grantCents: 1500 }),
      { legacyProcessed: false },
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
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        itemUpdateIdempotencyKey: "team-seat-sync:org_team:4:batch_1",
        prorationBehavior: "always_invoice",
      }),
    ).resolves.toMatchObject({ billing_seat_count: 4 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const itemUpdate = fetchMock.mock.calls[1];
    expect(String(itemUpdate[0])).toBe(
      "https://api.stripe.com/v1/subscription_items/si_team",
    );
    const itemParams = new URLSearchParams(itemUpdate[1]?.body as string);
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("always_invoice");
    expect((itemUpdate[1]?.headers as Headers).get("Idempotency-Key")).toBe(
      "team-seat-sync:org_team:4:batch_1",
    );

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
    ).toBe("20000");
    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_seat_count: 4,
    });
  });

  it("uses an explicit target count for team seat sync when provided", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 10,
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
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).resolves.toMatchObject({ billing_seat_count: 4 });

    expect(orgStub.getMemberCount).not.toHaveBeenCalled();
    expect(orgStub.getInvitations).not.toHaveBeenCalled();
    const itemParams = new URLSearchParams(
      fetchMock.mock.calls[1][1]?.body as string,
    );
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("always_invoice");
  });

  it("uses no immediate proration when a Team seat count decreases", async () => {
    const { env } = makeBillingOrgEnv({
      org: { billing_seat_count: 5 },
      memberCount: 4,
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
                  quantity: 5,
                  price: "price_team",
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

    await syncTeamSubscriptionSeatCount(env as never, "org_team", {
      targetSeatCount: 4,
    });

    const itemParams = new URLSearchParams(
      fetchMock.mock.calls[1][1]?.body as string,
    );
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("none");
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
      vi.fn(async (url: string, init?: RequestInit) => {
        const priceId = String(url).split("/prices/")[1];
        if (priceId) {
          return {
            ok: true,
            json: async () => ({
              id: priceId,
              unit_amount: CONFIGURED_TEST_PRICE_UNIT_AMOUNTS[priceId] ?? 0,
              currency: "usd",
              active: true,
              product: `prod_${priceId.replace(/^price_/, "")}`,
              recurring: { interval: "month", interval_count: 1 },
            }),
          };
        }
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
      "0",
    );
    expect(
      params.get(
        "subscription_data[metadata][subscription_included_credit_cents]",
      ),
    ).toBe("4500");
    expect(
      params.get("subscription_data[metadata][initial_included_credit_cents]"),
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
