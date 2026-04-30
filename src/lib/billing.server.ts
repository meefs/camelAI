import type { BillingPlan, BillingStatus, Organization } from "@/types";
import type { OrgDO } from "../../workers/main/src/auth";
import {
  type BillingPlanLimits,
  getBillingPlanLimits,
  getIncludedCreditCentsForPlan,
  getMinimumSeats,
  getOrgBillingPlan,
  normalizeBillingPlan,
  normalizeSeatCount,
} from "@/lib/billing-plans";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2026-02-25.clover";
export const STRIPE_SUBSCRIPTION_TRIAL_DAYS = 7;
const CREDIT_CHECKOUT_EVENT_PREFIX = "stripe_checkout_credits:";
const INCLUDED_CREDIT_INVOICE_EVENT_PREFIX = "stripe_invoice_included_credit:";
export const DEFAULT_TRIAL_CREDIT_CENTS = 1000;
export const DEFAULT_SUBSCRIPTION_INCLUDED_CREDIT_CENTS = 1000;

export interface StripeBillingEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  SANDBOX_HOST?: Fetcher;
  APP_KV?: KVNamespace;
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID?: string;
  STRIPE_STARTER_PRICE_ID?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_TEAM_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_IDS?: string;
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
  BILLING_TRIAL_CREDIT_CENTS?: string;
  BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS?: string;
}

export interface StripeCustomer {
  id: string;
  email?: string | null;
  metadata?: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer?: string | StripeCustomer | null;
  metadata?: Record<string, string>;
  quantity?: number | null;
  trial_start?: number | null;
  trial_end?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  items?: {
    data?: StripeSubscriptionItem[];
  } | null;
}

export interface StripeSubscriptionItem {
  id: string;
  quantity?: number | null;
  price?: string | StripePriceSummary | null;
}

export interface StripeInvoiceListEntry {
  id: string;
  created: number;
  amount_paid?: number | null;
  amount_due?: number | null;
  total?: number | null;
  currency: string;
  status?: string | null;
  hosted_invoice_url?: string | null;
}

export interface StripePaymentMethodSummary {
  brand: string;
  last4: string;
}

export interface StripeSubscriptionSummary {
  id: string;
  status: string;
  current_period_end_ms: number | null;
  cancel_at_period_end: boolean;
  trial_end_ms: number | null;
}

export interface StripeCheckoutSession {
  id: string;
  mode?: string | null;
  customer?: string | null;
  subscription?: string | null;
  payment_status?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
  url?: string | null;
}

export interface StripeInvoice {
  id: string;
  customer?: string | StripeCustomer | null;
  subscription?: string | StripeSubscription | null;
  status?: string | null;
  paid?: boolean | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  total?: number | null;
  billing_reason?: string | null;
  metadata?: Record<string, string>;
  subscription_details?: {
    metadata?: Record<string, string>;
  } | null;
}

export interface StripeWebhookEvent<T = unknown> {
  id: string;
  type: string;
  data: {
    object: T;
  };
}

const RECURRING_INCLUDED_CREDIT_BILLING_REASONS = new Set([
  "subscription_cycle",
]);

interface UsageLogSumResponse {
  total_cost_usd: number;
  total_requests: number;
}

interface OrgSpendResponse {
  total_cost_usd: number;
  total_requests: number;
}

export interface StripePriceSummary {
  id: string;
  unit_amount: number | null;
  currency: string;
  active?: boolean;
  recurring?: {
    interval: string;
    interval_count?: number;
  } | null;
}

export interface ConfiguredCreditPack extends StripePriceSummary {}

export interface OrgBillingAccessSnapshot {
  org_id: string;
  billing_status: BillingStatus;
  billing_plan: BillingPlan;
  billing_seat_count: number;
  billing_subscription_status: string | null;
  billing_trial_ends_at: number | null;
  billing_credit_purchase_total_cents: number;
  billing_credit_grant_total_cents: number;
  billing_trial_credit_grant_cents: number;
  billing_trial_credit_granted_at: number | null;
  billing_free_credit_grant_cents: number;
  billing_free_credit_granted_at: number | null;
  billing_last_included_credit_invoice_id: string | null;
  billing_credit_usage_started_at: number | null;
}

export interface OrgBillingOverview extends OrgBillingAccessSnapshot {
  lifetime_spend_cents: number;
  chargeable_usage_cents: number;
  chargeable_request_count: number;
  available_credits_cents: number;
  total_credit_limit_cents: number;
  trial_credit_allowance_cents: number;
  subscription_included_credit_cents: number;
}

export interface ConfiguredSubscriptionPlan {
  plan: BillingPlan;
  priceId: string;
  price: StripePriceSummary | null;
  limits: BillingPlanLimits;
}

function getOrgStub(env: StripeBillingEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId));
}

