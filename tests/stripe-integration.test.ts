import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBillingPortalSession,
  createCreditsCheckoutSession,
  createSubscriptionCheckoutSession,
  createSubscriptionUpdatePortalSession,
  getOrCreateBillingPortalConfiguration,
  isStripeSecretKeyAllowedForMode,
  loadCanonicalPaidPlanCatalog,
  processPaidSubscriptionInvoice,
  resolveSubscriptionInvoiceGrant,
  retrieveCanonicalStripeInvoice,
  STRIPE_API_VERSION,
  syncOrgSubscriptionFromStripe,
  syncTeamSubscriptionSeatCount,
  type StripeBillingEnv,
  type StripeInvoice,
  type StripeSubscription,
} from "@/lib/billing.server";
import type { Organization } from "@/types";
import { handleStripeWebhook } from "../workers/main/src/routes/billing";

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

interface StripePaymentMethod {
  id: string;
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

interface StripePortalConfiguration {
  id: string;
  active: boolean;
  features: {
    subscription_update?: {
      enabled?: boolean;
      default_allowed_updates?: string[];
      proration_behavior?: string;
      products?: Array<{
        product?: string;
        prices?: string[];
        adjustable_quantity?: { enabled?: boolean };
      }>;
    };
  };
}

interface StripeInvoiceRecord extends StripeInvoice {
  created?: number;
}

interface StripeTestClock {
  id: string;
  status: "advancing" | "internal_failure" | "ready";
  frozen_time: number;
}

interface StripeSubscriptionWithInvoice extends StripeSubscription {
  latest_invoice?: string | StripeInvoiceRecord | null;
}

interface LocalSubscriptionInvoiceGrant {
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  billingReason:
    | "subscription_create"
    | "subscription_cycle"
    | "subscription_update";
  source: "initial" | "renewal" | "plan_change" | "legacy_migration";
  plan: "starter" | "pro" | "team";
  seatCount: number;
  grantCents: number;
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
  getSubscriptionInvoiceGrant: (
    invoiceId: string,
  ) => Promise<LocalSubscriptionInvoiceGrant | null>;
  applySubscriptionInvoiceGrant: (
    command: LocalSubscriptionInvoiceGrant,
    options?: { legacyProcessed?: boolean },
  ) => Promise<{
    org: Organization;
    applied: boolean;
    credited: boolean;
    legacyProcessed: boolean;
    invariantError: string | null;
  }>;
  getSubscriptionInvoiceGrantCount: () => number;
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

async function stripeFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
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
  return response;
}

async function stripeRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await stripeFetch(path, init);
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
  testClock?: string,
): Promise<StripeCustomer> {
  const params: Record<string, string> = {
    email,
    name: `camelAI integration ${orgId}`,
    "metadata[org_id]": orgId,
  };
  if (testClock) params.test_clock = testClock;
  return stripePost<StripeCustomer>("/customers", params);
}

async function createCardPaymentMethod(
  token: string,
): Promise<StripePaymentMethod> {
  return stripePost<StripePaymentMethod>("/payment_methods", {
    type: "card",
    "card[token]": token,
  });
}

async function attachPaymentMethod(
  paymentMethodId: string,
  customerId: string,
): Promise<void> {
  await stripePost(`/payment_methods/${paymentMethodId}/attach`, {
    customer: customerId,
  });
}

