import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBillingPortalSession,
  createCreditsCheckoutSession,
  createSubscriptionCheckoutSession,
  isStripeSecretKeyAllowedForMode,
  STRIPE_API_VERSION,
  syncOrgSubscriptionFromStripe,
  syncTeamSubscriptionSeatCount,
  type StripeBillingEnv,
  type StripeSubscription,
} from "@/lib/billing.server";
import type { Organization } from "@/types";

/**
 * Opt-in tests against Stripe test mode.
 *
 * Run with:
 * STRIPE_INTEGRATION_SECRET_KEY=rk_test_... bun run test:stripe
 *
 * The suite creates isolated Stripe test objects and then cancels/deactivates
 * them in afterAll. Keep this out of the default test target because it depends
 * on external Stripe availability and a real test-mode API key.
 */
const STRIPE_API_BASE = "https://api.stripe.com/v1";

const stripeSecretKey =
  process.env.STRIPE_INTEGRATION_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
const runStripeIntegrationTests =
  process.env.RUN_STRIPE_INTEGRATION_TESTS === "1" && Boolean(stripeSecretKey);

const describeStripe = runStripeIntegrationTests ? describe : describe.skip;

interface StripeProduct {
  id: string;
}

interface StripePrice {
  id: string;
  product: string;
}

interface StripeCustomer {
  id: string;
  deleted?: boolean;
}

interface StripeCheckoutSession {
  id: string;
  mode: string;
  customer: string;
  metadata?: Record<string, string>;
  url?: string | null;
}

interface StripeLineItem {
  id: string;
  quantity?: number | null;
  price?: StripePrice | null;
}

interface StripeList<T> {
  data: T[];
}

interface MutableOrgStub {
  getInfo: () => Promise<Organization>;
  updateBillingState: (state: Partial<Organization>) => Promise<void>;
  syncSubscriptionBillingState: (
    state: Partial<Organization>,
    trialCreditGrantCents: number,
  ) => Promise<{ org: Organization; trialCreditGranted: boolean }>;
  getMemberCount: () => Promise<number>;
  getInvitations: () => Promise<Array<{ expires_at: number }>>;
}

function requireStripeKey(): string {
  const key = stripeSecretKey?.trim();
  if (!key) {
    throw new Error(
      "Set STRIPE_INTEGRATION_SECRET_KEY or STRIPE_SECRET_KEY to run Stripe integration tests.",
    );
  }
  if (!isStripeSecretKeyAllowedForMode(key, "test")) {
    throw new Error("Stripe integration tests require a test-mode key.");
  }
  return key;
}

async function stripeRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireStripeKey()}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Stripe ${path} failed with ${response.status}: ${message}`);
  }
  return response.json() as Promise<T>;
}

async function stripePost<T>(
  path: string,
  params: Record<string, string> | URLSearchParams,
): Promise<T> {
  return stripeRequest<T>(path, {
    method: "POST",
    body:
      params instanceof URLSearchParams
        ? params.toString()
        : new URLSearchParams(params).toString(),
  });
}

async function createProduct(name: string): Promise<StripeProduct> {
  return stripePost<StripeProduct>("/products", { name });
}

async function createPrice(args: {
  product: string;
  unitAmount: number;
  recurring?: boolean;
}): Promise<StripePrice> {
  const params: Record<string, string> = {
    product: args.product,
    currency: "usd",
    unit_amount: String(args.unitAmount),
  };
  if (args.recurring) {
    params["recurring[interval]"] = "month";
  }
  return stripePost<StripePrice>("/prices", params);
}

async function createStripeCustomer(
  email: string,
  orgId: string,
): Promise<StripeCustomer> {
  return stripePost<StripeCustomer>("/customers", {
    email,
    name: `camelAI integration ${orgId}`,
    "metadata[org_id]": orgId,
  });
}

async function deleteCustomer(customerId: string): Promise<void> {
  await stripeRequest<StripeCustomer>(`/customers/${customerId}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