function centsFromUsd(amountUsd: number): number {
  return Math.max(0, Math.round(amountUsd * 100));
}

export function isStripeSecretKeyAllowedForMode(
  secretKey: string | null | undefined,
  mode: string | null | undefined,
): boolean {
  const normalizedMode = mode?.trim().toLowerCase();
  if (!normalizedMode) return true;

  const trimmedKey = secretKey?.trim() ?? "";
  if (normalizedMode === "test") {
    return (
      trimmedKey.startsWith("sk_test_") || trimmedKey.startsWith("rk_test_")
    );
  }
  if (normalizedMode === "live") {
    return (
      trimmedKey.startsWith("sk_live_") || trimmedKey.startsWith("rk_live_")
    );
  }
  return false;
}

function assertStripeSecretKeyMatchesMode(
  secretKey: string,
  mode: string | null | undefined,
): void {
  if (!isStripeSecretKeyAllowedForMode(secretKey, mode)) {
    throw new Error(
      `Stripe secret key does not match configured STRIPE_MODE=${mode?.trim() || "unset"}`,
    );
  }
}

function parseCreditCents(
  rawValue: string | null | undefined,
  fallbackCents: number,
): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallbackCents;
  return Math.max(0, Math.floor(parsed));
}

export function getBillingAllowanceConfig(
  env: Pick<
    StripeBillingEnv,
    | "BILLING_TRIAL_CREDIT_CENTS"
    | "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS"
  >,
): {
  trialCreditCents: number;
  subscriptionIncludedCreditCents: number;
} {
  return {
    trialCreditCents: parseCreditCents(
      env.BILLING_TRIAL_CREDIT_CENTS,
      DEFAULT_TRIAL_CREDIT_CENTS,
    ),
    subscriptionIncludedCreditCents: parseCreditCents(
      env.BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS,
      DEFAULT_SUBSCRIPTION_INCLUDED_CREDIT_CENTS,
    ),
  };
}

function getConfiguredCreditCents(
  rawValue: string | null | undefined,
  fallbackCents: number,
): number {
  if (rawValue === undefined || rawValue === null || rawValue.trim() === "") {
    return fallbackCents;
  }
  return parseCreditCents(rawValue, fallbackCents);
}

function getTrialCreditCentsForPlan(
  env: Pick<StripeBillingEnv, "BILLING_TRIAL_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return getConfiguredCreditCents(
    env.BILLING_TRIAL_CREDIT_CENTS,
    getIncludedCreditCentsForPlan(plan, seatCount),
  );
}

function getSubscriptionIncludedCreditCentsForPlan(
  env: Pick<StripeBillingEnv, "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return getConfiguredCreditCents(
    env.BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS,
    getIncludedCreditCentsForPlan(plan, seatCount),
  );
}

function getStripePriceId(price: string | StripePriceSummary | null | undefined) {
  return typeof price === "string" ? price : (price?.id ?? null);
}

function getStripeSubscriptionSeatQuantity(
  subscription: StripeSubscription,
  priceId: string | null,
): number | null {
  const items = subscription.items?.data ?? [];
  const matchingItem = priceId
    ? items.find((item) => getStripePriceId(item.price) === priceId)
    : null;
  const quantity = matchingItem?.quantity ?? items[0]?.quantity;
  if (typeof quantity === "number" && Number.isFinite(quantity)) {
    return quantity;
  }
  return subscription.quantity ?? null;
}

function normalizeBillingStatus(
  status: string | null | undefined,
): BillingStatus {
  switch (status) {
    case "trialing":
    case "active":
    case "enterprise":
    case "past_due":
    case "canceled":
      return status;
    case "paying":
      return "active";
    default:
      return "inactive";
  }
}

function mapStripeSubscriptionStatus(
  status: string | null | undefined,
): BillingStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return "inactive";
  }
}

function stripeAuthHeaders(secretKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${secretKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  });
}

