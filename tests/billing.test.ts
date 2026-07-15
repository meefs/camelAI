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
  createBillingPortalSession,
  createSubscriptionCancellationPortalSession,
  createSubscriptionCheckoutSession,
  getBillableTeamSeatCount,
  getBillableTeamSeatCountForOrg,
  getBillingAllowanceConfig,
  getOrgBillingOverview,
  getConfiguredSubscriptionPriceId,
  getOrCreateBillingPortalConfiguration,
  getInvoiceLinePriceId,
  getInvoiceSubscriptionId,
  getStripeSubscriptionSummary,
  isBillingSetupPath,
  isOrgBillingAccessReady,
  isRecurringSubscriptionInvoice,
  isStripeSecretKeyAllowedForMode,
  isStripeProrationLine,
  loadCanonicalPaidPlanCatalog,
  parseStripePriceIdList,
  processPaidSubscriptionInvoice,
  reconcilePaidSubscriptionInvoice,
  resolveSubscriptionInvoiceGrant,
  resolveOrgBillingAccess,
  StaleTrialingSubscriptionStatusError,
  syncOrgSubscriptionFromStripe,
  createSubscriptionUpdatePortalSession,
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
    const invoiceGrants = new Map<string, {
      invoiceId: string;
      subscriptionId: string;
      customerId: string;
      billingReason: string;
      source: string;
      plan: string;
      seatCount: number;
      grantCents: number;
    }>();
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
      getSubscriptionInvoiceGrant: vi.fn(async (invoiceId: string) => {
        const command = invoiceGrants.get(invoiceId);
        return command
          ? {
              invoice_id: command.invoiceId,
              subscription_id: command.subscriptionId,
              customer_id: command.customerId,
              billing_reason: command.billingReason,
              source: command.source,
              plan: command.plan,
              seat_count: command.seatCount,
              amount_cents: command.grantCents,
              created_at: Date.now(),
            }
          : null;
      }),
      applySubscriptionInvoiceGrant: vi.fn(async (command) => {
        if (invoiceGrants.has(command.invoiceId)) {
          return {
            org,
            applied: false,
            credited: false,
            legacyProcessed: false,
            invariantError: null,
          };
        }
        invoiceGrants.set(command.invoiceId, { ...command });
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

  it("repairs a missing cached customer only after verifying Stripe ownership", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_plan: "pro",
        billing_customer_id: null,
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team")) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_verified",
            metadata: { org_id: "org_team" },
          }),
        };
      }
      if (url.endsWith("/customers/cus_verified")) {
        return {
          ok: true,
          json: async () => ({
            id: "cus_verified",
            metadata: { org_id: "org_team" },
          }),
        };
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return { ok: true, json: async () => ({ id: "bpc_management" }) };
      }
      if (url.endsWith("/billing_portal/sessions")) {
        return {
          ok: true,
          json: async () => ({ url: "https://billing.stripe.test/session" }),
        };
      }
      throw new Error(
        `Unexpected Stripe request: ${url} ${init?.method ?? "GET"}`,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createBillingPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).resolves.toBe("https://billing.stripe.test/session");

    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_customer_id: "cus_verified",
    });
    expect(org.billing_customer_id).toBe("cus_verified");
  });

  it("rejects an unverified customer when repairing a missing cached customer", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_plan: "pro",
        billing_customer_id: null,
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/subscriptions/sub_team")) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_other_org",
            metadata: { org_id: "org_team" },
          }),
        };
      }
      if (url.endsWith("/customers/cus_other_org")) {
        return {
          ok: true,
          json: async () => ({
            id: "cus_other_org",
            metadata: { org_id: "org_other" },
          }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createBillingPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).rejects.toThrow(/customer does not belong/);
    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
    expect(org.billing_customer_id).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a cross-linked subscription before creating a Portal session", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_plan: "pro",
        billing_customer_id: "cus_team",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/subscriptions/sub_team")) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_team",
            metadata: { org_id: "org_other" },
          }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createBillingPortalSession({
        env: env as never,
        org,
        customerEmail: "owner@example.com",
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).rejects.toThrow(/subscription does not belong/);
    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
          cancel_at: 1_778_342_400,
          cancel_at_period_end: true,
          trial_end: 1_776_787_200,
          items: {
            data: [
              {
                id: "si_pro",
                quantity: 1,
                price: "price_pro",
                current_period_start: 1_775_750_400,
                current_period_end: 1_778_342_400,
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "sub_123",
          status: "active",
          cancel_at: null,
          cancel_at_period_end: true,
          trial_end: null,
          items: {
            data: [
              {
                id: "si_pro",
                quantity: 1,
                price: "price_pro",
                current_period_start: 1_778_342_400,
                current_period_end: 1_781_020_800,
              },
            ],
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ORG: {} as never,
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_PRO_PRICE_ID: "price_pro",
    };
    const org = {
      id: "org_123",
      billing_subscription_id: "sub_123",
    } as never;

    await expect(getStripeSubscriptionSummary(env, org)).resolves.toMatchObject(
      {
        current_period_end_ms: 1_778_342_400_000,
        cancel_at_ms: 1_778_342_400_000,
        cancellation_date_ms: 1_778_342_400_000,
        cancel_at_period_end: true,
        is_canceling: true,
      },
    );

    await expect(getStripeSubscriptionSummary(env, org)).resolves.toMatchObject(
      {
        current_period_end_ms: 1_781_020_800_000,
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

  it.each([
    {
      label: "individual to Team",
      currentPlan: "pro",
      currentPrice: "price_pro",
      currentSeats: 1,
      targetPlan: "team",
      targetPrice: "price_team",
      targetSeats: 4,
      expectedMode: "upgrade",
    },
    {
      label: "Team to individual",
      currentPlan: "team",
      currentPrice: "price_team",
      currentSeats: 4,
      targetPlan: "pro",
      targetPrice: "price_pro",
      targetSeats: 1,
      expectedMode: "downgrade",
    },
  ] as const)(
    "creates a Stripe-hosted exact $label plan change",
    async ({
      currentPlan,
      currentPrice,
      currentSeats,
      targetPlan,
      targetPrice,
      targetSeats,
      expectedMode,
    }) => {
      const { env, org } = makeBillingOrgEnv({
        org: {
          billing_status: "active",
          billing_plan: currentPlan,
          billing_seat_count: currentSeats,
          billing_customer_id: "cus_123",
          billing_subscription_id: "sub_team",
        },
        memberCount: targetPlan === "team" ? 4 : 1,
      });
      let portalBody: string | null = null;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/prices/") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        if (
          url.endsWith("/subscriptions/sub_team") &&
          init?.method === "GET"
        ) {
          return {
            ok: true,
            json: async () => ({
              id: "sub_team",
              status: "active",
              customer: "cus_123",
              metadata: { org_id: "org_team" },
              items: {
                data: [
                  {
                    id: "si_plan",
                    quantity: currentSeats,
                    price: currentPrice,
                  },
                ],
              },
            }),
          };
        }
        if (url.endsWith("/billing_portal/configurations")) {
          return {
            ok: true,
            json: async () => ({
              id: `bpc_${expectedMode}`,
              active: true,
            }),
          };
        }
        if (url.endsWith("/billing_portal/sessions")) {
          portalBody = init?.body as string;
          return {
            ok: true,
            json: async () => ({
              url: "https://billing.stripe.test/confirm",
            }),
          };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        createSubscriptionUpdatePortalSession({
          env: env as never,
          org,
          plan: targetPlan,
          seatCount: targetSeats,
          returnUrl: "https://camelai.dev/settings/organization/billing",
        }),
      ).resolves.toBe("https://billing.stripe.test/confirm");

      const params = new URLSearchParams(portalBody ?? "");
      expect(params.get("configuration")).toBe(`bpc_${expectedMode}`);
      expect(params.get("flow_data[type]")).toBe(
        "subscription_update_confirm",
      );
      expect(
        params.get(
          "flow_data[subscription_update_confirm][subscription]",
        ),
      ).toBe("sub_team");
      expect(
        params.get(
          "flow_data[subscription_update_confirm][items][0][id]",
        ),
      ).toBe("si_plan");
      expect(
        params.get(
          "flow_data[subscription_update_confirm][items][0][price]",
        ),
      ).toBe(targetPrice);
      expect(
        params.get(
          "flow_data[subscription_update_confirm][items][0][quantity]",
        ),
      ).toBe(String(targetSeats));
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/subscriptions/sub_team") &&
            init?.method === "POST",
        ),
      ).toBe(false);
    },
  );

  it("rejects a plan change whose seat limit is below members and active invitations", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 4,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 1,
      invitations: [{ expires_at: Date.now() + 60_000 }],
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/prices/") && init?.method === "GET") {
        return {
          ok: true,
          json: async () => configuredTestPrice(url.split("/prices/")[1]),
        };
      }
      if (
        url.endsWith("/subscriptions/sub_team") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: { org_id: "org_team" },
            items: {
              data: [
                {
                  id: "si_plan",
                  quantity: 4,
                  price: "price_team",
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
      createSubscriptionUpdatePortalSession({
        env: env as never,
        org,
        plan: "pro",
        seatCount: 1,
        returnUrl: "https://camelai.dev/settings/organization/billing",
      }),
    ).rejects.toThrow(
      "The pro plan includes 1 seat, but this organization has 2 occupied seats",
    );

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/billing_portal/sessions"),
      ),
    ).toBe(false);
  });

  it("rejects an under-capacity plan change while a subscription is trialing", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "trialing",
        billing_plan: "team",
        billing_seat_count: 3,
        billing_customer_id: "cus_trial",
        billing_subscription_id: "sub_trial",
      },
      memberCount: 2,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/subscriptions/sub_trial") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_trial",
            status: "trialing",
            customer: "cus_trial",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "3",
            },
            items: {
              data: [
                { id: "si_team", quantity: 3, price: "price_team" },
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
        plan: "starter",
        seatCount: 1,
      }),
    ).rejects.toThrow(
      "The starter plan includes 1 seat, but this organization has 2 occupied seats",
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/subscriptions/sub_trial") &&
          init?.method === "POST",
      ),
    ).toBe(false);
  });

  it.each([
    {
      retiredPriceId: "price_1TS5SoGvliMKf4vHohXqB19x",
      plan: "starter",
      canonicalPriceId: "price_starter",
    },
    {
      retiredPriceId: "price_1TS5SoGvliMKf4vHmzDcxSXF",
      plan: "pro",
      canonicalPriceId: "price_pro",
    },
    {
      retiredPriceId: "price_1TRzJ5GvliMKf4vHt5P6ODiY",
      plan: "starter",
      canonicalPriceId: "price_starter",
    },
    {
      retiredPriceId: "price_1TRzJDGvliMKf4vHiCvInGpn",
      plan: "pro",
      canonicalPriceId: "price_pro",
    },
  ] as const)(
    "moves a $plan subscription on retired price $retiredPriceId to its canonical price",
    async ({ retiredPriceId, plan, canonicalPriceId }) => {
      const { env, org } = makeBillingOrgEnv({
        org: {
          billing_status: "active",
          billing_plan: plan,
          billing_seat_count: 1,
          billing_customer_id: "cus_123",
          billing_subscription_id: "sub_retired",
        },
        memberCount: 1,
      });
      let portalBody: string | null = null;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/prices/") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        if (
          url.endsWith("/subscriptions/sub_retired") &&
          init?.method === "GET"
        ) {
          return {
            ok: true,
            json: async () => ({
              id: "sub_retired",
              status: "active",
              customer: "cus_123",
              metadata: { org_id: "org_team" },
              items: {
                data: [
                  {
                    id: "si_retired",
                    quantity: 1,
                    price: retiredPriceId,
                  },
                ],
              },
            }),
          };
        }
        if (url.endsWith("/billing_portal/configurations")) {
          return {
            ok: true,
            json: async () => ({ id: "bpc_downgrade", active: true }),
          };
        }
        if (url.endsWith("/billing_portal/sessions")) {
          portalBody = init?.body as string;
          return {
            ok: true,
            json: async () => ({
              url: "https://billing.stripe.test/confirm",
            }),
          };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        createSubscriptionUpdatePortalSession({
          env: env as never,
          org,
          plan,
          returnUrl: "https://camelai.dev/settings/organization/billing",
        }),
      ).resolves.toBe("https://billing.stripe.test/confirm");

      const params = new URLSearchParams(portalBody ?? "");
      expect(params.get("configuration")).toBe("bpc_downgrade");
      expect(
        params.get(
          "flow_data[subscription_update_confirm][items][0][price]",
        ),
      ).toBe(canonicalPriceId);
      expect(
        params.get(
          "flow_data[subscription_update_confirm][items][0][quantity]",
        ),
      ).toBe("1");
    },
  );

  it("repairs a stale Team projection without decreasing Stripe capacity", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 5,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 6,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/prices/") && init?.method === "GET") {
        return {
          ok: true,
          json: async () => configuredTestPrice(url.split("/prices/")[1]),
        };
      }
      if (
        url.endsWith("/subscriptions/sub_team") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "10",
              subscription_included_credit_cents: "50000",
            },
            items: {
              data: [
                {
                  id: "si_plan",
                  quantity: 10,
                  price: "price_team",
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
      createSubscriptionUpdatePortalSession({
        env: env as never,
        org,
        plan: "team",
        seatCount: 7,
        returnUrl: "https://camelai.dev/settings/organization/team",
      }),
    ).resolves.toBeNull();

    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_plan: "team",
        billing_seat_count: 10,
        billing_subscription_id: "sub_team",
      }),
      expect.any(Number),
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/billing_portal/sessions"),
      ),
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

  it("repairs a stale Portal session that regresses paid Team capacity", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 6,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 6,
    });
    let repairBody: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/subscriptions/sub_team") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "5",
              subscription_included_credit_cents: "25000",
            },
            items: {
              data: [
                { id: "si_team", quantity: 5, price: "price_team" },
              ],
            },
          }),
        };
      }
      if (
        url.endsWith("/subscriptions/sub_team") &&
        init?.method === "POST"
      ) {
        repairBody = init.body as string;
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "6",
              subscription_included_credit_cents: "30000",
            },
            items: {
              data: [
                { id: "si_team", quantity: 6, price: "price_team" },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_team",
        status: "active",
        customer: "cus_123",
        metadata: {
          org_id: "org_team",
          billing_plan: "team",
          seat_count: "5",
        },
        items: {
          data: [{ id: "si_team", quantity: 5, price: "price_team" }],
        },
      }),
    ).resolves.toMatchObject({
      billing_plan: "team",
      billing_seat_count: 6,
    });

    const repairParams = new URLSearchParams(repairBody ?? "");
    expect(repairParams.get("items[0][price]")).toBe("price_team");
    expect(repairParams.get("items[0][quantity]")).toBe("6");
    expect(repairParams.get("proration_behavior")).toBe("none");
    expect(org).toMatchObject({
      billing_plan: "team",
      billing_seat_count: 6,
    });
    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_plan: "team",
        billing_seat_count: 6,
      }),
      expect.any(Number),
    );
  });

  it("uses live Stripe state instead of projecting an out-of-order capacity event", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 6,
        billing_customer_id: "cus_123",
        billing_subscription_id: "sub_team",
      },
      memberCount: 6,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/subscriptions/sub_team") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            customer: "cus_123",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "7",
              subscription_included_credit_cents: "35000",
            },
            items: {
              data: [
                { id: "si_team", quantity: 7, price: "price_team" },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncOrgSubscriptionFromStripe(env as never, {
        id: "sub_team",
        status: "active",
        customer: "cus_123",
        metadata: {
          org_id: "org_team",
          billing_plan: "team",
          seat_count: "5",
        },
        items: {
          data: [{ id: "si_team", quantity: 5, price: "price_team" }],
        },
      }),
    ).resolves.toMatchObject({
      billing_plan: "team",
      billing_seat_count: 7,
    });

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/subscriptions/sub_team") &&
          init?.method === "POST",
      ),
    ).toBe(false);
    expect(orgStub.syncSubscriptionBillingState).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_plan: "team",
        billing_seat_count: 7,
      }),
      expect.any(Number),
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

  it("caches one stable portal configuration per behavior", async () => {
    const cache = new Map<string, string>();
    let configurationRequestBody: string | null = null;
    let idempotencyKey: string | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/billing_portal/configurations")) {
        configurationRequestBody = init?.body as string;
        idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
        return {
          ok: true,
          json: async () => ({ id: "bpc_cached_upgrade", active: true }),
        };
      }
      if (url.endsWith("/billing_portal/configurations/bpc_cached_upgrade")) {
        return {
          ok: true,
          json: async () => ({ id: "bpc_cached_upgrade", active: true }),
        };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
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
    expect(idempotencyKey).toMatch(/^camelai-billing-portal-v4:upgrade:/);
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      "stripe_billing_portal_configuration:v4:upgrade",
      expect.stringContaining('"id":"bpc_cached_upgrade"'),
    );
    const configurationBody = new URLSearchParams(
      configurationRequestBody ?? "",
    );
    expect(
      configurationBody.getAll(
        "features[subscription_update][default_allowed_updates][]",
      ),
    ).toEqual(["price"]);
    expect(
      [0, 1, 2].map((index) =>
        configurationBody.get(
          `features[subscription_update][products][${index}][prices][]`,
        ),
      ),
    ).toEqual(["price_starter", "price_pro", "price_team"]);
    expect(
      [0, 1, 2].map((index) =>
        configurationBody.get(
          `features[subscription_update][products][${index}][adjustable_quantity][enabled]`,
        ),
      ),
    ).toEqual(["false", "false", "false"]);
  });

  it("updates the stable portal configuration when the catalog changes", async () => {
    const cache = new Map<string, string>();
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      requestUrls.push(url);
      return {
        ok: true,
        json: async () => ({ id: "bpc_stable", active: true }),
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

    await getOrCreateBillingPortalConfiguration(
      env as never,
      "upgrade",
      paidPlanCatalog,
    );
    await expect(
      getOrCreateBillingPortalConfiguration(
        env as never,
        "upgrade",
        paidPlanCatalog.map((entry) =>
          entry.plan === "team"
            ? { ...entry, priceId: "price_team_v2" }
            : entry,
        ),
      ),
    ).resolves.toBe("bpc_stable");

    expect(requestUrls).toEqual([
      "https://api.stripe.com/v1/billing_portal/configurations",
      "https://api.stripe.com/v1/billing_portal/configurations/bpc_stable",
    ]);
    expect(env.APP_KV.put).toHaveBeenLastCalledWith(
      "stripe_billing_portal_configuration:v4:upgrade",
      expect.stringContaining('"id":"bpc_stable"'),
    );
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
    ["starter", 1, "pro", 1, 1000],
    ["pro", 1, "starter", 1, 4000],
    ["team", 3, "team", 8, 15000],
  ] as const)(
    "computes exact full-cycle %s credits from the paid invoice after a later subscription change",
    (plan, quantity, livePlan, liveQuantity, grantCents) => {
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
          items: {
            data: [
              {
                id: `si_${livePlan}`,
                quantity: liveQuantity,
                price: `price_${livePlan}`,
              },
            ],
          },
        },
        catalog: paidPlanCatalog,
        orgId: "org_team",
        customerId: "cus_123",
      });

      expect(resolution.command).toMatchObject({
        plan,
        seatCount: quantity,
        grantCents,
        source: "renewal",
      });
    },
  );

  it.each([
    ["starter", 1, "pro", 1, 1000],
    ["pro", 1, "team", 5, 4000],
    ["team", 3, "team", 8, 15000],
  ] as const)(
    "processes a delayed %s renewal once without regressing the current subscription",
    async (invoicePlan, invoiceSeats, livePlan, liveSeats, grantCents) => {
      const includedCreditCents =
        livePlan === "pro" ? 4000 : 5000 * liveSeats;
      const { env, org } = makeBillingOrgEnv({
        org: {
          billing_status: "active",
          billing_plan: livePlan,
          billing_seat_count: liveSeats,
          billing_customer_id: "cus_delayed",
          billing_subscription_id: "sub_delayed",
          billing_subscription_status: "active",
          billing_credit_grant_total_cents: 0,
        },
        memberCount: liveSeats,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith(`/invoices/in_delayed_${invoicePlan}`)) {
            return {
              ok: true,
              json: async () => ({
                id: `in_delayed_${invoicePlan}`,
                status: "paid",
                customer: "cus_delayed",
                billing_reason: "subscription_cycle",
                parent: {
                  subscription_details: {
                    subscription: "sub_delayed",
                    metadata: { org_id: "org_team" },
                  },
                },
              }),
            };
          }
          if (url.includes(`/invoices/in_delayed_${invoicePlan}/lines?`)) {
            return {
              ok: true,
              json: async () => ({
                data: [
                  {
                    id: `line_${invoicePlan}`,
                    amount:
                      invoicePlan === "starter"
                        ? 1000
                        : invoicePlan === "pro"
                          ? 4000
                          : 5000 * invoiceSeats,
                    quantity: invoiceSeats,
                    pricing: {
                      price_details: { price: `price_${invoicePlan}` },
                    },
                    parent: {
                      type: "subscription_item_details",
                      subscription_item_details: {
                        proration: false,
                        subscription_item: `si_old_${invoicePlan}`,
                      },
                    },
                  },
                ],
                has_more: false,
              }),
            };
          }
          if (
            url.endsWith("/subscriptions/sub_delayed") &&
            init?.method === "GET"
          ) {
            return {
              ok: true,
              json: async () => ({
                id: "sub_delayed",
                status: "active",
                customer: "cus_delayed",
                metadata: {
                  org_id: "org_team",
                  billing_plan: livePlan,
                  seat_count: String(liveSeats),
                  subscription_included_credit_cents: String(
                    includedCreditCents,
                  ),
                },
                items: {
                  data: [
                    {
                      id: `si_live_${livePlan}`,
                      quantity: liveSeats,
                      price: `price_${livePlan}`,
                    },
                  ],
                },
              }),
            };
          }
          if (url.includes("/prices/") && init?.method === "GET") {
            return {
              ok: true,
              json: async () =>
                configuredTestPrice(url.split("/prices/")[1]),
            };
          }
          throw new Error(
            `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
          );
        }),
      );

      await expect(
        processPaidSubscriptionInvoice(
          env as never,
          `in_delayed_${invoicePlan}`,
        ),
      ).resolves.toMatchObject({
        status: "processed",
        plan: invoicePlan,
        seatCount: invoiceSeats,
        grantCents,
      });
      await expect(
        processPaidSubscriptionInvoice(
          env as never,
          `in_delayed_${invoicePlan}`,
        ),
      ).resolves.toMatchObject({ status: "duplicate", grantCents: 0 });
      expect(org).toMatchObject({
        billing_plan: livePlan,
        billing_seat_count: liveSeats,
        billing_customer_id: "cus_delayed",
        billing_subscription_id: "sub_delayed",
        billing_credit_grant_total_cents: grantCents,
      });
    },
  );

  it("processes a delayed retired Pro renewal once while keeping the live new-price state", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_customer_id: "cus_retired",
        billing_subscription_id: "sub_retired",
        billing_subscription_status: "active",
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/invoices/in_retired_pro")) {
          return {
            ok: true,
            json: async () => ({
              id: "in_retired_pro",
              status: "paid",
              customer: "cus_retired",
              billing_reason: "subscription_cycle",
              parent: {
                subscription_details: {
                  subscription: "sub_retired",
                  metadata: {
                    org_id: "org_team",
                    billing_plan: "pro",
                    seat_count: "1",
                    subscription_included_credit_cents: "3000",
                  },
                },
              },
            }),
          };
        }
        if (url.includes("/invoices/in_retired_pro/lines?")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "line_retired_pro",
                  amount: 15000,
                  quantity: 1,
                  price: "price_1TRzJDGvliMKf4vHiCvInGpn",
                  type: "subscription",
                },
              ],
              has_more: false,
            }),
          };
        }
        if (
          url.endsWith("/subscriptions/sub_retired") &&
          init?.method === "GET"
        ) {
          return {
            ok: true,
            json: async () => ({
              id: "sub_retired",
              status: "active",
              customer: "cus_retired",
              metadata: {
                org_id: "org_team",
                billing_plan: "pro",
                seat_count: "1",
                subscription_included_credit_cents: "4000",
              },
              items: {
                data: [{ id: "si_live_pro", quantity: 1, price: "price_pro" }],
              },
            }),
          };
        }
        if (url.includes("/prices/") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        throw new Error(
          `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
        );
      }),
    );

    await expect(
      processPaidSubscriptionInvoice(env as never, "in_retired_pro"),
    ).resolves.toMatchObject({
      status: "processed",
      plan: "pro",
      seatCount: 1,
      grantCents: 3000,
      source: "renewal",
    });
    await expect(
      processPaidSubscriptionInvoice(env as never, "in_retired_pro"),
    ).resolves.toMatchObject({ status: "duplicate", grantCents: 0 });
    expect(org).toMatchObject({
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_subscription_id: "sub_retired",
      billing_credit_grant_total_cents: 3000,
    });
  });

  it.each([
    [
      "test",
      "starter",
      "price_1TS5SoGvliMKf4vHohXqB19x",
      "price_starter",
      1000,
      1000,
    ],
    [
      "test",
      "pro",
      "price_1TS5SoGvliMKf4vHmzDcxSXF",
      "price_pro",
      3000,
      4000,
    ],
    [
      "live",
      "starter",
      "price_1TRzJ5GvliMKf4vHt5P6ODiY",
      "price_starter",
      1000,
      1000,
    ],
    [
      "live",
      "pro",
      "price_1TRzJDGvliMKf4vHiCvInGpn",
      "price_pro",
      3000,
      4000,
    ],
  ] as const)(
    "processes a delayed %s retired-price %s initial invoice exactly once",
    async (
      stripeMode,
      plan,
      retiredPriceId,
      replacementPriceId,
      historicalGrantCents,
      liveAllowanceCents,
    ) => {
      const invoiceId = `in_delayed_initial_${stripeMode}_${plan}`;
      const subscriptionId = `sub_delayed_initial_${stripeMode}_${plan}`;
      const customerId = `cus_delayed_initial_${stripeMode}_${plan}`;
      const { env, org, orgStub } = makeBillingOrgEnv({
        org: {
          billing_status: "active",
          billing_plan: plan,
          billing_seat_count: 1,
          billing_customer_id: customerId,
          billing_subscription_id: subscriptionId,
          billing_subscription_status: "active",
          billing_credit_grant_total_cents: 0,
        },
        memberCount: 1,
      });
      Object.assign(env, {
        STRIPE_MODE: stripeMode,
        STRIPE_SECRET_KEY:
          stripeMode === "test" ? "sk_test_delayed" : "sk_live_delayed",
      });
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith(`/invoices/${invoiceId}`)) {
          return {
            ok: true,
            json: async () => ({
              id: invoiceId,
              status: "paid",
              customer: customerId,
              billing_reason: "subscription_create",
              parent: {
                subscription_details: {
                  subscription: subscriptionId,
                  metadata: {
                    org_id: "org_team",
                    billing_plan: plan,
                    seat_count: "1",
                    subscription_included_credit_cents: String(
                      historicalGrantCents,
                    ),
                    initial_included_credit_cents: String(
                      historicalGrantCents,
                    ),
                  },
                },
              },
            }),
          };
        }
        if (url.includes(`/invoices/${invoiceId}/lines?`)) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: `line_${stripeMode}_${plan}`,
                  amount: historicalGrantCents,
                  quantity: 1,
                  price: retiredPriceId,
                  type: "subscription",
                },
              ],
              has_more: false,
            }),
          };
        }
        if (
          url.endsWith(`/subscriptions/${subscriptionId}`) &&
          init?.method === "GET"
        ) {
          return {
            ok: true,
            json: async () => ({
              id: subscriptionId,
              status: "active",
              customer: customerId,
              metadata: {
                org_id: "org_team",
                billing_plan: plan,
                seat_count: "1",
                subscription_included_credit_cents: String(
                  liveAllowanceCents,
                ),
              },
              items: {
                data: [
                  {
                    id: `si_replacement_${stripeMode}_${plan}`,
                    quantity: 1,
                    price: replacementPriceId,
                  },
                ],
              },
            }),
          };
        }
        if (url.includes("/prices/") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        throw new Error(
          `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        processPaidSubscriptionInvoice(env as never, invoiceId),
      ).resolves.toMatchObject({
        status: "processed",
        plan,
        seatCount: 1,
        grantCents: historicalGrantCents,
        source: "initial",
      });
      await expect(
        reconcilePaidSubscriptionInvoice(env as never, invoiceId),
      ).resolves.toMatchObject({
        status: "preview",
        source: "initial",
        computedGrantCents: historicalGrantCents,
        creditedGrantCents: 0,
        ledgerStatus: "recorded",
      });
      await expect(
        processPaidSubscriptionInvoice(env as never, invoiceId),
      ).resolves.toMatchObject({
        status: "duplicate",
        source: "initial",
        grantCents: 0,
      });

      await expect(
        orgStub.getSubscriptionInvoiceGrant(invoiceId),
      ).resolves.toMatchObject({
        invoice_id: invoiceId,
        subscription_id: subscriptionId,
        source: "initial",
        plan,
        seat_count: 1,
        amount_cents: historicalGrantCents,
      });
      expect(orgStub.applySubscriptionInvoiceGrant).toHaveBeenCalledTimes(1);
      expect(org).toMatchObject({
        billing_plan: plan,
        billing_seat_count: 1,
        billing_customer_id: customerId,
        billing_subscription_id: subscriptionId,
        billing_credit_grant_total_cents: historicalGrantCents,
      });
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes(`/subscriptions/${subscriptionId}`),
        ),
      ).toHaveLength(3);
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url).includes(retiredPriceId) &&
            String(url).includes("/prices/"),
        ),
      ).toBe(false);
    },
  );

  it("uses the single recurring invoice line for an initial grant and ignores one-off items", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_initial_pro",
        status: "paid",
        billing_reason: "subscription_create",
        parent: { subscription_details: { subscription: "sub_initial" } },
      },
      lines: [
        {
          id: "line_recurring_pro",
          amount: 4000,
          quantity: 1,
          price: "price_pro",
          type: "subscription",
        },
        {
          id: "line_one_off_starter_price",
          amount: 1000,
          quantity: 1,
          price: "price_starter",
          parent: {
            type: "invoice_item_details",
            invoice_item_details: {},
          },
        },
      ],
      subscription: {
        id: "sub_initial",
        status: "active",
        items: {
          data: [{ id: "si_live_team", quantity: 9, price: "price_team" }],
        },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    });

    expect(resolution.command).toMatchObject({
      plan: "pro",
      seatCount: 1,
      grantCents: 4000,
      source: "initial",
    });
  });

  it.each(["starter", "pro"] as const)(
    "rejects a fixed-allowance %s renewal billed at quantity greater than one",
    (plan) => {
      expect(() =>
        resolveSubscriptionInvoiceGrant({
          env: {},
          invoice: {
            id: `in_${plan}_quantity_two`,
            status: "paid",
            billing_reason: "subscription_cycle",
            subscription: `sub_${plan}`,
          },
          lines: [
            {
              id: `line_${plan}`,
              amount: plan === "starter" ? 2000 : 8000,
              quantity: 2,
              price: `price_${plan}`,
              type: "subscription",
            },
          ],
          subscription: { id: `sub_${plan}`, status: "active" },
          catalog: paidPlanCatalog,
          orgId: "org_team",
          customerId: "cus_123",
        }),
      ).toThrow(
        new RegExp(
          `unsupported quantity 2 for fixed-allowance ${plan}`,
        ),
      );
    },
  );

  it("fails closed when a full-cycle invoice has multiple recurring plan lines", () => {
    expect(() =>
      resolveSubscriptionInvoiceGrant({
        env: {},
        invoice: {
          id: "in_ambiguous_cycle",
          status: "paid",
          billing_reason: "subscription_cycle",
          subscription: "sub_ambiguous",
        },
        lines: [
          { quantity: 1, price: "price_starter", type: "subscription" },
          { quantity: 1, price: "price_pro", type: "subscription" },
        ],
        subscription: { id: "sub_ambiguous", status: "active" },
        catalog: paidPlanCatalog,
        orgId: "org_team",
        customerId: "cus_123",
      }),
    ).toThrow(/multiple recognized recurring plan lines/);
  });

  it("uses invoice metadata only for an explicit retired-price renewal fallback", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_legacy_cycle",
        status: "paid",
        billing_reason: "subscription_cycle",
        subscription: "sub_legacy",
        metadata: { billing_plan: "starter", seat_count: "1" },
      },
      lines: [
        {
          quantity: 1,
          price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
          type: "subscription",
        },
      ],
      subscription: {
        id: "sub_legacy",
        status: "active",
        metadata: { billing_plan: "pro", seat_count: "1" },
        items: {
          data: [{ id: "si_live_pro", quantity: 1, price: "price_pro" }],
        },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_123",
    });

    expect(resolution.command).toMatchObject({
      plan: "starter",
      seatCount: 1,
      grantCents: 1000,
      source: "renewal",
    });
  });

  it.each([
    ["price_1TS5SoGvliMKf4vHohXqB19x", "starter", 1000],
    ["price_1TS5SoGvliMKf4vHmzDcxSXF", "pro", 3000],
    ["price_1TRzJ5GvliMKf4vHt5P6ODiY", "starter", 1000],
    ["price_1TRzJDGvliMKf4vHiCvInGpn", "pro", 3000],
  ] as const)(
    "recognizes retired pricing-rollout renewal %s",
    (priceId, plan, grantCents) => {
      const resolution = resolveSubscriptionInvoiceGrant({
        env: {},
        invoice: {
          id: `in_retired_${plan}`,
          status: "paid",
          billing_reason: "subscription_cycle",
          subscription: "sub_retired",
          parent: {
            subscription_details: {
              subscription: "sub_retired",
              metadata: {
                billing_plan: plan,
                seat_count: "1",
                subscription_included_credit_cents: String(grantCents),
              },
            },
          },
        },
        lines: [{ quantity: 1, price: priceId, type: "subscription" }],
        subscription: {
          id: "sub_retired",
          status: "active",
          metadata: {
            billing_plan: plan === "pro" ? "starter" : "pro",
          },
          items: {
            data: [
              {
                id: "si_live",
                quantity: 1,
                price: plan === "pro" ? "price_pro" : "price_starter",
              },
            ],
          },
        },
        catalog: paidPlanCatalog,
        orgId: "org_team",
        customerId: "cus_123",
      });

      expect(resolution.command).toMatchObject({
        plan,
        seatCount: 1,
        grantCents,
        source: "renewal",
      });
    },
  );

  it("fails closed when retired renewal metadata conflicts with its historical allowance", () => {
    expect(() =>
      resolveSubscriptionInvoiceGrant({
        env: {},
        invoice: {
          id: "in_retired_conflict",
          status: "paid",
          billing_reason: "subscription_cycle",
          subscription: "sub_retired",
          metadata: {
            billing_plan: "pro",
            seat_count: "1",
            subscription_included_credit_cents: "4000",
          },
        },
        lines: [
          {
            quantity: 1,
            price: "price_1TRzJDGvliMKf4vHiCvInGpn",
            type: "subscription",
          },
        ],
        subscription: { id: "sub_retired", status: "active" },
        catalog: paidPlanCatalog,
        orgId: "org_team",
        customerId: "cus_123",
      }),
    ).toThrow(/conflicting retired price credit metadata/);
  });

  it("fails closed when retired initial-invoice metadata conflicts with its historical allowance", () => {
    expect(() =>
      resolveSubscriptionInvoiceGrant({
        env: {},
        invoice: {
          id: "in_retired_initial_conflict",
          status: "paid",
          billing_reason: "subscription_create",
          subscription: "sub_retired_initial",
          metadata: {
            billing_plan: "pro",
            seat_count: "1",
            subscription_included_credit_cents: "3000",
            initial_included_credit_cents: "4000",
          },
        },
        lines: [
          {
            quantity: 1,
            price: "price_1TRzJDGvliMKf4vHiCvInGpn",
            type: "subscription",
          },
        ],
        subscription: {
          id: "sub_retired_initial",
          status: "active",
          items: {
            data: [{ id: "si_live_pro", quantity: 1, price: "price_pro" }],
          },
        },
        catalog: paidPlanCatalog,
        orgId: "org_team",
        customerId: "cus_123",
      }),
    ).toThrow(/conflicting retired price initial credit metadata/);
  });

  it("does not use mutable live metadata for a retired-price renewal", () => {
    expect(() =>
      resolveSubscriptionInvoiceGrant({
        env: {},
        invoice: {
          id: "in_legacy_without_invoice_metadata",
          status: "paid",
          billing_reason: "subscription_cycle",
          subscription: "sub_legacy",
        },
        lines: [
          {
            quantity: 1,
            price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
            type: "subscription",
          },
        ],
        subscription: {
          id: "sub_legacy",
          status: "active",
          metadata: { billing_plan: "pro", seat_count: "1" },
          items: {
            data: [{ id: "si_live_pro", quantity: 1, price: "price_pro" }],
          },
        },
        catalog: paidPlanCatalog,
        orgId: "org_team",
        customerId: "cus_123",
      }),
    ).toThrow(/has no recognized plan/);
  });

  it("grants only the paid incremental Team-seat allowance", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_team_seat_increase",
        status: "paid",
        billing_reason: "subscription_update",
        parent: { subscription_details: { subscription: "sub_team" } },
      },
      lines: [
        {
          amount: -7500,
          quantity: 3,
          price: "price_team",
          proration: true,
        },
        {
          amount: 10000,
          quantity: 4,
          price: "price_team",
          proration: true,
        },
      ],
      subscription: {
        id: "sub_team",
        status: "active",
        customer: "cus_team",
        items: {
          data: [{ id: "si_team", quantity: 4, price: "price_team" }],
        },
      },
      catalog: paidPlanCatalog,
      orgId: "org_team",
      customerId: "cus_team",
    });

    expect(resolution.command).toMatchObject({
      plan: "team",
      seatCount: 4,
      grantCents: 2500,
      source: "plan_change",
    });
  });

  it("applies a paid Team-seat increase invoice exactly once", async () => {
    const { env, org } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 4,
        billing_customer_id: "cus_team",
        billing_subscription_id: "sub_team",
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 4,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/invoices/in_team_seat_paid")) {
          return {
            ok: true,
            json: async () => ({
              id: "in_team_seat_paid",
              status: "paid",
              customer: "cus_team",
              billing_reason: "subscription_update",
              parent: {
                subscription_details: {
                  subscription: "sub_team",
                  metadata: { org_id: "org_team" },
                },
              },
            }),
          };
        }
        if (url.includes("/invoices/in_team_seat_paid/lines?")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "line_old_seats",
                  amount: -7500,
                  quantity: 3,
                  price: "price_team",
                  proration: true,
                },
                {
                  id: "line_new_seats",
                  amount: 10000,
                  quantity: 4,
                  price: "price_team",
                  proration: true,
                },
              ],
              has_more: false,
            }),
          };
        }
        if (url.endsWith("/subscriptions/sub_team") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => ({
              id: "sub_team",
              status: "active",
              customer: "cus_team",
              metadata: {
                org_id: "org_team",
                billing_plan: "team",
                seat_count: "4",
                subscription_included_credit_cents: "20000",
              },
              items: {
                data: [{ id: "si_team", quantity: 4, price: "price_team" }],
              },
            }),
          };
        }
        if (url.endsWith("/customers/cus_team") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => ({
              id: "cus_team",
              metadata: { org_id: "org_team" },
            }),
          };
        }
        if (url.includes("/prices/") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => configuredTestPrice(url.split("/prices/")[1]),
          };
        }
        throw new Error(
          `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
        );
      }),
    );

    await expect(
      processPaidSubscriptionInvoice(env as never, "in_team_seat_paid"),
    ).resolves.toMatchObject({
      status: "processed",
      plan: "team",
      seatCount: 4,
      grantCents: 2500,
    });
    await expect(
      processPaidSubscriptionInvoice(env as never, "in_team_seat_paid"),
    ).resolves.toMatchObject({ status: "duplicate", grantCents: 0 });
    expect(org).toMatchObject({
      billing_plan: "team",
      billing_seat_count: 4,
      billing_credit_grant_total_cents: 2500,
    });
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

  it("treats a later update as a normal plan change after migration metadata cleanup", () => {
    const resolution = resolveSubscriptionInvoiceGrant({
      env: {},
      invoice: {
        id: "in_after_migration_cleanup",
        status: "paid",
        billing_reason: "subscription_update",
        subscription: "sub_migration",
      },
      lines: [
        {
          amount: -500,
          quantity: 1,
          price: "price_starter",
          proration: true,
        },
        {
          amount: 2000,
          quantity: 1,
          price: "price_pro",
          proration: true,
        },
      ],
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
      customerMetadata: { org_id: "org_team" },
    });

    expect(resolution.command).toMatchObject({
      source: "plan_change",
      plan: "pro",
      seatCount: 1,
      grantCents: 1500,
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

  it("replays a recorded legacy-migration invoice after its mutable metadata is cleared", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_customer_id: "cus_migration_replay",
        billing_subscription_id: "sub_migration_replay",
        billing_credit_grant_total_cents: 0,
      },
      memberCount: 1,
    });
    let kvMarker = false;
    const kv = {
      get: vi.fn(async () => (kvMarker ? "1" : null)),
      put: vi.fn(async () => {
        kvMarker = true;
      }),
    };
    Object.assign(env, { APP_KV: kv });
    let migrationMetadataCleared = false;
    let customerMetadataClearCount = 0;
    let priceFetchCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/invoices/in_migration_replay")) {
        return {
          ok: true,
          json: async () => ({
            id: "in_migration_replay",
            status: "paid",
            customer: "cus_migration_replay",
            billing_reason: "subscription_update",
            parent: {
              subscription_details: {
                subscription: "sub_migration_replay",
                metadata: { org_id: "org_team" },
              },
            },
          }),
        };
      }
      if (url.includes("/invoices/in_migration_replay/lines?")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "line_retired_debit",
                amount: -500,
                quantity: 1,
                price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
                proration: true,
              },
              {
                id: "line_new_pro_credit",
                amount: 1000,
                quantity: 1,
                price: "price_pro",
                proration: true,
              },
            ],
            has_more: false,
          }),
        };
      }
      if (
        url.endsWith("/subscriptions/sub_migration_replay") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_migration_replay",
            status: "active",
            customer: "cus_migration_replay",
            metadata: {
              org_id: "org_team",
              billing_plan: "pro",
              seat_count: "1",
              subscription_included_credit_cents: "4000",
            },
            items: {
              data: [{ id: "si_pro", quantity: 1, price: "price_pro" }],
            },
          }),
        };
      }
      if (
        url.endsWith("/customers/cus_migration_replay") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({
            id: "cus_migration_replay",
            metadata: migrationMetadataCleared
              ? { org_id: "org_team" }
              : {
                  org_id: "org_team",
                  v2_mig_org: "org_team",
                  v2_mig_sub: "sub_migration_replay",
                  v2_mig_plan: "pro",
                  v2_mig_seats: "1",
                  v2_mig_credits: "4000",
                  v2_mig_price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
                },
          }),
        };
      }
      if (
        url.endsWith("/customers/cus_migration_replay") &&
        init?.method === "POST"
      ) {
        customerMetadataClearCount += 1;
        migrationMetadataCleared = true;
        return {
          ok: true,
          json: async () => ({
            id: "cus_migration_replay",
            metadata: { org_id: "org_team" },
          }),
        };
      }
      if (url.includes("/prices/") && init?.method === "GET") {
        priceFetchCount += 1;
        return {
          ok: true,
          json: async () => configuredTestPrice(url.split("/prices/")[1]),
        };
      }
      throw new Error(
        `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      processPaidSubscriptionInvoice(env as never, "in_migration_replay"),
    ).resolves.toMatchObject({
      status: "processed",
      source: "legacy_migration",
      grantCents: 4000,
    });
    expect(migrationMetadataCleared).toBe(true);

    await expect(
      processPaidSubscriptionInvoice(env as never, "in_migration_replay"),
    ).resolves.toMatchObject({
      status: "duplicate",
      source: "legacy_migration",
      grantCents: 0,
    });
    await expect(
      reconcilePaidSubscriptionInvoice(env as never, "in_migration_replay"),
    ).resolves.toMatchObject({
      status: "preview",
      source: "legacy_migration",
      computedGrantCents: 4000,
      creditedGrantCents: 0,
      ledgerStatus: "recorded",
    });

    expect(org.billing_credit_grant_total_cents).toBe(4000);
    expect(orgStub.applySubscriptionInvoiceGrant).toHaveBeenCalledTimes(1);
    expect(customerMetadataClearCount).toBe(2);
    expect(priceFetchCount).toBe(3);
  });

  it("previews an eligible paid invoice without mutating Stripe, OrgDO, KV, or the ledger", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_status: "active",
        billing_plan: "team",
        billing_seat_count: 5,
        billing_customer_id: "cus_preview",
        billing_subscription_id: "sub_preview",
        billing_credit_grant_total_cents: 700,
      },
      memberCount: 5,
    });
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    Object.assign(env, { APP_KV: kv });
    const before = structuredClone(org);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/invoices/in_preview")) {
        return {
          ok: true,
          json: async () => ({
            id: "in_preview",
            status: "paid",
            customer: "cus_preview",
            billing_reason: "subscription_cycle",
            parent: {
              subscription_details: {
                subscription: "sub_preview",
                metadata: { org_id: "org_team", billing_plan: "starter" },
              },
            },
          }),
        };
      }
      if (url.includes("/invoices/in_preview/lines?")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "line_starter_cycle",
                amount: 1000,
                quantity: 1,
                pricing: { price_details: { price: "price_starter" } },
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: {
                    proration: false,
                    subscription_item: "si_old_starter",
                  },
                },
              },
            ],
            has_more: false,
          }),
        };
      }
      if (url.endsWith("/subscriptions/sub_preview")) {
        return {
          ok: true,
          json: async () => ({
            id: "sub_preview",
            status: "active",
            customer: "cus_preview",
            metadata: {
              org_id: "org_team",
              billing_plan: "starter",
              seat_count: "1",
              subscription_included_credit_cents: "1000",
            },
            items: {
              data: [{ id: "si_live_pro", quantity: 1, price: "price_pro" }],
            },
          }),
        };
      }
      if (url.includes("/prices/")) {
        return {
          ok: true,
          json: async () => configuredTestPrice(url.split("/prices/")[1]),
        };
      }
      throw new Error(
        `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcilePaidSubscriptionInvoice(env as never, "in_preview"),
    ).resolves.toMatchObject({
      status: "preview",
      plan: "starter",
      seatCount: 1,
      computedGrantCents: 1000,
      creditedGrantCents: 1000,
      ledgerStatus: "not_recorded",
    });

    expect(
      fetchMock.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
    expect(org).toEqual(before);
    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
    expect(orgStub.syncSubscriptionBillingState).not.toHaveBeenCalled();
    expect(orgStub.applySubscriptionInvoiceGrant).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
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
