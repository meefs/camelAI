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
  createSubscriptionCancellationPortalSession,
  createSubscriptionCheckoutSession,
  ensureTeamSubscriptionSeatCapacity,
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
  previewLegacyStripeMigration,
  reconcilePaidSubscriptionInvoice,
  resolveSubscriptionInvoiceGrant,
  resolveOrgBillingAccess,
  StaleTrialingSubscriptionStatusError,
  syncTeamSubscriptionSeatCount,
  syncOrgSubscriptionFromStripe,
  updateActiveStripeSubscriptionPlan,
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
    let teamSeatMutationRevision = 0;
    let teamSeatMutationOwner: {
      operationId: string;
      subscriptionId: string;
      revision: number;
      mode: "exact" | "ensure_at_least";
      confirmedTargetSeatCount: number | null;
    } | null = null;
    let confirmedTeamSeatFloor = normalizeSeatCount(
      "team",
      org.billing_seat_count,
    );
    const teamSeatReservations = new Map<
      string,
      { seatCount: number; baseSeatCount: number; reservedSeatDelta: number }
    >();
    const upsertTeamSeatReservation = (input: {
      operationId: string;
      requestedSeatCount?: number;
      reservedSeatDelta?: number;
    }) => {
      const seatCount = normalizeSeatCount("team", input.requestedSeatCount);
      const reservedSeatDelta = Number.isFinite(input.reservedSeatDelta)
        ? Math.max(0, Math.floor(input.reservedSeatDelta ?? 0))
        : 0;
      const baseSeatCount = normalizeSeatCount(
        "team",
        seatCount - reservedSeatDelta,
      );
      const existing = teamSeatReservations.get(input.operationId);
      teamSeatReservations.set(input.operationId, {
        seatCount: Math.max(existing?.seatCount ?? 3, seatCount),
        baseSeatCount: Math.max(existing?.baseSeatCount ?? 3, baseSeatCount),
        reservedSeatDelta: Math.max(
          existing?.reservedSeatDelta ?? 0,
          reservedSeatDelta,
        ),
      });
    };
    const requiredTeamSeatFloor = (mode: "exact" | "ensure_at_least") => {
      const reservations = [...teamSeatReservations.values()];
      const additive = reservations.filter(
        (reservation) => reservation.reservedSeatDelta > 0,
      );
      const additiveFloor = additive.length
        ? Math.max(...additive.map((reservation) => reservation.baseSeatCount)) +
          additive.reduce(
            (total, reservation) => total + reservation.reservedSeatDelta,
            0,
          )
        : 3;
      return Math.max(
        mode === "ensure_at_least" ? confirmedTeamSeatFloor : 3,
        3,
        additiveFloor,
        ...reservations.map((reservation) => reservation.seatCount),
      );
    };
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
      acquireTeamSeatMutation: vi.fn(async (input) => {
        if (input.mode === "ensure_at_least") {
          upsertTeamSeatReservation(input);
        }
        if (
          teamSeatMutationOwner &&
          teamSeatMutationOwner.operationId !== input.operationId
        ) {
          return {
            status: "busy" as const,
            requiredSeatFloor: requiredTeamSeatFloor(input.mode),
            retryAfterMs: 10,
          };
        }
        if (!teamSeatMutationOwner) {
          teamSeatMutationRevision += 1;
          teamSeatMutationOwner = {
            operationId: input.operationId,
            subscriptionId: input.subscriptionId,
            revision: teamSeatMutationRevision,
            mode: input.mode,
            confirmedTargetSeatCount: null,
          };
        }
        return {
          status: "acquired" as const,
          revision: teamSeatMutationOwner.revision,
          requiredSeatFloor: requiredTeamSeatFloor(input.mode),
          leaseExpiresAt: Date.now() + 300_000,
        };
      }),
      refreshTeamSeatMutation: vi.fn(async (input) => {
        const owner = teamSeatMutationOwner;
        if (
          !owner ||
          owner.operationId !== input.operationId ||
          owner.subscriptionId !== input.subscriptionId ||
          owner.revision !== input.revision
        ) {
          return { status: "lost" as const };
        }
        if (
          owner.mode === "ensure_at_least" &&
          input.requestedSeatCount !== undefined
        ) {
          upsertTeamSeatReservation(input);
        }
        const requiredSeatFloor = requiredTeamSeatFloor(owner.mode);
        if (
          input.targetSeatCount !== undefined &&
          normalizeSeatCount("team", input.targetSeatCount) <
            requiredSeatFloor
        ) {
          return {
            status: "target_too_low" as const,
            requiredSeatFloor,
            confirmedTargetSeatCount: owner.confirmedTargetSeatCount,
            leaseExpiresAt: Date.now() + 300_000,
          };
        }
        if (
          input.targetSeatCount !== undefined &&
          owner.confirmedTargetSeatCount !==
            normalizeSeatCount("team", input.targetSeatCount)
        ) {
          return { status: "lost" as const };
        }
        return {
          status: "active" as const,
          requiredSeatFloor,
          confirmedTargetSeatCount: owner.confirmedTargetSeatCount,
          leaseExpiresAt: Date.now() + 300_000,
        };
      }),
      confirmTeamSeatMutationTarget: vi.fn(async (input) => {
        const owner = teamSeatMutationOwner;
        if (
          !owner ||
          owner.operationId !== input.operationId ||
          owner.subscriptionId !== input.subscriptionId ||
          owner.revision !== input.revision
        ) {
          return { status: "lost" as const };
        }
        const requiredSeatFloor = requiredTeamSeatFloor(owner.mode);
        const targetSeatCount = normalizeSeatCount(
          "team",
          input.targetSeatCount,
        );
        if (targetSeatCount < requiredSeatFloor) {
          return {
            status: "target_too_low" as const,
            requiredSeatFloor,
            confirmedTargetSeatCount: owner.confirmedTargetSeatCount,
            leaseExpiresAt: Date.now() + 300_000,
          };
        }
        owner.confirmedTargetSeatCount = targetSeatCount;
        return {
          status: "active" as const,
          requiredSeatFloor,
          confirmedTargetSeatCount: targetSeatCount,
          leaseExpiresAt: Date.now() + 300_000,
        };
      }),
      completeTeamSeatMutation: vi.fn(async (input) => {
        const owner = teamSeatMutationOwner;
        if (
          !owner ||
          owner.operationId !== input.operationId ||
          owner.subscriptionId !== input.subscriptionId ||
          owner.revision !== input.revision
        ) {
          return { status: "lost" as const };
        }
        const targetSeatCount = normalizeSeatCount(
          "team",
          input.targetSeatCount,
        );
        const requiredSeatFloor = requiredTeamSeatFloor(owner.mode);
        if (
          targetSeatCount < requiredSeatFloor ||
          owner.confirmedTargetSeatCount !== targetSeatCount
        ) {
          return {
            status: "target_too_low" as const,
            requiredSeatFloor,
          };
        }
        confirmedTeamSeatFloor = targetSeatCount;
        if (
          (teamSeatReservations.get(input.operationId)?.reservedSeatDelta ??
            0) === 0
        ) {
          teamSeatReservations.delete(input.operationId);
        }
        teamSeatMutationOwner = null;
        return { status: "completed" as const };
      }),
      releaseTeamSeatMutationReservation: vi.fn(async (input) =>
        teamSeatReservations.delete(input.operationId),
      ),
      abortTeamSeatMutation: vi.fn(async (input) => {
        teamSeatReservations.delete(input.operationId);
        const owner = teamSeatMutationOwner;
        if (
          owner !== null &&
          owner.operationId === input.operationId &&
          owner.revision === input.revision
        ) {
          teamSeatMutationOwner = null;
          return true;
        }
        return false;
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

  it("previews a legacy migration before applying the locked Stripe update", async () => {
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
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      previewLegacyStripeMigration({
        env: env as never,
        org,
        userEmail: "owner@example.com",
        plan: "pro",
      }),
    ).resolves.toMatchObject({
      amountDueTodayCents: 996,
      currency: "usd",
      includedCreditCents: 4000,
      legacyCreditCents: 3004,
      monthlyPriceCents: 4000,
      newPlanProrationCents: 4000,
      plan: "pro",
      seatCount: 1,
    });
    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/billing_portal/"),
      ),
    ).toBe(false);
  });

  it("previews the exact server-owned Team quantity for legacy migrations", async () => {
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
      if (url.includes("/invoices/create_preview?")) {
        return {
          ok: true,
          json: async () => ({ amount_due: 0, total: 0, lines: { data: [] } }),
        };
      }
      if (url.includes("/prices/")) {
        return { ok: true, json: async () => configuredTestPrice(url.split("/prices/")[1]) };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(previewLegacyStripeMigration({
      env: env as never,
      org,
      userEmail: "owner@example.com",
      plan: "team",
    })).resolves.toMatchObject({ plan: "team", seatCount: 5 });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/billing_portal/"),
      ),
    ).toBe(false);
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
      prorationBehavior: "always_invoice",
      paymentBehavior: "error_if_incomplete",
    },
    {
      label: "Team to individual",
      currentPlan: "team",
      currentPrice: "price_team",
      currentSeats: 4,
      targetPlan: "pro",
      targetPrice: "price_pro",
      targetSeats: 1,
      prorationBehavior: "none",
      paymentBehavior: null,
    },
  ] as const)(
    "applies a locked $label plan change without a customer quantity editor",
    async ({
      currentPlan,
      currentPrice,
      currentSeats,
      targetPlan,
      targetPrice,
      targetSeats,
      prorationBehavior,
      paymentBehavior,
    }) => {
      const { env, org, orgStub } = makeBillingOrgEnv({
        org: {
          billing_status: "active",
          billing_plan: currentPlan,
          billing_seat_count: currentSeats,
          billing_customer_id: "cus_123",
          billing_subscription_id: "sub_team",
        },
        memberCount: 4,
      });
      let updateBody: string | null = null;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/prices/") && init?.method === "GET") {
          return {
            ok: true,
            json: async () =>
              configuredTestPrice(url.split("/prices/")[1]),
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
                billing_plan: currentPlan,
                seat_count: String(currentSeats),
              },
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
        if (
          url.endsWith("/subscriptions/sub_team") &&
          init?.method === "POST"
        ) {
          updateBody = init.body as string;
          return {
            ok: true,
            json: async () => ({
              id: "sub_team",
              status: "active",
              customer: "cus_123",
              metadata: {
                org_id: "org_team",
                billing_plan: targetPlan,
                seat_count: String(targetSeats),
                subscription_included_credit_cents: String(
                  targetPlan === "team" ? targetSeats * 5000 : 4000,
                ),
              },
              items: {
                data: [
                  {
                    id: "si_plan",
                    quantity: targetSeats,
                    price: targetPrice,
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
        updateActiveStripeSubscriptionPlan({
          env: env as never,
          org,
          plan: targetPlan,
        }),
      ).resolves.toMatchObject({
        billing_plan: targetPlan,
        billing_seat_count: targetSeats,
      });

      const params = new URLSearchParams(updateBody ?? "");
      expect(params.get("items[0][id]")).toBe("si_plan");
      expect(params.get("items[0][price]")).toBe(targetPrice);
      expect(params.get("items[0][quantity]")).toBe(String(targetSeats));
      expect(params.get("proration_behavior")).toBe(prorationBehavior);
      expect(params.get("payment_behavior")).toBe(paymentBehavior);
      expect(orgStub.acquireTeamSeatMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: "sub_team",
          mode: "exact",
        }),
      );
      expect(
        orgStub.acquireTeamSeatMutation.mock.invocationCallOrder[0],
      ).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
      expect(orgStub.abortTeamSeatMutation).toHaveBeenCalledTimes(1);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/billing_portal/"),
        ),
      ).toBe(false);
    },
  );

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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(idempotencyKey).toMatch(/^camelai-billing-portal-v3:upgrade:/);
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

  it("reactivates an idempotently replayed portal configuration before caching it", async () => {
    const cache = new Map<string, string>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/billing_portal/configurations")) {
        return {
          ok: true,
          json: async () => ({ id: "bpc_inactive", active: true }),
        };
      }
      if (
        url.endsWith("/billing_portal/configurations/bpc_inactive") &&
        init?.method === "GET"
      ) {
        return {
          ok: true,
          json: async () => ({ id: "bpc_inactive", active: false }),
        };
      }
      if (
        url.endsWith("/billing_portal/configurations/bpc_inactive") &&
        init?.method === "POST"
      ) {
        expect(new URLSearchParams(init?.body as string).get("active")).toBe(
          "true",
        );
        expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
        return {
          ok: true,
          json: async () => ({ id: "bpc_inactive", active: true }),
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
    ).resolves.toBe("bpc_inactive");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^stripe_billing_portal_configuration:upgrade:/),
      "bpc_inactive",
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
      if (url.includes("/subscription_items/")) {
        const params = new URLSearchParams(init?.body as string);
        return {
          ok: true,
          json: async () => ({
            id: "si_team",
            quantity: Number(params.get("quantity")),
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ id: "sub_team" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        itemUpdateIdempotencyKey: "team-seat-sync:org_team:4:batch_1",
        prorationBehavior: "always_invoice",
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      targetSeatCount: 4,
      stripeQuantityChanged: true,
      paidIncreaseConfirmed: true,
      metadataSynced: true,
      orgSeatStateSynced: true,
      pendingBillingSeatAllowance: 0,
      org: { billing_seat_count: 4 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const itemUpdate = fetchMock.mock.calls[1];
    expect(String(itemUpdate[0])).toBe(
      "https://api.stripe.com/v1/subscription_items/si_team",
    );
    const itemParams = new URLSearchParams(itemUpdate[1]?.body as string);
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("always_invoice");
    expect(itemParams.get("payment_behavior")).toBe("error_if_incomplete");
    expect((itemUpdate[1]?.headers as Headers).get("Idempotency-Key")).toBe(
      "team-seat-sync:org_team:4:batch_1:revision:1:target:4",
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
      memberCount: 4,
      invitations: [],
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
      if (url.includes("/subscription_items/")) {
        const params = new URLSearchParams(init?.body as string);
        return {
          ok: true,
          json: async () => ({
            id: "si_team",
            quantity: Number(params.get("quantity")),
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ id: "sub_team" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      targetSeatCount: 4,
      org: { billing_seat_count: 4 },
    });

    expect(orgStub.getMemberCount).toHaveBeenCalled();
    expect(orgStub.getInvitations).toHaveBeenCalled();
    const itemParams = new URLSearchParams(
      fetchMock.mock.calls[1][1]?.body as string,
    );
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("always_invoice");
    expect(itemParams.get("payment_behavior")).toBe("error_if_incomplete");
  });

  it("does not commit Team seats or credits when the immediate charge fails", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: {
        billing_seat_count: 3,
        billing_credit_grant_total_cents: 900,
      },
      memberCount: 4,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "GET") {
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
      if (url.endsWith("/subscription_items/si_team")) {
        return {
          ok: false,
          status: 402,
          text: async () => "The card was declined.",
        };
      }
      throw new Error(
        `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).rejects.toThrow(/returned 402/);

    const itemUpdate = fetchMock.mock.calls[1];
    const itemParams = new URLSearchParams(itemUpdate[1]?.body as string);
    expect(itemParams.get("quantity")).toBe("4");
    expect(itemParams.get("proration_behavior")).toBe("always_invoice");
    expect(itemParams.get("payment_behavior")).toBe("error_if_incomplete");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(orgStub.updateBillingState).not.toHaveBeenCalled();
    expect(org).toMatchObject({
      billing_seat_count: 3,
      billing_credit_grant_total_cents: 900,
    });
  });

  it("preserves confirmed Team capacity and retries metadata without another charge", async () => {
    const { env, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 4,
    });
    let stripeSeatCount = 3;
    let metadataSeatCount = 3;
    let itemUpdateCount = 0;
    let metadataUpdateCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: String(metadataSeatCount),
              subscription_included_credit_cents: String(
                metadataSeatCount * 5000,
              ),
            },
            items: {
              data: [
                {
                  id: "si_team",
                  quantity: stripeSeatCount,
                  price: "price_team",
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/subscription_items/si_team")) {
        itemUpdateCount += 1;
        stripeSeatCount = Number(
          new URLSearchParams(init?.body as string).get("quantity"),
        );
        return {
          ok: true,
          json: async () => ({ id: "si_team", quantity: stripeSeatCount }),
        };
      }
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "POST") {
        metadataUpdateCount += 1;
        if (metadataUpdateCount === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => "temporary metadata failure",
          };
        }
        metadataSeatCount = Number(
          new URLSearchParams(init.body as string).get("metadata[seat_count]"),
        );
        return { ok: true, json: async () => ({ id: "sub_team" }) };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      stripeQuantityChanged: true,
      paidIncreaseConfirmed: true,
      metadataSynced: false,
      orgSeatStateSynced: true,
      pendingBillingSeatAllowance: 0,
    });
    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      stripeQuantityChanged: false,
      paidIncreaseConfirmed: false,
      metadataSynced: true,
      orgSeatStateSynced: true,
    });

    expect(itemUpdateCount).toBe(1);
    expect(metadataUpdateCount).toBe(2);
    expect(orgStub.updateBillingState).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("uses confirmed Stripe capacity while retrying a failed Org seat repair", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 4,
    });
    orgStub.updateBillingState.mockRejectedValueOnce(
      new Error("temporary OrgDO failure"),
    );
    let stripeSeatCount = 3;
    let metadataSeatCount = 3;
    let itemUpdateCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/subscriptions/sub_team") && init?.method === "GET") {
          return {
            ok: true,
            json: async () => ({
              id: "sub_team",
              status: "active",
              metadata: {
                org_id: "org_team",
                billing_plan: "team",
                seat_count: String(metadataSeatCount),
                subscription_included_credit_cents: String(
                  metadataSeatCount * 5000,
                ),
              },
              items: {
                data: [
                  {
                    id: "si_team",
                    quantity: stripeSeatCount,
                    price: "price_team",
                  },
                ],
              },
            }),
          };
        }
        if (url.endsWith("/subscription_items/si_team")) {
          itemUpdateCount += 1;
          stripeSeatCount = Number(
            new URLSearchParams(init?.body as string).get("quantity"),
          );
          return {
            ok: true,
            json: async () => ({ id: "si_team", quantity: stripeSeatCount }),
          };
        }
        if (
          url.endsWith("/subscriptions/sub_team") &&
          init?.method === "POST"
        ) {
          metadataSeatCount = Number(
            new URLSearchParams(init.body as string).get(
              "metadata[seat_count]",
            ),
          );
          return { ok: true, json: async () => ({ id: "sub_team" }) };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      stripeQuantityChanged: true,
      paidIncreaseConfirmed: true,
      orgSeatStateSynced: false,
      pendingBillingSeatAllowance: 1,
      org: { billing_seat_count: 3 },
    });
    await expect(
      syncTeamSubscriptionSeatCount(env as never, "org_team", {
        targetSeatCount: 4,
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      stripeQuantityChanged: false,
      orgSeatStateSynced: true,
      pendingBillingSeatAllowance: 0,
      org: { billing_seat_count: 4 },
    });

    expect(itemUpdateCount).toBe(1);
    expect(orgStub.updateBillingState).toHaveBeenCalledTimes(2);
    expect(org.billing_seat_count).toBe(4);
    consoleError.mockRestore();
  });

  it("ensures Team capacity without lowering a larger confirmed Stripe quantity", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 4 },
      memberCount: 4,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: "4",
              subscription_included_credit_cents: "20000",
            },
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
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "POST") {
        return { ok: true, json: async () => ({ id: "sub_team" }) };
      }
      throw new Error(
        `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureTeamSubscriptionSeatCapacity(env as never, "org_team", {
        targetSeatCount: 4,
        prorationBehavior: "always_invoice",
      }),
    ).resolves.toMatchObject({
      status: "capacity_confirmed",
      requestedSeatCount: 4,
      targetSeatCount: 5,
      previousStripeSeatCount: 5,
      stripeQuantityChanged: false,
      paidIncreaseConfirmed: false,
      metadataSynced: true,
      orgSeatStateSynced: true,
      pendingBillingSeatAllowance: 0,
      org: { billing_seat_count: 5 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/subscription_items/"),
      ),
    ).toBe(false);
    const metadataParams = new URLSearchParams(
      fetchMock.mock.calls[1][1]?.body as string,
    );
    expect(metadataParams.get("metadata[seat_count]")).toBe("5");
    expect(
      metadataParams.get("metadata[subscription_included_credit_cents]"),
    ).toBe("25000");
    expect(orgStub.updateBillingState).toHaveBeenCalledWith({
      billing_seat_count: 5,
    });
    expect(org.billing_seat_count).toBe(5);
  });

  it("adds overlapping invite reservations so stale targets cannot lower six seats", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 3 },
      memberCount: 3,
    });
    let stripeSeatCount = 3;
    let metadataSeatCount = 3;
    let subscriptionReadCount = 0;
    const itemUpdates: number[] = [];
    let paidIncrementalInvoiceCount = 0;
    let markFirstRead!: () => void;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      markFirstRead = resolve;
    });
    const firstReadHold = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "GET") {
        subscriptionReadCount += 1;
        if (subscriptionReadCount === 1) {
          markFirstRead();
          await firstReadHold;
        }
        return {
          ok: true,
          json: async () => ({
            id: "sub_team",
            status: "active",
            metadata: {
              org_id: "org_team",
              billing_plan: "team",
              seat_count: String(metadataSeatCount),
              subscription_included_credit_cents: String(
                metadataSeatCount * 5000,
              ),
            },
            items: {
              data: [
                {
                  id: "si_team",
                  quantity: stripeSeatCount,
                  price: "price_team",
                },
              ],
            },
          }),
        };
      }
      if (url.endsWith("/subscription_items/si_team")) {
        const nextSeatCount = Number(
          new URLSearchParams(init?.body as string).get("quantity"),
        );
        if (nextSeatCount > stripeSeatCount) {
          paidIncrementalInvoiceCount += 1;
        }
        itemUpdates.push(nextSeatCount);
        stripeSeatCount = nextSeatCount;
        return {
          ok: true,
          json: async () => ({ id: "si_team", quantity: stripeSeatCount }),
        };
      }
      if (url.endsWith("/subscriptions/sub_team") && init?.method === "POST") {
        metadataSeatCount = Number(
          new URLSearchParams(init.body as string).get("metadata[seat_count]"),
        );
        return { ok: true, json: async () => ({ id: "sub_team" }) };
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fiveSeatReservation = ensureTeamSubscriptionSeatCapacity(
      env as never,
      "org_team",
      {
        pendingReservedSeatDelta: 2,
        targetSeatCount: 5,
        prorationBehavior: "always_invoice",
      },
    );
    await firstRead;
    const fourSeatReservation = ensureTeamSubscriptionSeatCapacity(
      env as never,
      "org_team",
      {
        pendingReservedSeatDelta: 1,
        targetSeatCount: 4,
        prorationBehavior: "always_invoice",
      },
    );
    await vi.waitFor(() => {
      expect(
        orgStub.acquireTeamSeatMutation.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    releaseFirstRead();

    await expect(fiveSeatReservation).resolves.toMatchObject({
      status: "capacity_confirmed",
      targetSeatCount: 6,
    });
    await expect(fourSeatReservation).resolves.toMatchObject({
      status: "capacity_confirmed",
      requestedSeatCount: 4,
      targetSeatCount: 6,
      stripeQuantityChanged: false,
    });
    expect(itemUpdates).toEqual([6]);
    expect(paidIncrementalInvoiceCount).toBe(1);
    expect(stripeSeatCount).toBe(6);
    expect(metadataSeatCount).toBe(6);
    expect(org.billing_seat_count).toBe(6);
  });

  it("keeps an overlapping invitation reservation above an exact release without a second charge", async () => {
    const { env, org, orgStub } = makeBillingOrgEnv({
      org: { billing_seat_count: 5 },
      memberCount: 4,
    });
    let stripeSeatCount = 5;
    let subscriptionReadCount = 0;
    const itemUpdates: number[] = [];
    let markFirstRead!: () => void;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      markFirstRead = resolve;
    });
    const firstReadHold = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (
          url.endsWith("/subscriptions/sub_team") &&
          init?.method === "GET"
        ) {
          subscriptionReadCount += 1;
          if (subscriptionReadCount === 1) {
            markFirstRead();
            await firstReadHold;
          }
          return {
            ok: true,
            json: async () => ({
              id: "sub_team",
              status: "active",
              metadata: {
                org_id: "org_team",
                billing_plan: "team",
                seat_count: "5",
                subscription_included_credit_cents: "25000",
              },
              items: {
                data: [
                  {
                    id: "si_team",
                    quantity: stripeSeatCount,
                    price: "price_team",
                  },
                ],
              },
            }),
          };
        }
        if (url.endsWith("/subscription_items/si_team")) {
          stripeSeatCount = Number(
            new URLSearchParams(init?.body as string).get("quantity"),
          );
          itemUpdates.push(stripeSeatCount);
          return {
            ok: true,
            json: async () => ({ id: "si_team", quantity: stripeSeatCount }),
          };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      }),
    );

    const exactRelease = syncTeamSubscriptionSeatCount(
      env as never,
      "org_team",
    );
    await firstRead;
    const invitationReservation = ensureTeamSubscriptionSeatCapacity(
      env as never,
      "org_team",
      {
        pendingReservedSeatDelta: 1,
        targetSeatCount: 5,
        prorationBehavior: "always_invoice",
      },
    );
    await vi.waitFor(() => {
      expect(
        orgStub.acquireTeamSeatMutation.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    releaseFirstRead();

    await expect(exactRelease).resolves.toMatchObject({
      status: "capacity_confirmed",
      requestedSeatCount: 4,
      targetSeatCount: 5,
      stripeQuantityChanged: false,
    });
    await expect(invitationReservation).resolves.toMatchObject({
      status: "capacity_confirmed",
      targetSeatCount: 5,
      stripeQuantityChanged: false,
    });
    expect(itemUpdates).toEqual([]);
    expect(stripeSeatCount).toBe(5);
    expect(org.billing_seat_count).toBe(5);
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
      if (url.includes("/subscription_items/")) {
        const params = new URLSearchParams(init?.body as string);
        return {
          ok: true,
          json: async () => ({
            id: "si_team",
            quantity: Number(params.get("quantity")),
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ id: "sub_team" }),
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
    expect(itemParams.has("payment_behavior")).toBe(false);
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