async function stripeRequest<T>(
  env: StripeBillingEnv,
  path: string,
  init: {
    method?: string;
    body?: URLSearchParams;
  } = {},
): Promise<T> {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }
  assertStripeSecretKeyMatchesMode(secretKey, env.STRIPE_MODE);

  const headers = stripeAuthHeaders(secretKey);
  let body: string | undefined;
  if (init.body) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = init.body.toString();
  }

  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Stripe ${path} returned ${response.status}: ${detail}`);
  }

  return response.json() as Promise<T>;
}

export function isStripeBillingConfigured(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SECRET_KEY"
    | "STRIPE_MODE"
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
    | "STRIPE_CREDIT_PRICE_IDS"
    | "STRIPE_CREDIT_PRICE_ID"
  >,
): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY?.trim() &&
    isStripeSecretKeyAllowedForMode(env.STRIPE_SECRET_KEY, env.STRIPE_MODE) &&
    getConfiguredSubscriptionPriceId(env, "starter") &&
    getConfiguredCreditPriceIds(env).length > 0,
  );
}

export function parseStripePriceIdList(
  rawValue: string | null | undefined,
): string[] {
  if (!rawValue) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of rawValue.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

export function getConfiguredCreditPriceIds(
  env: Pick<
    StripeBillingEnv,
    "STRIPE_CREDIT_PRICE_IDS" | "STRIPE_CREDIT_PRICE_ID"
  >,
): string[] {
  const configured = parseStripePriceIdList(env.STRIPE_CREDIT_PRICE_IDS);
  if (configured.length > 0) {
    return configured;
  }
  return parseStripePriceIdList(env.STRIPE_CREDIT_PRICE_ID);
}

export function getConfiguredSubscriptionPriceId(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
  plan: BillingPlan,
): string | null {
  switch (plan) {
    case "starter":
      return (
        env.STRIPE_STARTER_PRICE_ID?.trim() ||
        env.STRIPE_SUBSCRIPTION_PRICE_ID?.trim() ||
        null
      );
    case "pro":
      return env.STRIPE_PRO_PRICE_ID?.trim() || null;
    case "team":
      return env.STRIPE_TEAM_PRICE_ID?.trim() || null;
    default:
      return null;
  }
}

export function getConfiguredSubscriptionPlans(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
): Array<{ plan: BillingPlan; priceId: string; limits: BillingPlanLimits }> {
  return (["starter", "pro", "team"] as BillingPlan[])
    .map((plan) => {
      const priceId = getConfiguredSubscriptionPriceId(env, plan);
      return priceId
        ? { plan, priceId, limits: getBillingPlanLimits(plan) }
        : null;
    })
    .filter(
      (
        plan,
      ): plan is {
        plan: BillingPlan;
        priceId: string;
        limits: BillingPlanLimits;
      } => Boolean(plan),
    );
}

export async function fetchConfiguredSubscriptionPlans(
  env: StripeBillingEnv,
): Promise<ConfiguredSubscriptionPlan[]> {
  const plans = getConfiguredSubscriptionPlans(env);
  return Promise.all(
    plans.map(async (plan) => ({
      ...plan,
      price: await fetchStripePriceSummary(env, plan.priceId),
    })),
  );
}

export async function fetchStripePriceSummary(
  env: StripeBillingEnv,
  priceId: string | null | undefined,
): Promise<StripePriceSummary | null> {
  const trimmedPriceId = priceId?.trim();
  if (!trimmedPriceId || !env.STRIPE_SECRET_KEY?.trim()) {
    return null;
  }

  const response = await stripeRequest<StripePriceSummary>(
    env,
    `/prices/${trimmedPriceId}`,
  );
  return response;
}

async function fetchStripeSubscription(
  env: StripeBillingEnv,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(env, `/subscriptions/${subscriptionId}`);
}

function getStripeSubscriptionItemForPlan(
  subscription: StripeSubscription,
  priceId: string | null,
): StripeSubscriptionItem {
  const items = subscription.items?.data ?? [];
  const matchingItem = priceId
    ? items.find((item) => getStripePriceId(item.price) === priceId)
    : null;
  if (priceId && !matchingItem) {
    throw new Error(
      `Stripe subscription does not have an item for configured price ${priceId}`,
    );
  }
  const item = matchingItem ?? items[0];
  if (!item?.id) {
    throw new Error("Stripe subscription does not have a billable item");
  }
  return item;
}

function shouldSyncTeamSeats(org: Organization): boolean {
  if (getOrgBillingPlan(org) !== "team") return false;
  if (org.billing_status === "enterprise") return false;
  if (!org.billing_subscription_id?.trim()) return false;
  return (
    org.billing_status === "trialing" ||
    org.billing_status === "active" ||
    org.billing_status === "past_due"
  );
}

export async function getBillableTeamSeatCount(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  pendingReservedSeatDelta = 0,
): Promise<number | null> {
  const orgStub = getOrgStub(env as StripeBillingEnv, orgId);
  const org = await orgStub.getInfo();
  if (!org || getOrgBillingPlan(org) !== "team") return null;

  const [memberCount, invitations] = await Promise.all([
    orgStub.getMemberCount(),
    orgStub.getInvitations(),
  ]);
  const now = Date.now();
  const activeInvitationCount = invitations.filter(
    (invitation) => invitation.expires_at > now,
  ).length;
  return normalizeSeatCount(
    "team",
    memberCount + activeInvitationCount + pendingReservedSeatDelta,
  );
}

export async function syncTeamSubscriptionSeatCount(
  env: StripeBillingEnv,
  orgId: string,
  options: {
    pendingReservedSeatDelta?: number;
  } = {},
): Promise<Organization | null> {
  const orgStub = getOrgStub(env, orgId);
  const org = await orgStub.getInfo();
  if (!org) return null;
  if (!shouldSyncTeamSeats(org)) return org;

  const seatCount = await getBillableTeamSeatCount(
    env,
    orgId,
    options.pendingReservedSeatDelta ?? 0,
  );
  if (!seatCount) return org;

  if (org.billing_seat_count === seatCount) {
    return org;
  }

  const subscriptionId = org.billing_subscription_id?.trim();
  if (!subscriptionId) return org;

  const priceId = getConfiguredSubscriptionPriceId(env, "team");
  const subscription = await fetchStripeSubscription(env, subscriptionId);
  const item = getStripeSubscriptionItemForPlan(subscription, priceId);

  const itemBody = new URLSearchParams();
  itemBody.set("quantity", String(seatCount));
  itemBody.set("proration_behavior", "create_prorations");
  await stripeRequest<StripeSubscriptionItem>(
    env,
    `/subscription_items/${item.id}`,
    {
      method: "POST",
      body: itemBody,
    },
  );

  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    "team",
    seatCount,
  );
  const subscriptionBody = new URLSearchParams();
  subscriptionBody.set("metadata[org_id]", org.id);
  subscriptionBody.set("metadata[billing_plan]", "team");
  subscriptionBody.set("metadata[seat_count]", String(seatCount));
  subscriptionBody.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );
  await stripeRequest<StripeSubscription>(env, `/subscriptions/${subscriptionId}`, {
    method: "POST",
    body: subscriptionBody,
  });

  await orgStub.updateBillingState({
    billing_seat_count: seatCount,
  });
  return orgStub.getInfo();
}

export async function bestEffortSyncTeamSubscriptionSeatCount(
  env: StripeBillingEnv,
  orgId: string,
  options: {
    pendingReservedSeatDelta?: number;
    reason?: string;
  } = {},
): Promise<Organization | null> {
  try {
    return await syncTeamSubscriptionSeatCount(env, orgId, options);
  } catch (error) {
    console.error("[billing] failed to sync team subscription seats", {
      orgId,
      reason: options.reason ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function fetchConfiguredCreditPacks(
  env: StripeBillingEnv,
): Promise<ConfiguredCreditPack[]> {
  const priceIds = getConfiguredCreditPriceIds(env);
  if (priceIds.length === 0) {
    return [];
  }

  const packs = await Promise.all(
    priceIds.map((priceId) => fetchStripePriceSummary(env, priceId)),
  );

  return packs
    .filter((pack): pack is ConfiguredCreditPack => Boolean(pack))
    .sort((left, right) => {
      const leftAmount = left.unit_amount ?? Number.MAX_SAFE_INTEGER;
      const rightAmount = right.unit_amount ?? Number.MAX_SAFE_INTEGER;
      return leftAmount - rightAmount;
    });
}

export async function getBillingAccessSnapshot(
  env: StripeBillingEnv,
  orgId: string,
): Promise<OrgBillingAccessSnapshot | null> {
  const org = await getOrgStub(env, orgId).getInfo();
  if (!org) return null;

  return {
    org_id: org.id,
    billing_status: normalizeBillingStatus(org.billing_status),
    billing_plan: normalizeBillingPlan(org.billing_plan, org.billing_status),
    billing_seat_count: normalizeSeatCount(
      normalizeBillingPlan(org.billing_plan, org.billing_status),
      org.billing_seat_count,
    ),
    billing_subscription_status: org.billing_subscription_status ?? null,
    billing_trial_ends_at: org.billing_trial_ends_at ?? null,
    billing_credit_purchase_total_cents:
      org.billing_credit_purchase_total_cents ?? 0,
    billing_credit_grant_total_cents: org.billing_credit_grant_total_cents ?? 0,
    billing_trial_credit_grant_cents: org.billing_trial_credit_grant_cents ?? 0,
    billing_trial_credit_granted_at:
      org.billing_trial_credit_granted_at ?? null,
    billing_free_credit_grant_cents:
      org.billing_free_credit_grant_cents ?? 0,
    billing_free_credit_granted_at:
      org.billing_free_credit_granted_at ?? null,
    billing_last_included_credit_invoice_id:
      org.billing_last_included_credit_invoice_id ?? null,
    billing_credit_usage_started_at:
      org.billing_credit_usage_started_at ?? null,
  };
}

async function fetchUsageLogSum(
  env: Pick<StripeBillingEnv, "SANDBOX_HOST">,
  orgId: string,
  fromMs: number,
  toMs: number,
  chargeableOnly = false,
): Promise<UsageLogSumResponse> {
  if (!env.SANDBOX_HOST) {
    return { total_cost_usd: 0, total_requests: 0 };
  }

  const response = await env.SANDBOX_HOST.fetch(
    `http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/log/sum?from=${fromMs}&to=${toMs}${chargeableOnly ? "&chargeable_only=1" : ""}`,
  );
  if (!response.ok) {
    throw new Error(`Usage sum fetch failed with ${response.status}`);
  }
  return response.json() as Promise<UsageLogSumResponse>;
}

async function fetchLifetimeSpend(
  env: Pick<StripeBillingEnv, "SANDBOX_HOST">,
  orgId: string,
): Promise<OrgSpendResponse> {
  if (!env.SANDBOX_HOST) {
    return { total_cost_usd: 0, total_requests: 0 };
  }

  const response = await env.SANDBOX_HOST.fetch(
    `http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/spend`,
  );
  if (!response.ok) {
    throw new Error(`Usage spend fetch failed with ${response.status}`);
  }
  return response.json() as Promise<OrgSpendResponse>;
}

export async function getOrgBillingOverview(
  env: StripeBillingEnv,
  org: Organization,
): Promise<OrgBillingOverview> {
  const snapshot = await getBillingAccessSnapshot(env, org.id);
  if (!snapshot) {
    throw new Error("Organization not found");
  }

  const now = Date.now();
  const [lifetimeSpend, chargeableUsage] = await Promise.all([
    fetchLifetimeSpend(env, org.id).catch(() => ({
      total_cost_usd: 0,
      total_requests: 0,
    })),
    fetchUsageLogSum(env, org.id, 0, now, true).catch(() => ({
      total_cost_usd: 0,
      total_requests: 0,
    })),
  ]);

  const chargeableUsageCents = centsFromUsd(
    chargeableUsage.total_cost_usd ?? 0,
  );
  const totalCreditLimitCents =
    snapshot.billing_credit_purchase_total_cents +
    snapshot.billing_credit_grant_total_cents;
  const availableCreditsCents = Math.max(
    0,
    totalCreditLimitCents - chargeableUsageCents,
  );
  const trialCreditCents = getTrialCreditCentsForPlan(
    env,
    snapshot.billing_plan,
    snapshot.billing_seat_count,
  );
  const subscriptionIncludedCreditCents =
    getSubscriptionIncludedCreditCentsForPlan(
      env,
      snapshot.billing_plan,
      snapshot.billing_seat_count,
    );

  return {
    ...snapshot,
    lifetime_spend_cents: centsFromUsd(lifetimeSpend.total_cost_usd ?? 0),
    chargeable_usage_cents: chargeableUsageCents,
    chargeable_request_count: chargeableUsage.total_requests ?? 0,
    available_credits_cents: availableCreditsCents,
    total_credit_limit_cents: totalCreditLimitCents,
    trial_credit_allowance_cents: trialCreditCents,
    subscription_included_credit_cents: subscriptionIncludedCreditCents,
  };
}

export async function ensureStripeCustomerForOrg(
  env: StripeBillingEnv,
  org: Organization,
  email: string | null | undefined,
): Promise<string> {
  if (org.billing_customer_id) {
    return org.billing_customer_id;
  }

  const body = new URLSearchParams();
  body.set("name", org.name);
  if (email?.trim()) {
    body.set("email", email.trim());
  }
  body.set("metadata[org_id]", org.id);

  const customer = await stripeRequest<StripeCustomer>(env, "/customers", {
    method: "POST",
    body,
  });

  await getOrgStub(env, org.id).updateBillingState({
    billing_customer_id: customer.id,
  });

  return customer.id;
}

export async function createSubscriptionCheckoutSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  successUrl: string;
  cancelUrl: string;
  plan: BillingPlan;
  seatCount?: number | null;
}): Promise<string> {
  const { env, org, customerEmail, successUrl, cancelUrl } = args;
  const plan = normalizeBillingPlan(args.plan, org.billing_status);
  if (plan === "free" || plan === "enterprise") {
    throw new Error("This plan cannot be started through Stripe Checkout");
  }
  const priceId = getConfiguredSubscriptionPriceId(env, plan);
  if (!priceId) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }
  const seatCount = normalizeSeatCount(
    plan,
    args.seatCount ?? org.billing_seat_count ?? getMinimumSeats(plan),
  );
  const trialCreditCents = getTrialCreditCentsForPlan(env, plan, seatCount);
  const subscriptionIncludedCreditCents =
    getSubscriptionIncludedCreditCentsForPlan(env, plan, seatCount);

  const customerId = await ensureStripeCustomerForOrg(env, org, customerEmail);
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("customer", customerId);
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("allow_promotion_codes", "true");
  body.set("client_reference_id", org.id);
  body.set("metadata[org_id]", org.id);
  body.set("metadata[purchase_type]", "subscription");
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set("metadata[trial_credit_cents]", String(trialCreditCents));
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set("line_items[0][price]", priceId);
  body.set("line_items[0][quantity]", String(seatCount));
  body.set(
    "subscription_data[trial_period_days]",
    String(STRIPE_SUBSCRIPTION_TRIAL_DAYS),
  );
  body.set("subscription_data[metadata][org_id]", org.id);
  body.set("subscription_data[metadata][billing_plan]", plan);
  body.set("subscription_data[metadata][seat_count]", String(seatCount));
  body.set(
    "subscription_data[metadata][trial_credit_cents]",
    String(trialCreditCents),
  );
  body.set(
    "subscription_data[metadata][subscription_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );

  const session = await stripeRequest<StripeCheckoutSession>(
    env,
    "/checkout/sessions",
    {
      method: "POST",
      body,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return session.url;
}

export async function createCreditsCheckoutSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  successUrl: string;
  cancelUrl: string;
  priceId: string;
}): Promise<string> {
  const { env, org, customerEmail, successUrl, cancelUrl, priceId } = args;
  const allowedPriceIds = new Set(getConfiguredCreditPriceIds(env));
  const trimmedPriceId = priceId.trim();
  if (!trimmedPriceId) {
    throw new Error("Stripe credit pack is required");
  }
  if (!allowedPriceIds.has(trimmedPriceId)) {
    throw new Error("Stripe credit pack is not allowed");
  }

  const customerId = await ensureStripeCustomerForOrg(env, org, customerEmail);
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("customer", customerId);
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("allow_promotion_codes", "true");
  body.set("client_reference_id", org.id);
  body.set("metadata[org_id]", org.id);
  body.set("metadata[purchase_type]", "credits");
  body.set("metadata[credit_price_id]", trimmedPriceId);
  body.set("line_items[0][price]", trimmedPriceId);
  body.set("line_items[0][quantity]", "1");

  const session = await stripeRequest<StripeCheckoutSession>(
    env,
    "/checkout/sessions",
    {
      method: "POST",
      body,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return session.url;
}

export async function createBillingPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
}): Promise<string> {
  const { env, org, customerEmail, returnUrl } = args;
  const customerId = await ensureStripeCustomerForOrg(env, org, customerEmail);
  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  const portalConfigurationId =
    env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim();
  if (portalConfigurationId) {
    body.set("configuration", portalConfigurationId);
  }

  const session = await stripeRequest<{ url?: string | null }>(
    env,
    "/billing_portal/sessions",
    {
      method: "POST",
      body,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a billing portal URL");
  }

  return session.url;
}

async function resolveOrgIdFromStripeCustomer(
  env: StripeBillingEnv,
  customerId: string | null | undefined,
): Promise<string | null> {
  const trimmedCustomerId = customerId?.trim();
  if (!trimmedCustomerId) return null;

  const customer = await stripeRequest<StripeCustomer>(
    env,
    `/customers/${trimmedCustomerId}`,
  );
  return customer.metadata?.org_id?.trim() || null;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function getMetadataBillingPlan(
  metadata: Record<string, string> | null | undefined,
  fallbackStatus?: BillingStatus | null,
): BillingPlan {
  return normalizeBillingPlan(metadata?.billing_plan, fallbackStatus);
}

function getMetadataSeatCount(
  metadata: Record<string, string> | null | undefined,
  plan: BillingPlan,
  fallback?: number | null,
): number {
  return normalizeSeatCount(
    plan,
    parsePositiveInteger(metadata?.seat_count) ?? fallback,
  );
}

function getMetadataTrialCreditCents(
  metadata: Record<string, string> | null | undefined,
  env: Pick<StripeBillingEnv, "BILLING_TRIAL_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return (
    parsePositiveInteger(metadata?.trial_credit_cents) ??
    getTrialCreditCentsForPlan(env, plan, seatCount)
  );
}

function getMetadataSubscriptionIncludedCreditCents(
  metadata: Record<string, string> | null | undefined,
  env: Pick<StripeBillingEnv, "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return (
    parsePositiveInteger(metadata?.subscription_included_credit_cents) ??
    getSubscriptionIncludedCreditCentsForPlan(env, plan, seatCount)
  );
}

export async function syncOrgSubscriptionFromStripe(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): Promise<Organization | null> {
  const directOrgId = subscription.metadata?.org_id?.trim();
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : (subscription.customer?.id ?? null);
  const orgId =
    directOrgId || (await resolveOrgIdFromStripeCustomer(env, customerId));
  if (!orgId) {
    return null;
  }

  const orgStub = getOrgStub(env, orgId);
  const existing = await orgStub.getInfo();
  if (!existing) return null;

  const nextStatus = mapStripeSubscriptionStatus(subscription.status);
  const nextBillingStatus =
    existing.billing_status === "enterprise" ? "enterprise" : nextStatus;
  const nextPlan =
    existing.billing_status === "enterprise"
      ? "enterprise"
      : getMetadataBillingPlan(subscription.metadata, nextStatus);
  const subscriptionSeatQuantity = getStripeSubscriptionSeatQuantity(
    subscription,
    getConfiguredSubscriptionPriceId(env, nextPlan),
  );
  const seatCount = normalizeSeatCount(
    nextPlan,
    subscriptionSeatQuantity ??
      parsePositiveInteger(subscription.metadata?.seat_count) ??
      existing.billing_seat_count,
  );
  const trialCreditCents = getMetadataTrialCreditCents(
    subscription.metadata,
    env,
    nextPlan,
    seatCount,
  );

  const result = await orgStub.syncSubscriptionBillingState(
    {
      billing_status: nextBillingStatus,
      billing_plan: nextPlan,
      billing_seat_count: seatCount,
      billing_customer_id: customerId,
      billing_subscription_id: subscription.id,
      billing_subscription_status: subscription.status ?? null,
      billing_trial_started_at: subscription.trial_start
        ? subscription.trial_start * 1000
        : null,
      billing_trial_ends_at: subscription.trial_end
        ? subscription.trial_end * 1000
        : null,
      billing_credit_usage_started_at:
        existing.billing_credit_usage_started_at ?? null,
    },
    trialCreditCents,
  );

  return result?.org ?? null;
}

async function hasProcessedIncludedCreditInvoice(
  env: Pick<StripeBillingEnv, "APP_KV">,
  invoiceId: string,
): Promise<boolean> {
  if (!env.APP_KV) return false;
  const existing = await env.APP_KV.get(
    `${INCLUDED_CREDIT_INVOICE_EVENT_PREFIX}${invoiceId}`,
  );
  return Boolean(existing);
}

async function markIncludedCreditInvoiceProcessed(
  env: Pick<StripeBillingEnv, "APP_KV">,
  invoiceId: string,
): Promise<void> {
  if (!env.APP_KV) return;
  await env.APP_KV.put(
    `${INCLUDED_CREDIT_INVOICE_EVENT_PREFIX}${invoiceId}`,
    "1",
  );
}

function getInvoiceSubscriptionId(invoice: StripeInvoice): string | null {
  if (typeof invoice.subscription === "string") {
    return invoice.subscription;
  }
  return invoice.subscription?.id ?? null;
}

export function isRecurringSubscriptionInvoice(
  invoice: StripeInvoice,
): boolean {
  return RECURRING_INCLUDED_CREDIT_BILLING_REASONS.has(
    invoice.billing_reason ?? "",
  );
}

export async function applySubscriptionIncludedCreditsFromInvoice(
  env: StripeBillingEnv,
  invoice: StripeInvoice,
): Promise<Organization | null> {
  if (!getInvoiceSubscriptionId(invoice)) return null;
  if (!isRecurringSubscriptionInvoice(invoice)) return null;
  if (invoice.status !== "paid" && invoice.paid !== true) return null;
  if (await hasProcessedIncludedCreditInvoice(env, invoice.id)) return null;

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : (invoice.customer?.id ?? null);
  const orgId =
    invoice.metadata?.org_id?.trim() ||
    invoice.subscription_details?.metadata?.org_id?.trim() ||
    (typeof invoice.subscription === "object"
      ? invoice.subscription?.metadata?.org_id?.trim()
      : null) ||
    (await resolveOrgIdFromStripeCustomer(env, customerId));
  if (!orgId) {
    return null;
  }

  const orgStub = getOrgStub(env, orgId);
  const existing = await orgStub.getInfo();
  if (!existing) {
    return null;
  }
  if (existing.billing_status === "enterprise") {
    await markIncludedCreditInvoiceProcessed(env, invoice.id);
    return existing;
  }
  if (existing.billing_last_included_credit_invoice_id === invoice.id) {
    await markIncludedCreditInvoiceProcessed(env, invoice.id);
    return existing;
  }
  const invoiceMetadata =
    invoice.subscription_details?.metadata ||
    (typeof invoice.subscription === "object"
      ? invoice.subscription?.metadata
      : null) ||
    invoice.metadata;
  const plan = getMetadataBillingPlan(invoiceMetadata, existing.billing_status);
  const seatCount = getMetadataSeatCount(
    invoiceMetadata,
    plan,
    existing.billing_seat_count,
  );
  const includedCreditCents = getMetadataSubscriptionIncludedCreditCents(
    invoiceMetadata,
    env,
    plan,
    seatCount,
  );
  if (includedCreditCents <= 0) {
    await markIncludedCreditInvoiceProcessed(env, invoice.id);
    return existing;
  }

  await orgStub.updateBillingState({
    billing_customer_id: customerId ?? existing.billing_customer_id ?? null,
    billing_plan: plan,
    billing_seat_count: seatCount,
    billing_credit_grant_total_cents:
      (existing.billing_credit_grant_total_cents ?? 0) + includedCreditCents,
    billing_last_included_credit_invoice_id: invoice.id,
  });
  await markIncludedCreditInvoiceProcessed(env, invoice.id);

  return orgStub.getInfo();
}

async function hasProcessedCreditCheckout(
  env: Pick<StripeBillingEnv, "APP_KV">,
  sessionId: string,
): Promise<boolean> {
  if (!env.APP_KV) return false;
  const existing = await env.APP_KV.get(
    `${CREDIT_CHECKOUT_EVENT_PREFIX}${sessionId}`,
  );
  return Boolean(existing);
}

export async function applyCreditsCheckoutCompleted(
  env: StripeBillingEnv,
  session: StripeCheckoutSession,
): Promise<Organization | null> {
  if (session.mode !== "payment") return null;
  if (session.payment_status !== "paid") return null;
  if (session.metadata?.purchase_type !== "credits") return null;
  if (await hasProcessedCreditCheckout(env, session.id)) return null;

  const orgId =
    session.metadata?.org_id?.trim() || session.client_reference_id?.trim();
  if (!orgId) {
    return null;
  }

  const amountCents = session.amount_subtotal ?? session.amount_total ?? 0;
  if (amountCents <= 0) {
    return null;
  }

  const orgStub = getOrgStub(env, orgId);
  const result = await orgStub.applyCreditCheckout(
    session.id,
    amountCents,
    session.customer ?? null,
  );
  return result?.org ?? null;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyStripeWebhookSignature(args: {
  payload: string;
  signatureHeader: string | null;
  secret: string;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const { payload, signatureHeader, secret, toleranceSeconds = 300 } = args;
  if (!signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3))
    .filter(Boolean);
  if (!timestampPart || signatures.length === 0) {
    return false;
  }

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  const digest = Array.from(new Uint8Array(signed))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((signature) => timingSafeEqual(signature, digest));
}

interface StripeListResponse<T> {
  data: T[];
  has_more?: boolean;
}

export async function listStripeInvoicesForOrg(
  env: StripeBillingEnv,
  org: Organization,
  options: { limit?: number } = {},
): Promise<StripeInvoiceListEntry[]> {
  // FIXME(billing-stripe): paginate beyond the first page if needed.
  if (!org.billing_customer_id) return [];
  if (!env.STRIPE_SECRET_KEY?.trim()) return [];

  const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
  const params = new URLSearchParams();
  params.set("customer", org.billing_customer_id);
  params.set("limit", String(limit));
  const response = await stripeRequest<StripeListResponse<StripeInvoiceListEntry>>(
    env,
    `/invoices?${params.toString()}`,
  );
  return response.data ?? [];
}

interface StripePaymentMethod {
  id: string;
  card?: {
    brand?: string | null;
    last4?: string | null;
  } | null;
}

interface StripeCustomerWithPaymentMethod extends StripeCustomer {
  invoice_settings?: {
    default_payment_method?: string | StripePaymentMethod | null;
  } | null;
  default_source?: string | null;
}

export async function getStripeDefaultPaymentMethodSummary(
  env: StripeBillingEnv,
  org: Organization,
): Promise<StripePaymentMethodSummary | null> {
  // FIXME(billing-stripe): support non-card payment methods (Link, bank, etc.).
  if (!org.billing_customer_id) return null;
  if (!env.STRIPE_SECRET_KEY?.trim()) return null;

  const customer = await stripeRequest<StripeCustomerWithPaymentMethod>(
    env,
    `/customers/${org.billing_customer_id}?expand[]=invoice_settings.default_payment_method`,
  );

  const defaultPm = customer.invoice_settings?.default_payment_method;
  if (defaultPm && typeof defaultPm === "object" && defaultPm.card?.last4) {
    return {
      brand: defaultPm.card.brand?.trim() || "card",
      last4: defaultPm.card.last4,
    };
  }
  if (typeof defaultPm === "string" && defaultPm) {
    const expanded = await stripeRequest<StripePaymentMethod>(
      env,
      `/payment_methods/${defaultPm}`,
    );
    if (expanded.card?.last4) {
      return {
        brand: expanded.card.brand?.trim() || "card",
        last4: expanded.card.last4,
      };
    }
  }
  return null;
}

export async function getStripeSubscriptionSummary(
  env: StripeBillingEnv,
  org: Organization,
): Promise<StripeSubscriptionSummary | null> {
  // FIXME(billing-stripe): wire this to the live Stripe subscription so renewal
  // and cancel-at-period-end render correctly.
  if (!org.billing_subscription_id) return null;
  if (!env.STRIPE_SECRET_KEY?.trim()) return null;

  const subscription = await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${org.billing_subscription_id}`,
  );

  return {
    id: subscription.id,
    status: subscription.status,
    current_period_end_ms: subscription.current_period_end
      ? subscription.current_period_end * 1000
      : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    trial_end_ms: subscription.trial_end ? subscription.trial_end * 1000 : null,
  };
}