async function setCustomerDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
): Promise<void> {
  await stripePost(`/customers/${customerId}`, {
    "invoice_settings[default_payment_method]": paymentMethodId,
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

async function deactivatePortalConfiguration(
  configurationId: string,
): Promise<void> {
  await stripePost<StripePortalConfiguration>(
    `/billing_portal/configurations/${configurationId}`,
    { active: "false" },
  );
}

async function deleteTestClock(testClockId: string): Promise<void> {
  await stripeRequest<StripeTestClock>(
    `/test_helpers/test_clocks/${testClockId}`,
    {
      method: "DELETE",
    },
  ).catch(() => undefined);
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

async function createPaidSubscription(args: {
  customer: string;
  paymentMethod: string;
  price: string;
  quantity: number;
  orgId: string;
  plan: "starter" | "pro" | "team";
  includedCreditCents: number;
}): Promise<StripeSubscriptionWithInvoice> {
  const params = new URLSearchParams();
  params.set("customer", args.customer);
  params.set("items[0][price]", args.price);
  params.set("items[0][quantity]", String(args.quantity));
  params.set("default_payment_method", args.paymentMethod);
  params.set("payment_behavior", "error_if_incomplete");
  params.set("metadata[org_id]", args.orgId);
  params.set("metadata[billing_plan]", args.plan);
  params.set("metadata[seat_count]", String(args.quantity));
  params.set(
    "metadata[subscription_included_credit_cents]",
    String(args.includedCreditCents),
  );
  params.append("expand[]", "latest_invoice");
  return stripePost<StripeSubscriptionWithInvoice>("/subscriptions", params);
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

async function updatePaidSubscriptionItem(args: {
  itemId: string;
  price: string;
  quantity: number;
  prorationBehavior: "always_invoice" | "none";
  paymentBehavior?: "error_if_incomplete";
}) {
  const params: Record<string, string> = {
    price: args.price,
    quantity: String(args.quantity),
    proration_behavior: args.prorationBehavior,
  };
  if (args.paymentBehavior) {
    params.payment_behavior = args.paymentBehavior;
  }
  return stripePost<{
    id: string;
    quantity: number;
    current_period_start?: number;
    current_period_end?: number;
  }>(`/subscription_items/${args.itemId}`, params);
}

async function setSubscriptionDefaultPaymentMethod(
  subscriptionId: string,
  paymentMethodId: string,
): Promise<void> {
  await stripePost(`/subscriptions/${subscriptionId}`, {
    default_payment_method: paymentMethodId,
  });
}

async function listSubscriptionInvoices(
  subscriptionId: string,
): Promise<StripeInvoiceRecord[]> {
  const params = new URLSearchParams({
    subscription: subscriptionId,
    limit: "100",
  });
  const response = await stripeRequest<StripeList<StripeInvoiceRecord>>(
    `/invoices?${params.toString()}`,
  );
  return response.data;
}

async function waitForNewSubscriptionInvoice(args: {
  subscriptionId: string;
  billingReason: "subscription_cycle" | "subscription_update";
  excludedInvoiceIds?: Set<string>;
}): Promise<StripeInvoiceRecord> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const invoice = (await listSubscriptionInvoices(args.subscriptionId)).find(
      (candidate) =>
        candidate.billing_reason === args.billingReason &&
        !args.excludedInvoiceIds?.has(candidate.id),
    );
    if (invoice) return invoice;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Stripe did not create a ${args.billingReason} invoice for ${args.subscriptionId}.`,
  );
}

async function createTestClock(frozenTime: number): Promise<StripeTestClock> {
  return stripePost<StripeTestClock>("/test_helpers/test_clocks", {
    frozen_time: String(frozenTime),
    name: `${runId} renewal clock`,
  });
}

async function advanceTestClock(
  testClockId: string,
  frozenTime: number,
): Promise<StripeTestClock> {
  await stripePost<StripeTestClock>(
    `/test_helpers/test_clocks/${testClockId}/advance`,
    { frozen_time: String(frozenTime) },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const clock = await stripeRequest<StripeTestClock>(
      `/test_helpers/test_clocks/${testClockId}`,
    );
    if (clock.status === "ready") return clock;
    if (clock.status === "internal_failure") {
      throw new Error(`Stripe Test Clock ${testClockId} failed to advance.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Stripe Test Clock ${testClockId} did not become ready.`);
}

function parseCheckoutSessionId(url: string): string {
  const match = url.match(/\/c\/pay\/(cs_(?:test|live)_[^#?]+)/);
  if (!match?.[1]) {
    throw new Error(`Could not parse Stripe Checkout session id from ${url}`);
  }
  return decodeURIComponent(match[1]);
}

async function captureStripePostBody<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<{ result: T; body: URLSearchParams }> {
  const originalFetch = globalThis.fetch;
  let capturedBody: string | null = null;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(path) && init?.method === "POST") {
      capturedBody = typeof init.body === "string" ? init.body : null;
    }
    return originalFetch(input, init);
  };
  try {
    const result = await operation();
    if (capturedBody === null) {
      throw new Error(`Did not capture Stripe POST ${path}.`);
    }
    return { result, body: new URLSearchParams(capturedBody) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function stripeSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const digest = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${digest}`;
}

async function sendNextVersionPaidWebhook(args: {
  env: StripeBillingEnv;
  invoiceId: string;
}): Promise<Response> {
  const secret = "whsec_integration_next";
  const payload = JSON.stringify({
    id: `evt_next_${args.invoiceId}`,
    type: "invoice.paid",
    data: { object: { id: args.invoiceId } },
  });
  const url = new URL(
    "https://camelai.test/api/billing/stripe/webhook?version=next",
  );
  const req = new Request(url, {
    method: "POST",
    headers: {
      "stripe-signature": await stripeSignature(payload, secret),
    },
    body: payload,
  });
  return handleStripeWebhook({
    req,
    url,
    env: {
      ...args.env,
      STRIPE_WEBHOOK_SECRET: "whsec_integration_current",
      STRIPE_WEBHOOK_SECRET_NEXT: secret,
    } as never,
    ctx: {} as ExecutionContext,
    match: [] as unknown as RegExpMatchArray,
  });
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
  const invoiceGrants = new Map<string, LocalSubscriptionInvoiceGrant>();
  const kv = new Map<string, string>();
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
    getSubscriptionInvoiceGrant: async (invoiceId) =>
      invoiceGrants.get(invoiceId) ?? null,
    applySubscriptionInvoiceGrant: async (command, options = {}) => {
      const existing = invoiceGrants.get(command.invoiceId);
      if (existing) {
        const matches = JSON.stringify(existing) === JSON.stringify(command);
        return {
          org: currentOrg,
          applied: false,
          credited: false,
          legacyProcessed: false,
          invariantError: matches
            ? null
            : `Invoice ${command.invoiceId} has conflicting immutable fields.`,
        };
      }
      const legacyProcessed = Boolean(options.legacyProcessed);
      const credited =
        !legacyProcessed &&
        currentOrg.billing_status !== "enterprise" &&
        command.grantCents > 0;
      invoiceGrants.set(command.invoiceId, { ...command });
      if (credited) {
        currentOrg = {
          ...currentOrg,
          billing_credit_grant_total_cents:
            (currentOrg.billing_credit_grant_total_cents ?? 0) +
            command.grantCents,
          billing_last_included_credit_invoice_id: command.invoiceId,
        };
      }
      return {
        org: currentOrg,
        applied: true,
        credited,
        legacyProcessed,
        invariantError: null,
      };
    },
    getSubscriptionInvoiceGrantCount: () => invoiceGrants.size,
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
    APP_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
        if (
          value.startsWith("bpc_") &&
          !portalConfigurationIds.includes(value)
        ) {
          portalConfigurationIds.push(value);
        }
      },
    } as unknown as KVNamespace,
    orgStub,
  };
}

const runId = `camelai-it-${Date.now()}`;
const customerIds: string[] = [];
const subscriptionIds: string[] = [];
const productIds: string[] = [];
const priceIds: string[] = [];
const portalConfigurationIds: string[] = [];
const testClockIds: string[] = [];

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
    await Promise.all(testClockIds.map(deleteTestClock));
    await Promise.all(
      portalConfigurationIds.map(deactivatePortalConfiguration),
    );
    await Promise.all(priceIds.map(deactivatePrice));
    await Promise.all(productIds.map(deactivateProduct));
  }, 60_000);

  it("uses the pinned Dahlia API version for real Stripe responses", async () => {
    const response = await stripeFetch(`/prices/${testPrices.starter}`);
    expect(response.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
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

  it("runs paid upgrades through real Portal config, invoice resolution, and an idempotent ledger", async () => {
    const orgId = `${runId}-paid-upgrades`;
    const customer = await createStripeCustomer(`${orgId}@example.com`, orgId);
    customerIds.push(customer.id);
    const paymentMethod = await createCardPaymentMethod("tok_visa");
    await attachPaymentMethod(paymentMethod.id, customer.id);
    await setCustomerDefaultPaymentMethod(customer.id, paymentMethod.id);
    const subscription = await createPaidSubscription({
      customer: customer.id,
      paymentMethod: paymentMethod.id,
      price: testPrices.starter,
      quantity: 1,
      orgId,
      plan: "starter",
      includedCreditCents: 1000,
    });
    subscriptionIds.push(subscription.id);
    expect(subscription.status).toBe("active");

    const org = makeOrg(orgId, {
      billing_status: "active",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_customer_id: customer.id,
      billing_subscription_id: subscription.id,
      billing_subscription_status: "active",
    });
    const env = makeEnv({ org, memberCount: 3 });

    const [upgradeConfigurationId, downgradeConfigurationId] =
      await Promise.all([
        getOrCreateBillingPortalConfiguration(env, "upgrade"),
        getOrCreateBillingPortalConfiguration(env, "downgrade"),
      ]);
    const [upgradeConfiguration, downgradeConfiguration] = await Promise.all([
      stripeRequest<StripePortalConfiguration>(
        `/billing_portal/configurations/${upgradeConfigurationId}`,
      ),
      stripeRequest<StripePortalConfiguration>(
        `/billing_portal/configurations/${downgradeConfigurationId}`,
      ),
    ]);
    expect(upgradeConfiguration.features.subscription_update).toMatchObject({
      enabled: true,
      proration_behavior: "always_invoice",
    });
    expect(downgradeConfiguration.features.subscription_update).toMatchObject({
      enabled: true,
      proration_behavior: "none",
    });
    for (const configuration of [
      upgradeConfiguration,
      downgradeConfiguration,
    ]) {
      expect(
        configuration.features.subscription_update?.default_allowed_updates,
      ).toEqual(expect.arrayContaining(["price", "quantity"]));
      const products =
        configuration.features.subscription_update?.products ?? [];
      expect(products.flatMap((product) => product.prices ?? [])).toEqual(
        expect.arrayContaining([
          testPrices.starter,
          testPrices.pro,
          testPrices.team,
        ]),
      );
      expect(
        products.every(
          (product) => product.adjustable_quantity?.enabled === false,
        ),
      ).toBe(true);
    }

    const portal = await captureStripePostBody("/billing_portal/sessions", () =>
      createSubscriptionUpdatePortalSession({
        env,
        org,
        customerEmail: `${orgId}@example.com`,
        returnUrl: "https://example.com/settings/organization/billing",
        plan: "team",
      }),
    );
    expect(portal.result).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(portal.body.get("configuration")).toBe(upgradeConfigurationId);
    expect(portal.body.get("flow_data[type]")).toBe(
      "subscription_update_confirm",
    );
    expect(
      portal.body.get(
        "flow_data[subscription_update_confirm][items][0][price]",
      ),
    ).toBe(testPrices.team);
    expect(
      portal.body.get(
        "flow_data[subscription_update_confirm][items][0][quantity]",
      ),
    ).toBe("3");

    const starterSubscription = await fetchSubscription(subscription.id);
    const subscriptionItem = starterSubscription.items?.data?.[0];
    expect(subscriptionItem?.id).toBeTruthy();
    const invoiceIdsBeforePro = new Set(
      (await listSubscriptionInvoices(subscription.id)).map(
        (invoice) => invoice.id,
      ),
    );
    const proItem = await updatePaidSubscriptionItem({
      itemId: subscriptionItem!.id,
      price: testPrices.pro,
      quantity: 1,
      prorationBehavior: "always_invoice",
      paymentBehavior: "error_if_incomplete",
    });
    expect(proItem.quantity).toBe(1);
    expect(proItem.current_period_end).toEqual(expect.any(Number));
    const proInvoice = await waitForNewSubscriptionInvoice({
      subscriptionId: subscription.id,
      billingReason: "subscription_update",
      excludedInvoiceIds: invoiceIdsBeforePro,
    });
    expect(proInvoice.status).toBe("paid");

    const proCanonical = await retrieveCanonicalStripeInvoice({
      env,
      invoiceId: proInvoice.id,
    });
    const catalog = await loadCanonicalPaidPlanCatalog(env);
    const liveProSubscription = await fetchSubscription(subscription.id);
    const proResolution = resolveSubscriptionInvoiceGrant({
      env,
      ...proCanonical,
      subscription: liveProSubscription,
      catalog,
      orgId,
      customerId: customer.id,
      customerMetadata: { org_id: orgId },
    });
    expect(proResolution.command).toMatchObject({
      plan: "pro",
      seatCount: 1,
      source: "plan_change",
      grantCents: 3000,
    });
    await expect(
      processPaidSubscriptionInvoice(env, proInvoice.id),
    ).resolves.toMatchObject({ status: "processed", grantCents: 3000 });
    await expect(
      processPaidSubscriptionInvoice(env, proInvoice.id),
    ).resolves.toMatchObject({ status: "duplicate", grantCents: 0 });

    const invoiceIdsBeforeTeam = new Set(
      (await listSubscriptionInvoices(subscription.id)).map(
        (invoice) => invoice.id,
      ),
    );
    await updatePaidSubscriptionItem({
      itemId: subscriptionItem!.id,
      price: testPrices.team,
      quantity: 3,
      prorationBehavior: "always_invoice",
      paymentBehavior: "error_if_incomplete",
    });
    const teamInvoice = await waitForNewSubscriptionInvoice({
      subscriptionId: subscription.id,
      billingReason: "subscription_update",
      excludedInvoiceIds: invoiceIdsBeforeTeam,
    });
    expect(teamInvoice.status).toBe("paid");
    const teamCanonical = await retrieveCanonicalStripeInvoice({
      env,
      invoiceId: teamInvoice.id,
    });
    const liveTeamSubscription = await fetchSubscription(subscription.id);
    const teamResolution = resolveSubscriptionInvoiceGrant({
      env,
      ...teamCanonical,
      subscription: liveTeamSubscription,
      catalog,
      orgId,
      customerId: customer.id,
      customerMetadata: { org_id: orgId },
    });
    expect(teamResolution.command).toMatchObject({
      plan: "team",
      seatCount: 3,
      source: "plan_change",
      grantCents: 11000,
    });
    await expect(
      processPaidSubscriptionInvoice(env, teamInvoice.id),
    ).resolves.toMatchObject({ status: "processed", grantCents: 11000 });
    await expect(
      processPaidSubscriptionInvoice(env, teamInvoice.id),
    ).resolves.toMatchObject({ status: "duplicate", grantCents: 0 });
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "team",
      billing_seat_count: 3,
      billing_credit_grant_total_cents: 14000,
    });
    expect(env.orgStub.getSubscriptionInvoiceGrantCount()).toBe(2);

    const webhookResponse = await sendNextVersionPaidWebhook({
      env,
      invoiceId: teamInvoice.id,
    });
    expect(webhookResponse.status).toBe(200);
    expect(env.orgStub.getSubscriptionInvoiceGrantCount()).toBe(2);
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 14000,
    });

    const invoiceIdsBeforeDowngrade = new Set(
      (await listSubscriptionInvoices(subscription.id)).map(
        (invoice) => invoice.id,
      ),
    );
    await updatePaidSubscriptionItem({
      itemId: subscriptionItem!.id,
      price: testPrices.pro,
      quantity: 1,
      prorationBehavior: "none",
    });
    const invoicesAfterDowngrade = await listSubscriptionInvoices(
      subscription.id,
    );
    expect(
      invoicesAfterDowngrade.filter(
        (invoice) => !invoiceIdsBeforeDowngrade.has(invoice.id),
      ),
    ).toEqual([]);
    await syncOrgSubscriptionFromStripe(
      env,
      await fetchSubscription(subscription.id),
    );
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_credit_grant_total_cents: 14000,
    });
    expect(env.orgStub.getSubscriptionInvoiceGrantCount()).toBe(2);
  }, 120_000);

  it("does not commit or grant a paid update when Stripe declines payment", async () => {
    const orgId = `${runId}-failed-payment`;
    const customer = await createStripeCustomer(`${orgId}@example.com`, orgId);
    customerIds.push(customer.id);
    const goodPaymentMethod = await createCardPaymentMethod("tok_visa");
    await attachPaymentMethod(goodPaymentMethod.id, customer.id);
    await setCustomerDefaultPaymentMethod(customer.id, goodPaymentMethod.id);
    const subscription = await createPaidSubscription({
      customer: customer.id,
      paymentMethod: goodPaymentMethod.id,
      price: testPrices.starter,
      quantity: 1,
      orgId,
      plan: "starter",
      includedCreditCents: 1000,
    });
    subscriptionIds.push(subscription.id);

    const org = makeOrg(orgId, {
      billing_status: "active",
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_customer_id: customer.id,
      billing_subscription_id: subscription.id,
      billing_subscription_status: "active",
    });
    const env = makeEnv({ org });
    const declinedPaymentMethod =
      await createCardPaymentMethod("tok_chargeDeclined");
    await attachPaymentMethod(declinedPaymentMethod.id, customer.id);
    await setSubscriptionDefaultPaymentMethod(
      subscription.id,
      declinedPaymentMethod.id,
    );

    const liveBefore = await fetchSubscription(subscription.id);
    const item = liveBefore.items?.data?.[0];
    expect(item?.id).toBeTruthy();
    const invoiceIdsBefore = new Set(
      (await listSubscriptionInvoices(subscription.id)).map(
        (invoice) => invoice.id,
      ),
    );
    await expect(
      updatePaidSubscriptionItem({
        itemId: item!.id,
        price: testPrices.pro,
        quantity: 1,
        prorationBehavior: "always_invoice",
        paymentBehavior: "error_if_incomplete",
      }),
    ).rejects.toThrow(/subscription_items.*failed with 402/i);

    const liveAfter = await fetchSubscription(subscription.id);
    expect(liveAfter.items?.data?.[0]?.price).toMatchObject({
      id: testPrices.starter,
    });
    const newInvoices = (
      await listSubscriptionInvoices(subscription.id)
    ).filter((invoice) => !invoiceIdsBefore.has(invoice.id));
    expect(newInvoices.some((invoice) => invoice.status === "paid")).toBe(
      false,
    );
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "starter",
      billing_seat_count: 1,
      billing_credit_grant_total_cents: 0,
    });
    expect(env.orgStub.getSubscriptionInvoiceGrantCount()).toBe(0);
  }, 120_000);

  it("grants a real paid renewal invoice exactly once", async () => {
    const orgId = `${runId}-renewal`;
    const frozenTime = Math.floor(Date.now() / 1000);
    const testClock = await createTestClock(frozenTime);
    testClockIds.push(testClock.id);
    const customer = await createStripeCustomer(
      `${orgId}@example.com`,
      orgId,
      testClock.id,
    );
    customerIds.push(customer.id);
    const paymentMethod = await createCardPaymentMethod("tok_visa");
    await attachPaymentMethod(paymentMethod.id, customer.id);
    await setCustomerDefaultPaymentMethod(customer.id, paymentMethod.id);
    const subscription = await createPaidSubscription({
      customer: customer.id,
      paymentMethod: paymentMethod.id,
      price: testPrices.pro,
      quantity: 1,
      orgId,
      plan: "pro",
      includedCreditCents: 4000,
    });
    subscriptionIds.push(subscription.id);
    const initialInvoiceId =
      typeof subscription.latest_invoice === "string"
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id;
    expect(initialInvoiceId).toBeTruthy();

    await advanceTestClock(testClock.id, frozenTime + 32 * 24 * 60 * 60);
    const renewalInvoice = await waitForNewSubscriptionInvoice({
      subscriptionId: subscription.id,
      billingReason: "subscription_cycle",
      excludedInvoiceIds: new Set(initialInvoiceId ? [initialInvoiceId] : []),
    });
    expect(renewalInvoice.status).toBe("paid");

    const org = makeOrg(orgId, {
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_customer_id: customer.id,
      billing_subscription_id: subscription.id,
      billing_subscription_status: "active",
    });
    const env = makeEnv({ org });
    await expect(
      processPaidSubscriptionInvoice(env, renewalInvoice.id),
    ).resolves.toMatchObject({
      status: "processed",
      plan: "pro",
      seatCount: 1,
      source: "renewal",
      grantCents: 4000,
    });
    await expect(
      processPaidSubscriptionInvoice(env, renewalInvoice.id),
    ).resolves.toMatchObject({ status: "duplicate", grantCents: 0 });
    await expect(env.orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_credit_grant_total_cents: 4000,
    });
    expect(env.orgStub.getSubscriptionInvoiceGrantCount()).toBe(1);
  }, 180_000);

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