async function cancelSubscription(subscriptionId: string): Promise<void> {
  await stripeRequest<StripeSubscription>(`/subscriptions/${subscriptionId}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

async function deactivatePrice(priceId: string): Promise<void> {
  await stripePost<StripePrice>(`/prices/${priceId}`, {
    active: "false",
  }).catch(() => undefined);
}

async function deactivateProduct(productId: string): Promise<void> {
  await stripePost<StripeProduct>(`/products/${productId}`, {
    active: "false",
  }).catch(() => undefined);
}

async function createTrialSubscription(args: {
  customer: string;
  price: string;
  quantity: number;
  orgId: string;
  plan: string;
  includedCreditCents: number;
  trialCreditCents?: number;
}): Promise<StripeSubscription> {
  return stripePost<StripeSubscription>("/subscriptions", {
    customer: args.customer,
    "items[0][price]": args.price,
    "items[0][quantity]": String(args.quantity),
    trial_period_days: "7",
    "metadata[org_id]": args.orgId,
    "metadata[billing_plan]": args.plan,
    "metadata[seat_count]": String(args.quantity),
    "metadata[trial_credit_cents]": String(args.trialCreditCents ?? 1000),
    "metadata[subscription_included_credit_cents]": String(
      args.includedCreditCents,
    ),
  });
}

async function fetchSubscription(subscriptionId: string) {
  const params = new URLSearchParams();
  params.append("expand[]", "items.data.price");
  return stripeRequest<StripeSubscription>(
    `/subscriptions/${subscriptionId}?${params.toString()}`,
  );
}

async function updateSubscriptionMetadata(args: {
  subscriptionId: string;
  orgId: string;
  plan: string;
  seatCount: number;
  includedCreditCents: number;
}) {
  return stripePost<StripeSubscription>(`/subscriptions/${args.subscriptionId}`, {
    "metadata[org_id]": args.orgId,
    "metadata[billing_plan]": args.plan,
    "metadata[seat_count]": String(args.seatCount),
    "metadata[subscription_included_credit_cents]": String(
      args.includedCreditCents,
    ),
  });
}

async function updateSubscriptionItem(args: {
  itemId: string;
  price: string;
  quantity: number;
}) {
  return stripePost(`/subscription_items/${args.itemId}`, {
    price: args.price,
    quantity: String(args.quantity),
    proration_behavior: "none",
  });
}

function parseCheckoutSessionId(url: string): string {
  const match = url.match(/\/c\/pay\/(cs_(?:test|live)_[^#?]+)/);
  if (!match?.[1]) {
    throw new Error(`Could not parse Stripe Checkout session id from ${url}`);
  }
  return decodeURIComponent(match[1]);
}

function makeOrg(id: string, overrides: Partial<Organization> = {}) {
  return {
    id,
    name: `Stripe Test ${id}`,
    billing_status: "inactive",
    billing_plan: "free",
    billing_seat_count: 1,
    billing_customer_id: null,
    billing_subscription_id: null,
    billing_subscription_status: null,
    billing_trial_started_at: null,
    billing_trial_ends_at: null,
    billing_trial_credit_granted_at: null,
    billing_credit_grant_total_cents: 0,
    billing_credit_purchase_total_cents: 0,
    billing_last_included_credit_invoice_id: null,
    ...overrides,
  } as Organization;
}

function makeEnv(args: {
  org: Organization;
  memberCount?: number;
  invitations?: Array<{ expires_at: number }>;
}): StripeBillingEnv & { orgStub: MutableOrgStub } {
  let currentOrg = args.org;
  const orgStub: MutableOrgStub = {
    getInfo: async () => currentOrg,
    updateBillingState: async (state) => {
      currentOrg = { ...currentOrg, ...state };
    },
    syncSubscriptionBillingState: async (state, trialCreditGrantCents) => {
      const existingTrialUsed = Boolean(
        currentOrg.billing_trial_started_at ||
          currentOrg.billing_trial_ends_at ||
          currentOrg.billing_trial_credit_granted_at,
      );
      const shouldGrantTrialCredits =
        trialCreditGrantCents > 0 &&
        currentOrg.billing_status !== "enterprise" &&
        state.billing_status === "trialing" &&
        Boolean(state.billing_trial_started_at) &&
        Boolean(state.billing_trial_ends_at) &&
        !existingTrialUsed;

      currentOrg = { ...currentOrg, ...state };
      if (shouldGrantTrialCredits) {
        currentOrg.billing_credit_grant_total_cents =
          (currentOrg.billing_credit_grant_total_cents ?? 0) +
          trialCreditGrantCents;
        currentOrg.billing_trial_credit_grant_cents = trialCreditGrantCents;
        currentOrg.billing_trial_credit_granted_at = Date.now();
      }

      return { org: currentOrg, trialCreditGranted: shouldGrantTrialCredits };
    },
    getMemberCount: async () => args.memberCount ?? 1,
    getInvitations: async () => args.invitations ?? [],
  };

  return {
    ORG: {
      idFromName: (id: string) => id,
      get: () => orgStub,
    } as unknown as StripeBillingEnv["ORG"],
    STRIPE_MODE: "test",
    STRIPE_SECRET_KEY: requireStripeKey(),
    STRIPE_STARTER_PRICE_ID: testPrices.starter,
    STRIPE_PRO_PRICE_ID: testPrices.pro,
    STRIPE_TEAM_PRICE_ID: testPrices.team,
    STRIPE_CREDIT_PRICE_IDS: testPrices.credit,
    orgStub,
  };
}

const runId = `camelai-it-${Date.now()}`;
const customerIds: string[] = [];
const subscriptionIds: string[] = [];
const productIds: string[] = [];
const priceIds: string[] = [];

const testPrices: {
  starter: string;
  pro: string;
  team: string;
  credit: string;
} = {
  starter: "",
  pro: "",
  team: "",
  credit: "",
};

describeStripe("Stripe billing integration", () => {
  beforeAll(async () => {
    const [starterProduct, proProduct, teamProduct, creditProduct] =
      await Promise.all([
        createProduct(`${runId} starter`),
        createProduct(`${runId} pro`),
        createProduct(`${runId} team`),
        createProduct(`${runId} credits`),
      ]);
    productIds.push(
      starterProduct.id,
      proProduct.id,
      teamProduct.id,
      creditProduct.id,
    );

    const [starter, pro, team, credit] = await Promise.all([
      createPrice({
        product: starterProduct.id,
        unitAmount: 1000,
        recurring: true,
      }),
      createPrice({
        product: proProduct.id,
        unitAmount: 4000,
        recurring: true,
      }),
      createPrice({
        product: teamProduct.id,
        unitAmount: 5000,
        recurring: true,
      }),
      createPrice({ product: creditProduct.id, unitAmount: 1000 }),
    ]);

    for (const price of [starter, pro, team, credit]) {
      priceIds.push(price.id);
    }
    testPrices.starter = starter.id;
    testPrices.pro = pro.id;
    testPrices.team = team.id;
    testPrices.credit = credit.id;

  }, 60_000);

  beforeEach(() => {
    expect(isStripeSecretKeyAllowedForMode(requireStripeKey(), "test")).toBe(
      true,
    );
  });

  afterAll(async () => {
    await Promise.all(subscriptionIds.map(cancelSubscription));
    await Promise.all(customerIds.map(deleteCustomer));
    await Promise.all(priceIds.map(deactivatePrice));
    await Promise.all(productIds.map(deactivateProduct));
  }, 60_000);

  it("creates real subscription and credit Checkout sessions with expected line items", async () => {
    const orgId = `${runId}-checkout`;
    const org = makeOrg(orgId);
    const env = makeEnv({ org });

    const subscriptionUrl = await createSubscriptionCheckoutSession({
      env,
      org,
      customerEmail: `${orgId}@example.com`,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      plan: "team",
      seatCount: 25,
    });

    const subscriptionSessionId = parseCheckoutSessionId(subscriptionUrl);
    const subscriptionSession = await stripeRequest<StripeCheckoutSession>(
      `/checkout/sessions/${subscriptionSessionId}`,
    );
    customerIds.push(subscriptionSession.customer);

    expect(subscriptionSession.mode).toBe("subscription");
    expect(subscriptionSession.metadata).toMatchObject({
      org_id: orgId,
      purchase_type: "subscription",
      billing_plan: "team",
      seat_count: "25",
      trial_credit_cents: "1000",
      subscription_included_credit_cents: "125000",
    });

    const subscriptionLineItems = await stripeRequest<
      StripeList<StripeLineItem>
    >(`/checkout/sessions/${subscriptionSessionId}/line_items`);
    expect(subscriptionLineItems.data[0]?.price?.id).toBe(testPrices.team);
    expect(subscriptionLineItems.data[0]?.quantity).toBe(25);

    const creditsUrl = await createCreditsCheckoutSession({
      env,
      org: await env.orgStub.getInfo(),
      customerEmail: `${orgId}@example.com`,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      priceId: testPrices.credit,
    });

    const creditsSessionId = parseCheckoutSessionId(creditsUrl);
    const creditsSession = await stripeRequest<StripeCheckoutSession>(
      `/checkout/sessions/${creditsSessionId}`,
    );
    expect(creditsSession.mode).toBe("payment");
    expect(creditsSession.metadata).toMatchObject({
      org_id: orgId,
      purchase_type: "credits",
      credit_price_id: testPrices.credit,
    });

    const creditLineItems = await stripeRequest<StripeList<StripeLineItem>>(
      `/checkout/sessions/${creditsSessionId}/line_items`,
    );
    expect(creditLineItems.data[0]?.price?.id).toBe(testPrices.credit);
    expect(creditLineItems.data[0]?.quantity).toBe(1);
  }, 60_000);

  it("creates a real Billing Portal session for an active subscriber", async () => {
    const orgId = `${runId}-portal`;
    const customer = await createStripeCustomer(`${orgId}@example.com`, orgId);
    customerIds.push(customer.id);

    const subscription = await createTrialSubscription({
      customer: customer.id,
      price: testPrices.pro,
      quantity: 1,
      orgId,
      plan: "pro",
      includedCreditCents: 4000,
    });
    subscriptionIds.push(subscription.id);

    const org = makeOrg(orgId, {
      billing_status: "trialing",
      billing_plan: "pro",
      billing_customer_id: customer.id,
      billing_subscription_id: subscription.id,
      billing_subscription_status: subscription.status,
    });
    const env = makeEnv({ org });

    const portalUrl = await createBillingPortalSession({
      env,
      org,
      customerEmail: `${orgId}@example.com`,
      returnUrl: "https://example.com/settings/organization/billing",
    });

    expect(portalUrl).toMatch(/^https:\/\/billing\.stripe\.com\//);
  }, 60_000);

  it("syncs real Stripe subscription upgrades and downgrades into org billing state", async () => {
    const orgId = `${runId}-plan-change`;
    const customer = await createStripeCustomer(`${orgId}@example.com`, orgId);
    customerIds.push(customer.id);

    const subscription = await createTrialSubscription({
      customer: customer.id,
      price: testPrices.starter,
      quantity: 1,
      orgId,
      plan: "starter",
      includedCreditCents: 1000,
    });
    subscriptionIds.push(subscription.id);

    const org = makeOrg(orgId);
    const env = makeEnv({ org });

    await syncOrgSubscriptionFromStripe(
      env,
      await fetchSubscription(subscription.id),
    );
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_status: "trialing",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_subscription_id: subscription.id,
    });

    const starterItem = (await fetchSubscription(subscription.id)).items?.data?.[0];
    expect(starterItem?.id).toBeTruthy();
    await updateSubscriptionItem({
      itemId: starterItem!.id,
      price: testPrices.pro,
      quantity: 1,
    });
    await updateSubscriptionMetadata({
      subscriptionId: subscription.id,
      orgId,
      plan: "pro",
      seatCount: 1,
      includedCreditCents: 4000,
    });
    await syncOrgSubscriptionFromStripe(
      env,
      await fetchSubscription(subscription.id),
    );
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "pro",
      billing_seat_count: 1,
    });

    const proItem = (await fetchSubscription(subscription.id)).items?.data?.[0];
    expect(proItem?.id).toBeTruthy();
    await updateSubscriptionItem({
      itemId: proItem!.id,
      price: testPrices.starter,
      quantity: 1,
    });
    await updateSubscriptionMetadata({
      subscriptionId: subscription.id,
      orgId,
      plan: "starter",
      seatCount: 1,
      includedCreditCents: 1000,
    });
    await syncOrgSubscriptionFromStripe(
      env,
      await fetchSubscription(subscription.id),
    );
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "starter",
      billing_seat_count: 1,
    });
  }, 60_000);

  it("updates real Stripe team subscription quantity and per-seat credit metadata", async () => {
    const orgId = `${runId}-team-seats`;
    const customer = await createStripeCustomer(`${orgId}@example.com`, orgId);
    customerIds.push(customer.id);

    const subscription = await createTrialSubscription({
      customer: customer.id,
      price: testPrices.team,
      quantity: 3,
      orgId,
      plan: "team",
      includedCreditCents: 15000,
    });
    subscriptionIds.push(subscription.id);

    const org = makeOrg(orgId, {
      billing_status: "trialing",
      billing_plan: "team",
      billing_customer_id: customer.id,
      billing_subscription_id: subscription.id,
      billing_subscription_status: subscription.status,
      billing_seat_count: 3,
    });
    const env = makeEnv({ org, memberCount: 4 });

    await syncTeamSubscriptionSeatCount(env, orgId);

    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_seat_count: 4,
    });

    const updatedSubscription = await fetchSubscription(subscription.id);
    expect(updatedSubscription.metadata).toMatchObject({
      billing_plan: "team",
      seat_count: "4",
      subscription_included_credit_cents: "20000",
    });
    expect(updatedSubscription.items?.data?.[0]?.quantity).toBe(4);
  }, 60_000);
});
