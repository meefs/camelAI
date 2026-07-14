import type { BillingPlan, BillingStatus, Organization } from "@/types";
import type {
  ApplySubscriptionInvoiceGrantResult,
  OrgDO,
  SubscriptionInvoiceGrantCommand,
} from "../../workers/main/src/auth";
import {
  BILLING_PLAN_LIMITS,
  type BillingPlanLimits,
  getBillingPlanLimits,
  getIncludedCreditCentsForPlan,
  getMinimumSeats,
  getOrgBillingPlan,
  isTeamSeatBillingSyncable,
  normalizeBillingPlan,
  normalizeSeatCount,
} from "@/lib/billing-plans";
import { canBuyCreditsForBillingState } from "@/lib/billing-credit-packs";
import { isSelfhostRuntime, type SelfhostRuntimeEnv } from "@/lib/selfhost-runtime";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2026-06-24.dahlia";
const CREDIT_CHECKOUT_EVENT_PREFIX = "stripe_checkout_credits:";
const INCLUDED_CREDIT_INVOICE_EVENT_PREFIX = "stripe_invoice_included_credit:";
const BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION = 1;
const BILLING_PORTAL_CONFIGURATION_KV_PREFIX = "stripe_billing_portal_configuration:";
const LEGACY_MIGRATION_META_ORG_ID = "v2_mig_org";
const LEGACY_MIGRATION_META_SUBSCRIPTION_ID = "v2_mig_sub";
const LEGACY_MIGRATION_META_TARGET_PLAN = "v2_mig_plan";
const LEGACY_MIGRATION_META_SEAT_COUNT = "v2_mig_seats";
const LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS = "v2_mig_credits";
const LEGACY_MIGRATION_META_SOURCE_PRICE_ID = "v2_mig_price";
export const DEFAULT_TRIAL_CREDIT_CENTS = 1000;
export const DEFAULT_SUBSCRIPTION_INCLUDED_CREDIT_CENTS = 1000;
const NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

type SubscriptionBillingPlan = Exclude<
  BillingPlan,
  "free" | "payg" | "enterprise"
>;

export interface StripeBillingEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  APP_KV?: KVNamespace;
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET_NEXT?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID?: string;
  STRIPE_STARTER_PRICE_ID?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_TEAM_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_IDS?: string;
  LEGACY_STRIPE_MIGRATION_CUSTOMERS?: string;
  BILLING_TRIAL_CREDIT_CENTS?: string;
  BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
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
  cancel_at?: number | null;
  canceled_at?: number | null;
  cancel_at_period_end?: boolean | null;
  items?: {
    data?: StripeSubscriptionItem[];
  } | null;
}

export type BillingPortalMode = "management" | "upgrade" | "downgrade";

export interface CanonicalPaidPlanCatalogEntry {
  plan: SubscriptionBillingPlan;
  productId: string;
  priceId: string;
  unitAmount: number;
  currency: "usd";
  interval: "month";
  intervalCount: 1;
}

export interface StripeSubscriptionItem {
  id: string;
  quantity?: number | null;
  price?: string | StripePriceSummary | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
}

export interface LegacyStripeMigrationEligibility {
  eligible: boolean;
  customerId: string | null;
  activeLegacySubscriptionCount: number;
  defaultPlan: SubscriptionBillingPlan;
}

export interface LegacyStripeMigrationPreview {
  plan: SubscriptionBillingPlan;
  seatCount: number;
  currency: string;
  monthlyPriceCents: number | null;
  amountDueTodayCents: number | null;
  legacyCreditCents: number | null;
  newPlanProrationCents: number | null;
  includedCreditCents: number;
}

interface LegacyStripeMigrationCandidate {
  email: string;
  customerId: string;
  subscriptionIds: string[];
  subscriptionItemIds: string[];
  legacyPriceIds: string[];
  totalLegacyQuantity: number | null;
  activeLegacySubscriptionCount: number;
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

export interface StripeSubscriptionSummary {
  id: string;
  status: string;
  current_period_end_ms: number | null;
  cancel_at_ms: number | null;
  cancellation_date_ms: number | null;
  cancel_at_period_end: boolean;
  is_canceling: boolean;
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
  parent?: {
    subscription_details?: {
      subscription?: string | StripeSubscription | null;
      metadata?: Record<string, string>;
    } | null;
  } | null;
  lines?: {
    data?: StripeInvoiceLine[];
    has_more?: boolean;
  } | null;
}

export interface StripeInvoiceLine {
  id?: string | null;
  amount?: number | null;
  currency?: string | null;
  description?: string | null;
  quantity?: number | null;
  price?: string | StripePriceSummary | null;
  pricing?: {
    price_details?: {
      price?: string | StripePriceSummary | null;
      product?: string | { id?: string | null } | null;
    } | null;
  } | null;
  proration?: boolean | null;
  type?: string | null;
  subscription_item?: string | null;
  parent?: {
    type?: string | null;
    subscription_item_details?: {
      proration?: boolean | null;
      subscription_item?: string | null;
    } | null;
    invoice_item_details?: unknown;
  } | null;
}

export type PaidSubscriptionInvoiceProcessingResult =
  | {
      status: "ignored";
      reason: string;
      invoiceId: string;
      subscriptionId?: string | null;
    }
  | {
      status: "processed" | "duplicate";
      invoiceId: string;
      subscriptionId: string;
      orgId: string;
      plan: SubscriptionBillingPlan;
      seatCount: number;
      grantCents: number;
      source: SubscriptionInvoiceGrantCommand["source"];
      org: Organization;
    };

export type SubscriptionInvoiceReconciliationReport =
  | {
      status: "ignored";
      invoiceId: string;
      subscriptionId: string | null;
      reason: string;
    }
  | {
      status: "preview" | "processed" | "duplicate";
      invoiceId: string;
      subscriptionId: string;
      orgId: string;
      billingReason: SubscriptionInvoiceGrantCommand["billingReason"];
      plan: SubscriptionBillingPlan;
      seatCount: number;
      source: SubscriptionInvoiceGrantCommand["source"];
      computedGrantCents: number;
      creditedGrantCents: number;
      oldKvMarker: boolean;
      lastInvoiceMarker: string | null;
      ledgerStatus: "not_recorded" | "recorded" | "legacy_processed";
    };

export interface StripeWebhookEvent<T = unknown> {
  id: string;
  type: string;
  data: {
    object: T;
  };
}

export class StaleTrialingSubscriptionStatusError extends Error {
  stripeSubscriptionStatus: string | null | undefined;

  constructor(stripeSubscriptionStatus: string | null | undefined) {
    super("Stripe subscription is no longer trialing.");
    this.name = "StaleTrialingSubscriptionStatusError";
    this.stripeSubscriptionStatus = stripeSubscriptionStatus;
  }
}

export class StripeSubscriptionRequiresManagementError extends Error {
  stripeSubscriptionStatus: string | null | undefined;

  constructor(stripeSubscriptionStatus: string | null | undefined) {
    super("This Stripe subscription must be managed in the billing portal.");
    this.name = "StripeSubscriptionRequiresManagementError";
    this.stripeSubscriptionStatus = stripeSubscriptionStatus;
  }
}

export function isStripeSubscriptionRequiresManagementError(
  error: unknown,
): error is StripeSubscriptionRequiresManagementError {
  return (
    error instanceof StripeSubscriptionRequiresManagementError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "StripeSubscriptionRequiresManagementError")
  );
}

export function isStaleTrialingSubscriptionStatusError(
  error: unknown,
): error is StaleTrialingSubscriptionStatusError {
  return (
    error instanceof StaleTrialingSubscriptionStatusError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name ===
        "StaleTrialingSubscriptionStatusError")
  );
}

const RECURRING_INCLUDED_CREDIT_BILLING_REASONS = new Set([
  "subscription_cycle",
]);

const LEGACY_INDIVIDUAL_PRICE_IDS = new Set([
  "price_1QIfnqGvliMKf4vHaDTMG2Mu",
  "price_1QIfnqGvliMKf4vHOeGHG69q",
  // Stripe test-mode fixture for staging legacy migration QA.
  "price_1TSMnnGvliMKf4vHrdn58Izi",
]);

const LEGACY_TEAM_PRICE_IDS = new Set(["price_1S6NRLGvliMKf4vHtFDiA07o"]);

const LEGACY_MIGRATION_PRICE_IDS = new Set([
  ...LEGACY_INDIVIDUAL_PRICE_IDS,
  ...LEGACY_TEAM_PRICE_IDS,
]);

const STRIPE_CHECKOUT_MAX_ADJUSTABLE_QUANTITY = 999_999;

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
  product?: string | { id?: string | null } | null;
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
  billing_trial_started_at: number | null;
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

function getOrgStub(env: Pick<StripeBillingEnv, "ORG">, orgId: string) {
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
    "BILLING_TRIAL_CREDIT_CENTS" | "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS"
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

function getDefaultTrialCreditCentsForPlan(
  plan: BillingPlan,
  seatCount: number,
): number {
  if (plan === "team") {
    return DEFAULT_TRIAL_CREDIT_CENTS;
  }
  return getIncludedCreditCentsForPlan(plan, seatCount);
}

function getTrialCreditCentsForPlan(
  env: Pick<StripeBillingEnv, "BILLING_TRIAL_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return getConfiguredCreditCents(
    env.BILLING_TRIAL_CREDIT_CENTS,
    getDefaultTrialCreditCentsForPlan(plan, seatCount),
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

function getStripePriceId(
  price: string | StripePriceSummary | null | undefined,
) {
  return typeof price === "string" ? price : (price?.id ?? null);
}

function getStripeProductId(price: StripePriceSummary | null | undefined) {
  const product = price?.product;
  if (!product) return null;
  if (typeof product === "string") return product;
  return product.id?.trim() || null;
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

function mapStripeSubscriptionBillingStatus(
  subscription: Pick<StripeSubscription, "status">,
): BillingStatus {
  return mapStripeSubscriptionStatus(subscription.status);
}

function isTerminalStripeSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  return (
    status === "canceled" ||
    NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.has(status ?? "")
  );
}

function stripeTimestampMs(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return seconds * 1000;
}

function getSubscriptionPeriodEndSeconds(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): number | null | undefined {
  const paidPriceIds = new Set(
    (["starter", "pro", "team"] as const)
      .map((plan) => getConfiguredSubscriptionPriceId(env, plan))
      .filter((priceId): priceId is string => Boolean(priceId)),
  );
  const items = subscription.items?.data ?? [];
  const paidItems = items.filter((item) =>
    paidPriceIds.has(getStripePriceId(item.price) ?? ""),
  );
  if (paidItems.length === 1 && paidItems[0].current_period_end) {
    return paidItems[0].current_period_end;
  }
  const itemPeriodEnds = items
    .map((item) => item.current_period_end)
    .filter(
      (periodEnd): periodEnd is number =>
        typeof periodEnd === "number" &&
        Number.isFinite(periodEnd) &&
        periodEnd > 0,
    );
  return itemPeriodEnds.length > 0
    ? Math.min(...itemPeriodEnds)
    : subscription.current_period_end;
}

function getSubscriptionCancellationDateMs(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): number | null {
  const seconds =
    subscription.cancel_at ??
    (subscription.cancel_at_period_end
      ? (getSubscriptionPeriodEndSeconds(env, subscription) ??
        subscription.trial_end)
      : null) ??
    (subscription.status === "canceled"
      ? (subscription.canceled_at ?? null)
      : null);
  return stripeTimestampMs(seconds);
}

function isSubscriptionCanceling(subscription: StripeSubscription): boolean {
  return (
    subscription.cancel_at_period_end === true ||
    Boolean(subscription.cancel_at) ||
    subscription.status === "canceled"
  );
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
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }
  assertStripeSecretKeyMatchesMode(secretKey, env.STRIPE_MODE);

  const headers = stripeAuthHeaders(secretKey);
  if (init.idempotencyKey?.trim()) {
    headers.set("Idempotency-Key", init.idempotencyKey.trim());
  }
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

function normalizeEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function getStripeCustomerId(
  customer: string | StripeCustomer | null | undefined,
): string | null {
  return typeof customer === "string" ? customer : (customer?.id ?? null);
}

function splitMultiValue(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[|;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePositiveIntegerOrNull(
  value: string | null | undefined,
): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseNonNegativeIntegerOrNull(
  value: string | null | undefined,
): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function parseLegacyMigrationCsv(
  rawValue: string,
): LegacyStripeMigrationCandidate[] {
  const lines = rawValue
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) =>
    header.trim().toLowerCase(),
  );
  const indexOf = (name: string) => headers.indexOf(name);
  const emailIndex = indexOf("email");
  const customerIndex = indexOf("customer_id");
  if (emailIndex < 0 || customerIndex < 0) return [];

  const subscriptionIdsIndex = indexOf("legacy_subscription_ids");
  const itemIdsIndex = indexOf("legacy_subscription_item_ids");
  const priceIdsIndex = indexOf("legacy_price_ids");
  const quantityIndex = indexOf("total_legacy_quantity");
  const activeCountIndex = indexOf("active_legacy_subscription_count");

  return lines.slice(1).flatMap((line) => {
    const values = parseCsvLine(line);
    const email = normalizeEmail(values[emailIndex]);
    const customerId = values[customerIndex]?.trim() ?? "";
    if (!email || !customerId) return [];
    return [
      {
        email,
        customerId,
        subscriptionIds: splitMultiValue(values[subscriptionIdsIndex]),
        subscriptionItemIds: splitMultiValue(values[itemIdsIndex]),
        legacyPriceIds: splitMultiValue(values[priceIdsIndex]),
        totalLegacyQuantity: parsePositiveIntegerOrNull(values[quantityIndex]),
        activeLegacySubscriptionCount:
          parseNonNegativeIntegerOrNull(values[activeCountIndex]) ?? 1,
      },
    ];
  });
}

function parseLegacyMigrationJson(
  rawValue: string,
): LegacyStripeMigrationCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (typeof entry === "string") {
      const email = normalizeEmail(entry);
      return email
        ? [
            {
              email,
              customerId: "",
              subscriptionIds: [],
              subscriptionItemIds: [],
              legacyPriceIds: [],
              totalLegacyQuantity: null,
              activeLegacySubscriptionCount: 1,
            },
          ]
        : [];
    }
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const email = normalizeEmail(String(record.email ?? ""));
    const customerId = String(
      record.customer_id ?? record.customerId ?? "",
    ).trim();
    if (!email || !customerId) return [];
    return [
      {
        email,
        customerId,
        subscriptionIds: Array.isArray(record.subscription_ids)
          ? record.subscription_ids.map(String)
          : splitMultiValue(String(record.legacy_subscription_ids ?? "")),
        subscriptionItemIds: Array.isArray(record.subscription_item_ids)
          ? record.subscription_item_ids.map(String)
          : splitMultiValue(String(record.legacy_subscription_item_ids ?? "")),
        legacyPriceIds: Array.isArray(record.legacy_price_ids)
          ? record.legacy_price_ids.map(String)
          : splitMultiValue(String(record.legacy_price_ids ?? "")),
        totalLegacyQuantity: parsePositiveIntegerOrNull(
          String(record.total_legacy_quantity ?? ""),
        ),
        activeLegacySubscriptionCount:
          parseNonNegativeIntegerOrNull(
            String(record.active_legacy_subscription_count ?? ""),
          ) ?? 1,
      },
    ];
  });
}

function getLegacyMigrationCandidates(
  env: Pick<StripeBillingEnv, "LEGACY_STRIPE_MIGRATION_CUSTOMERS">,
): LegacyStripeMigrationCandidate[] {
  const rawValue = env.LEGACY_STRIPE_MIGRATION_CUSTOMERS?.trim();
  if (!rawValue) return [];
  if (rawValue.startsWith("[")) {
    return parseLegacyMigrationJson(rawValue);
  }
  return parseLegacyMigrationCsv(rawValue);
}

function getLegacyMigrationCandidateForEmail(
  env: Pick<StripeBillingEnv, "LEGACY_STRIPE_MIGRATION_CUSTOMERS">,
  email: string | null | undefined,
): LegacyStripeMigrationCandidate | null {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  return (
    getLegacyMigrationCandidates(env).find(
      (candidate) => candidate.email === normalizedEmail,
    ) ?? null
  );
}

function getDefaultLegacyMigrationPlan(
  candidate: LegacyStripeMigrationCandidate | null,
): SubscriptionBillingPlan {
  if (
    candidate?.legacyPriceIds.some((priceId) =>
      LEGACY_TEAM_PRICE_IDS.has(priceId),
    )
  ) {
    return "team";
  }
  return "pro";
}

export function getLegacyStripeMigrationEligibility(args: {
  env: Pick<StripeBillingEnv, "LEGACY_STRIPE_MIGRATION_CUSTOMERS">;
  org: Organization;
  userEmail: string | null | undefined;
}): LegacyStripeMigrationEligibility | null {
  if (
    args.org.billing_status === "enterprise" ||
    args.org.billing_status === "active" ||
    args.org.billing_status === "trialing" ||
    args.org.billing_subscription_id
  ) {
    return null;
  }

  const candidate = getLegacyMigrationCandidateForEmail(
    args.env,
    args.userEmail,
  );
  if (!candidate?.customerId) return null;
  if (candidate.activeLegacySubscriptionCount < 1) return null;

  return {
    eligible: true,
    customerId: candidate.customerId,
    activeLegacySubscriptionCount: candidate.activeLegacySubscriptionCount,
    defaultPlan: getDefaultLegacyMigrationPlan(candidate),
  };
}

export async function getVerifiedLegacyStripeMigrationEligibility(args: {
  env: StripeBillingEnv;
  org: Organization;
  userEmail: string | null | undefined;
}): Promise<LegacyStripeMigrationEligibility | null> {
  const eligibility = getLegacyStripeMigrationEligibility(args);
  if (!eligibility) return null;

  const candidate = getLegacyMigrationCandidateForEmail(
    args.env,
    args.userEmail,
  );
  if (!candidate) return null;

  try {
    const subscriptions = await fetchLegacyCandidateSubscriptions(
      args.env,
      candidate,
    );
    const activeLegacySubscriptionCount =
      getActiveLegacySubscriptionCount(subscriptions);
    if (activeLegacySubscriptionCount < 1) return null;
    return {
      ...eligibility,
      activeLegacySubscriptionCount,
    };
  } catch (error) {
    console.error("[billing] failed to verify legacy migration eligibility", {
      orgId: args.org.id,
      customerId: candidate.customerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const BILLING_SETUP_PATHS = new Set([
  "/settings/organization/billing",
  "/settings/organization/usage",
]);

export type OrgBillingAccessState =
  | {
      kind: "ready";
      mode: "enterprise" | "subscription" | "byok" | "credits" | "selfhost";
      setupRouteAccessible: true;
    }
  | {
      kind: "setup_required";
      reason: "missing_llm_provider";
      setupRouteAccessible: boolean;
    };

export function isBillingSetupPath(pathname: string): boolean {
  return BILLING_SETUP_PATHS.has(pathname);
}

export function resolveOrgBillingAccess(args: {
  org:
    | Pick<
        Organization,
        | "billing_status"
        | "billing_credit_purchase_total_cents"
        | "billing_credit_grant_total_cents"
      >
    | null
    | undefined;
  llmProviderConfig?: unknown;
  pathname?: string;
  env?: SelfhostRuntimeEnv;
}): OrgBillingAccessState {
  const setupRouteAccessible = args.pathname
    ? isBillingSetupPath(args.pathname)
    : false;
  if (args.env && isSelfhostRuntime(args.env)) {
    return { kind: "ready", mode: "selfhost", setupRouteAccessible: true };
  }
  const org = args.org;
  if (org?.billing_status === "enterprise") {
    return { kind: "ready", mode: "enterprise", setupRouteAccessible: true };
  }
  if (
    org?.billing_status === "trialing" ||
    org?.billing_status === "active"
  ) {
    return { kind: "ready", mode: "subscription", setupRouteAccessible: true };
  }
  if (args.llmProviderConfig) {
    return { kind: "ready", mode: "byok", setupRouteAccessible: true };
  }

  const totalCreditsCents =
    (org?.billing_credit_purchase_total_cents ?? 0) +
    (org?.billing_credit_grant_total_cents ?? 0);
  if (totalCreditsCents > 0) {
    return { kind: "ready", mode: "credits", setupRouteAccessible: true };
  }

  return {
    kind: "setup_required",
    reason: "missing_llm_provider",
    setupRouteAccessible,
  };
}

export function isOrgBillingAccessReady(
  access: OrgBillingAccessState,
): access is Extract<OrgBillingAccessState, { kind: "ready" }> {
  return access.kind === "ready";
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
): Array<{
  plan: SubscriptionBillingPlan;
  priceId: string;
  limits: BillingPlanLimits;
}> {
  return (["starter", "pro", "team"] as SubscriptionBillingPlan[])
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
        plan: SubscriptionBillingPlan;
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

function validateCanonicalPaidPlanPrice(
  plan: SubscriptionBillingPlan,
  priceId: string,
  price: StripePriceSummary | null,
): CanonicalPaidPlanCatalogEntry {
  const advertisedAmount = getBillingPlanLimits(plan).monthlyPriceCents;
  const productId = getStripeProductId(price);
  if (
    !price ||
    price.id !== priceId ||
    price.active !== true ||
    advertisedAmount === null ||
    price.unit_amount !== advertisedAmount ||
    price.currency?.toLowerCase() !== "usd" ||
    price.recurring?.interval !== "month" ||
    (price.recurring.interval_count ?? 1) !== 1 ||
    !productId
  ) {
    throw new Error(
      `Stripe ${plan} price ${priceId} does not match the advertised subscription catalog requirements.`,
    );
  }
  return {
    plan,
    productId,
    priceId,
    unitAmount: price.unit_amount,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
  };
}

export async function loadCanonicalPaidPlanCatalog(
  env: StripeBillingEnv,
): Promise<CanonicalPaidPlanCatalogEntry[]> {
  return Promise.all(
    (["starter", "pro", "team"] as const).map(async (plan) => {
      const priceId = getConfiguredSubscriptionPriceId(env, plan);
      if (!priceId) throw new Error(`Stripe ${plan} subscription price is not configured`);
      return validateCanonicalPaidPlanPrice(
        plan,
        priceId,
        await fetchStripePriceSummary(env, priceId),
      );
    }),
  );
}

async function fetchStripeSubscription(
  env: StripeBillingEnv,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${subscriptionId}`,
  );
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

function getStripeSubscriptionItemForPlanChange(
  subscription: StripeSubscription,
  currentPriceId: string | null,
): StripeSubscriptionItem {
  const items = subscription.items?.data ?? [];
  const matchingItem = currentPriceId
    ? items.find((item) => getStripePriceId(item.price) === currentPriceId)
    : null;
  if (matchingItem?.id) return matchingItem;
  if (items.length === 1 && items[0]?.id) return items[0];
  throw new Error("Stripe subscription does not have a single plan item");
}

function getPlanFromConfiguredPrice(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
  priceId: string | null | undefined,
): BillingPlan | null {
  const trimmedPriceId = priceId?.trim();
  if (!trimmedPriceId) return null;
  for (const plan of ["starter", "pro", "team"] as const) {
    if (getConfiguredSubscriptionPriceId(env, plan) === trimmedPriceId) {
      return plan;
    }
  }
  return null;
}

function getSubscriptionPlanFromItems(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
  subscription: StripeSubscription,
): { plan: BillingPlan; item: StripeSubscriptionItem } | null {
  for (const item of subscription.items?.data ?? []) {
    const plan = getPlanFromConfiguredPrice(env, getStripePriceId(item.price));
    if (plan) return { plan, item };
  }
  return null;
}

function shouldSyncTeamSeats(org: Organization): boolean {
  return isTeamSeatBillingSyncable(org);
}

export async function getBillableTeamSeatCount(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  pendingReservedSeatDelta = 0,
): Promise<number | null> {
  const orgStub = getOrgStub(env as StripeBillingEnv, orgId);
  const org = await orgStub.getInfo();
  if (!org || getOrgBillingPlan(org) !== "team") return null;

  return getBillableTeamSeatCountForOrg(env, orgId, pendingReservedSeatDelta);
}

export async function getBillableTeamSeatCountForOrg(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  pendingReservedSeatDelta = 0,
): Promise<number> {
  const orgStub = getOrgStub(env as StripeBillingEnv, orgId);
  const [memberCount, invitations] = await Promise.all([
    orgStub.getMemberCount(),
    orgStub.getInvitations().catch(() => []),
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
    targetSeatCount?: number;
    itemUpdateIdempotencyKey?: string;
    prorationBehavior?: "create_prorations" | "always_invoice" | "none";
  } = {},
): Promise<Organization | null> {
  const orgStub = getOrgStub(env, orgId);
  const org = await orgStub.getInfo();
  if (!org) return null;
  if (!shouldSyncTeamSeats(org)) return org;

  const seatCount =
    options.targetSeatCount === undefined
      ? await getBillableTeamSeatCount(
          env,
          orgId,
          options.pendingReservedSeatDelta ?? 0,
        )
      : normalizeSeatCount("team", options.targetSeatCount);
  if (!seatCount) return org;

  const subscriptionId = org.billing_subscription_id?.trim();
  if (!subscriptionId) return org;

  const priceId = getConfiguredSubscriptionPriceId(env, "team");
  const subscription = await fetchStripeSubscription(env, subscriptionId);
  const item = getStripeSubscriptionItemForPlan(subscription, priceId);
  const currentSeatCount = normalizeSeatCount(
    "team",
    item.quantity ?? org.billing_seat_count,
  );

  if (seatCount !== currentSeatCount) {
    const isIncrease = seatCount > currentSeatCount;
    const prorationBehavior = isIncrease ? "always_invoice" : "none";
    if (
      options.prorationBehavior &&
      options.prorationBehavior !== prorationBehavior
    ) {
      throw new Error(
        `Unsafe Team seat proration behavior: expected ${prorationBehavior}.`,
      );
    }
    const itemBody = new URLSearchParams();
    itemBody.set("quantity", String(seatCount));
    itemBody.set("proration_behavior", prorationBehavior);
    if (isIncrease) {
      itemBody.set("payment_behavior", "error_if_incomplete");
    }
    const updatedItem = await stripeRequest<StripeSubscriptionItem>(
      env,
      `/subscription_items/${item.id}`,
      {
        method: "POST",
        body: itemBody,
        idempotencyKey: options.itemUpdateIdempotencyKey,
      },
    );
    if (
      typeof updatedItem.quantity !== "number" ||
      normalizeSeatCount("team", updatedItem.quantity) !== seatCount
    ) {
      throw new Error(
        "Stripe did not confirm the requested Team seat quantity.",
      );
    }
  }

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
  await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${subscriptionId}`,
    {
      method: "POST",
      body: subscriptionBody,
    },
  );

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
  return getBillingAccessSnapshotForOrg(org);
}

export function getBillingAccessSnapshotForOrg(
  org: Organization,
): OrgBillingAccessSnapshot {
  const effectiveStatus = normalizeBillingStatus(org.billing_status);
  const effectivePlan = normalizeBillingPlan(
    org.billing_plan,
    org.billing_status,
  );

  return {
    org_id: org.id,
    billing_status: effectiveStatus,
    billing_plan: effectivePlan,
    billing_seat_count: normalizeSeatCount(
      effectivePlan,
      org.billing_seat_count,
    ),
    billing_subscription_status: org.billing_subscription_status ?? null,
    billing_trial_started_at: org.billing_trial_started_at ?? null,
    billing_trial_ends_at: org.billing_trial_ends_at ?? null,
    billing_credit_purchase_total_cents:
      org.billing_credit_purchase_total_cents ?? 0,
    billing_credit_grant_total_cents: org.billing_credit_grant_total_cents ?? 0,
    billing_trial_credit_grant_cents: org.billing_trial_credit_grant_cents ?? 0,
    billing_trial_credit_granted_at:
      org.billing_trial_credit_granted_at ?? null,
    billing_free_credit_grant_cents: org.billing_free_credit_grant_cents ?? 0,
    billing_free_credit_granted_at: org.billing_free_credit_granted_at ?? null,
    billing_last_included_credit_invoice_id:
      org.billing_last_included_credit_invoice_id ?? null,
    billing_credit_usage_started_at:
      org.billing_credit_usage_started_at ?? null,
  };
}

async function fetchUsageLogSum(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  fromMs: number,
  toMs: number,
  chargeableOnly = false,
): Promise<UsageLogSumResponse> {
  return getOrgStub(env, orgId).getUsageLogSum(fromMs, toMs, chargeableOnly);
}

async function fetchLifetimeSpend(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
): Promise<OrgSpendResponse> {
  return getOrgStub(env, orgId).getUsageSpend();
}

export async function getOrgBillingOverview(
  env: StripeBillingEnv,
  org: Organization,
): Promise<OrgBillingOverview> {
  const snapshot = getBillingAccessSnapshotForOrg(org);

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

export function hasOrgUsedSubscriptionTrial(
  org: Pick<
    Organization,
    | "billing_trial_started_at"
    | "billing_trial_ends_at"
    | "billing_trial_credit_granted_at"
  >,
): boolean {
  return Boolean(
    org.billing_trial_started_at ||
    org.billing_trial_ends_at ||
    org.billing_trial_credit_granted_at,
  );
}

async function getLatestOrgInfo(
  env: StripeBillingEnv,
  org: Organization,
): Promise<Organization> {
  try {
    const orgNamespace = env.ORG;
    if (
      typeof orgNamespace?.idFromName !== "function" ||
      typeof orgNamespace?.get !== "function"
    ) {
      return org;
    }
    const latest = await getOrgStub(env, org.id).getInfo();
    return latest ?? org;
  } catch {
    return org;
  }
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
  const latestOrg = await getLatestOrgInfo(env, org);
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise orgs are billed outside Stripe Checkout");
  }
  const plan = normalizeBillingPlan(args.plan, latestOrg.billing_status);
  if (plan === "free" || plan === "payg" || plan === "enterprise") {
    throw new Error("This plan cannot be started through Stripe Checkout");
  }
  const priceId = getConfiguredSubscriptionPriceId(env, plan);
  if (!priceId) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }
  validateCanonicalPaidPlanPrice(
    plan,
    priceId,
    await fetchStripePriceSummary(env, priceId),
  );
  const seatCount = normalizeSeatCount(
    plan,
    args.seatCount ?? latestOrg.billing_seat_count ?? getMinimumSeats(plan),
  );
  const subscriptionIncludedCreditCents =
    getSubscriptionIncludedCreditCentsForPlan(env, plan, seatCount);

  const customerId = await ensureStripeCustomerForOrg(
    env,
    latestOrg,
    customerEmail,
  );
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
  body.set("metadata[trial_credit_cents]", "0");
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set(
    "metadata[initial_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set("line_items[0][price]", priceId);
  body.set("line_items[0][quantity]", String(seatCount));
  if (plan === "team") {
    body.set("line_items[0][adjustable_quantity][enabled]", "true");
    body.set(
      "line_items[0][adjustable_quantity][minimum]",
      String(seatCount),
    );
    body.set(
      "line_items[0][adjustable_quantity][maximum]",
      String(STRIPE_CHECKOUT_MAX_ADJUSTABLE_QUANTITY),
    );
  }
  body.set("subscription_data[metadata][org_id]", org.id);
  body.set("subscription_data[metadata][billing_plan]", plan);
  body.set("subscription_data[metadata][seat_count]", String(seatCount));
  body.set("subscription_data[metadata][trial_credit_cents]", "0");
  body.set(
    "subscription_data[metadata][subscription_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set(
    "subscription_data[metadata][initial_included_credit_cents]",
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

  const latestOrg = await getLatestOrgInfo(env, org);
  if (!canBuyCreditsForBillingState(latestOrg)) {
    throw new Error(
      "Choose Pay as you go or an active subscription before buying credits.",
    );
  }

  const customerId = await ensureStripeCustomerForOrg(
    env,
    latestOrg,
    customerEmail,
  );
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

export async function activatePayAsYouGoPlan(args: {
  env: StripeBillingEnv;
  org: Organization;
}): Promise<Organization> {
  const { env, org } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise orgs are billed outside Pay as you go.");
  }
  const subscriptionStatus = latestOrg.billing_subscription_status?.trim();
  const hasRecoverableSubscription =
    latestOrg.billing_subscription_id?.trim() &&
    (!subscriptionStatus ||
      !NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.has(subscriptionStatus));
  if (hasRecoverableSubscription) {
    throw new Error(
      "Cancel the current subscription before switching to Pay as you go.",
    );
  }

  const updated = await getOrgStub(env, latestOrg.id).updateBillingState({
    billing_status: "inactive",
    billing_plan: "payg",
    billing_seat_count: 1,
    billing_subscription_id: null,
    billing_subscription_status: null,
    billing_trial_started_at: latestOrg.billing_trial_started_at ?? null,
    billing_trial_ends_at: latestOrg.billing_trial_ends_at ?? null,
  });
  if (!updated) {
    throw new Error("Organization not found");
  }
  return updated;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getOrCreateBillingPortalConfiguration(
  env: StripeBillingEnv,
  mode: BillingPortalMode,
  suppliedCatalog?: CanonicalPaidPlanCatalogEntry[],
): Promise<string> {
  const catalog =
    mode === "management" ? [] : (suppliedCatalog ?? (await loadCanonicalPaidPlanCatalog(env)));
  const fingerprint = await sha256Hex(
    JSON.stringify({
      schema: BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION,
      mode,
      catalog: catalog.map(({ plan, productId, priceId, unitAmount }) => ({
        plan,
        productId,
        priceId,
        unitAmount,
      })),
      behavior: {
        allowedUpdates: mode === "management" ? [] : ["price", "quantity"],
        proration:
          mode === "upgrade"
            ? "always_invoice"
            : mode === "downgrade"
              ? "none"
              : null,
        cancellation: mode === "management" ? "at_period_end" : "disabled",
        billingCycleAnchor: mode === "management" ? null : "unchanged",
        trialUpdate: mode === "management" ? null : "continue_trial",
        adjustableQuantity: false,
      },
    }),
  );
  const cacheKey = `${BILLING_PORTAL_CONFIGURATION_KV_PREFIX}${mode}:${fingerprint}`;
  if (env.APP_KV) {
    const cached = await env.APP_KV.get(cacheKey).catch(() => null);
    if (cached?.trim()) return cached.trim();
  }

  const body = new URLSearchParams();
  body.set("business_profile[headline]", "Manage your camelAI subscription");
  body.set("features[invoice_history][enabled]", "true");
  body.set("features[payment_method_update][enabled]", "true");
  body.set("features[subscription_cancel][enabled]", mode === "management" ? "true" : "false");
  if (mode === "management") {
    body.set("features[subscription_cancel][mode]", "at_period_end");
    body.set("features[subscription_update][enabled]", "false");
  } else {
    body.set("features[subscription_update][enabled]", "true");
    body.append("features[subscription_update][default_allowed_updates][]", "price");
    body.append("features[subscription_update][default_allowed_updates][]", "quantity");
    body.set(
      "features[subscription_update][proration_behavior]",
      mode === "upgrade" ? "always_invoice" : "none",
    );
    body.set("features[subscription_update][billing_cycle_anchor]", "unchanged");
    body.set("features[subscription_update][trial_update_behavior]", "continue_trial");
    catalog.forEach((entry, index) => {
      const prefix = `features[subscription_update][products][${index}]`;
      body.set(`${prefix}[product]`, entry.productId);
      body.append(`${prefix}[prices][]`, entry.priceId);
      body.set(`${prefix}[adjustable_quantity][enabled]`, "false");
    });
  }
  const configuration = await stripeRequest<{ id?: string | null }>(
    env,
    "/billing_portal/configurations",
    {
      method: "POST",
      body,
      idempotencyKey: `camelai-billing-portal-v${BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION}:${mode}:${fingerprint}`,
    },
  );
  const configurationId = configuration.id?.trim();
  if (!configurationId) throw new Error("Stripe did not return a billing portal configuration.");
  if (env.APP_KV) await env.APP_KV.put(cacheKey, configurationId).catch(() => undefined);
  return configurationId;
}

async function verifySubscriptionCustomerOwnership(args: {
  env: StripeBillingEnv;
  org: Organization;
  subscription: StripeSubscription;
}): Promise<string> {
  const subscriptionOrgId = args.subscription.metadata?.org_id?.trim();
  if (subscriptionOrgId && subscriptionOrgId !== args.org.id) {
    throw new Error(
      "Stripe subscription does not belong to this organization.",
    );
  }
  const customerId = getStripeCustomerId(args.subscription.customer);
  if (!customerId)
    throw new Error("Stripe subscription does not have a customer.");
  const cachedCustomerId = args.org.billing_customer_id?.trim() || null;
  if (!cachedCustomerId || cachedCustomerId !== customerId) {
    const metadata = await fetchStripeCustomerMetadata(args.env, customerId);
    if (resolveOrgIdFromStripeCustomerMetadata(metadata) !== args.org.id) {
      throw new Error("Stripe subscription customer does not belong to this organization.");
    }
  }
  if (cachedCustomerId !== customerId) {
    await getOrgStub(args.env, args.org.id).updateBillingState({
      billing_customer_id: customerId,
    });
  }
  return customerId;
}

export async function createBillingPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
}): Promise<string> {
  const { env, org, customerEmail, returnUrl } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  const customerId = subscriptionId
    ? await (async () => {
        const subscription = await fetchStripeSubscription(env, subscriptionId);
        if (isTerminalStripeSubscriptionStatus(subscription.status)) {
          throw new Error("This organization does not have a recoverable Stripe subscription.");
        }
        return verifySubscriptionCustomerOwnership({ env, org: latestOrg, subscription });
      })()
    : await ensureStripeCustomerForOrg(env, latestOrg, customerEmail);
  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  body.set("configuration", await getOrCreateBillingPortalConfiguration(env, "management"));

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

export type StripeCancellationPortalResult =
  | {
      kind: "portal";
      billingPortalUrl: string;
    }
  | {
      kind: "already_scheduled";
      cancellationDateMs: number | null;
      subscriptionStatus: string;
    };

function stripeCancellationScheduledResult(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): StripeCancellationPortalResult {
  return {
    kind: "already_scheduled",
    cancellationDateMs: getSubscriptionCancellationDateMs(env, subscription),
    subscriptionStatus: subscription.status,
  };
}

async function bestEffortSyncCancelingStripeSubscription(args: {
  env: StripeBillingEnv;
  subscription: StripeSubscription;
}): Promise<void> {
  await syncOrgSubscriptionFromStripe(args.env, args.subscription).catch(
    (error) => {
      console.error("[billing] failed to sync canceling Stripe subscription", {
        subscriptionId: args.subscription.id,
        stripeStatus: args.subscription.status,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export async function createSubscriptionCancellationPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
  afterCompletionReturnUrl?: string;
}): Promise<StripeCancellationPortalResult> {
  const { env, org, returnUrl } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  if (!subscriptionId) {
    throw new Error("This organization does not have a Stripe subscription.");
  }
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise organizations are billed outside Stripe.");
  }

  const subscription = await fetchStripeSubscription(env, subscriptionId);
  if (isSubscriptionCanceling(subscription)) {
    await bestEffortSyncCancelingStripeSubscription({ env, subscription });
    return stripeCancellationScheduledResult(env, subscription);
  }

  const customerId = await verifySubscriptionCustomerOwnership({
    env,
    org: latestOrg,
    subscription,
  });

  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  body.set("flow_data[type]", "subscription_cancel");
  body.set("flow_data[subscription_cancel][subscription]", subscriptionId);
  body.set("flow_data[after_completion][type]", "redirect");
  body.set(
    "flow_data[after_completion][redirect][return_url]",
    args.afterCompletionReturnUrl ?? returnUrl,
  );
  body.set("configuration", await getOrCreateBillingPortalConfiguration(env, "management"));

  try {
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

    return { kind: "portal", billingPortalUrl: session.url };
  } catch (error) {
    const refreshedSubscription = await fetchStripeSubscription(
      env,
      subscriptionId,
    ).catch((refreshError) => {
      console.error(
        "[billing] failed to refresh subscription after cancellation portal failure",
        {
          orgId: latestOrg.id,
          subscriptionId,
          error:
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
        },
      );
      return null;
    });

    if (refreshedSubscription && isSubscriptionCanceling(refreshedSubscription)) {
      await bestEffortSyncCancelingStripeSubscription({
        env,
        subscription: refreshedSubscription,
      });
      return stripeCancellationScheduledResult(env, refreshedSubscription);
    }

    throw error;
  }
}

export async function createSubscriptionUpdatePortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
  plan: SubscriptionBillingPlan;
  seatCount?: number | null;
}): Promise<string> {
  const { env, org, returnUrl, plan } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  if (!subscriptionId) {
    throw new Error("This organization does not have a Stripe subscription.");
  }
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise organizations are billed outside Stripe.");
  }

  const [catalog, subscription] = await Promise.all([
    loadCanonicalPaidPlanCatalog(env),
    fetchStripeSubscription(env, subscriptionId),
  ]);
  if (
    subscription.status !== "active" ||
    subscription.cancel_at_period_end === true ||
    Boolean(subscription.cancel_at)
  ) {
    throw new StripeSubscriptionRequiresManagementError(subscription.status);
  }
  const customerId = await verifySubscriptionCustomerOwnership({
    env,
    org: latestOrg,
    subscription,
  });
  const item = getStripeSubscriptionItemForPlanChange(subscription, null);
  const currentEntry = catalog.find((entry) => entry.priceId === getStripePriceId(item.price));
  const targetEntry = catalog.find((entry) => entry.plan === plan);
  if (!currentEntry) {
    throw new Error("Stripe subscription item is not in the configured paid-plan catalog.");
  }
  if (!targetEntry) throw new Error(`Stripe ${plan} subscription price is not configured`);
  const seatCount =
    plan === "team"
      ? await getBillableTeamSeatCountForOrg(env, latestOrg.id)
      : getMinimumSeats(plan);
  const currentSeatCount = normalizeSeatCount(
    currentEntry.plan,
    item.quantity ?? getMinimumSeats(currentEntry.plan),
  );
  const mode: BillingPortalMode =
    targetEntry.unitAmount * seatCount > currentEntry.unitAmount * currentSeatCount
      ? "upgrade"
      : "downgrade";
  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  body.set("configuration", await getOrCreateBillingPortalConfiguration(env, mode, catalog));
  body.set("flow_data[type]", "subscription_update_confirm");
  body.set("flow_data[subscription_update_confirm][subscription]", subscriptionId);
  body.set("flow_data[subscription_update_confirm][items][0][id]", item.id);
  body.set("flow_data[subscription_update_confirm][items][0][price]", targetEntry.priceId);
  body.set("flow_data[subscription_update_confirm][items][0][quantity]", String(seatCount));
  body.set("flow_data[after_completion][type]", "redirect");
  body.set("flow_data[after_completion][redirect][return_url]", returnUrl);

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

export async function updateTrialingStripeSubscriptionPlan(args: {
  env: StripeBillingEnv;
  org: Organization;
  plan: SubscriptionBillingPlan;
  seatCount?: number | null;
}): Promise<Organization> {
  const { env, org, plan } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise organizations are billed outside Stripe.");
  }
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  if (!subscriptionId) {
    throw new Error("This organization does not have a Stripe subscription.");
  }
  const priceId = getConfiguredSubscriptionPriceId(env, plan);
  if (!priceId) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }

  const subscription = await fetchStripeSubscription(env, subscriptionId);
  if (subscription.status !== "trialing") {
    await syncOrgSubscriptionFromStripe(env, subscription).catch((error) => {
      console.error("[billing] failed to sync stale trialing subscription", {
        orgId: latestOrg.id,
        subscriptionId,
        stripeStatus: subscription.status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throw new StaleTrialingSubscriptionStatusError(subscription.status);
  }
  if (subscription.cancel_at_period_end === true) {
    await syncOrgSubscriptionFromStripe(env, subscription).catch((error) => {
      console.error("[billing] failed to sync canceled trialing subscription", {
        orgId: latestOrg.id,
        subscriptionId,
        stripeStatus: subscription.status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throw new StaleTrialingSubscriptionStatusError(subscription.status);
  }

  const seatCount = normalizeSeatCount(
    plan,
    args.seatCount ?? latestOrg.billing_seat_count ?? getMinimumSeats(plan),
  );
  const currentPlan = getOrgBillingPlan(latestOrg);
  const currentPriceId =
    currentPlan === "free" ||
    currentPlan === "payg" ||
    currentPlan === "enterprise"
      ? null
      : getConfiguredSubscriptionPriceId(env, currentPlan);
  const item = getStripeSubscriptionItemForPlanChange(
    subscription,
    currentPriceId,
  );
  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    plan,
    seatCount,
  );
  const trialCreditCents =
    parsePositiveInteger(subscription.metadata?.trial_credit_cents) ??
    (latestOrg.billing_trial_credit_grant_cents > 0
      ? latestOrg.billing_trial_credit_grant_cents
      : getTrialCreditCentsForPlan(env, plan, seatCount));

  const body = new URLSearchParams();
  body.set("items[0][id]", item.id);
  body.set("items[0][price]", priceId);
  body.set("items[0][quantity]", String(seatCount));
  body.set("proration_behavior", "none");
  body.set("metadata[org_id]", latestOrg.id);
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set("metadata[trial_credit_cents]", String(trialCreditCents));
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );

  const updatedSubscription = await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${subscriptionId}`,
    {
      method: "POST",
      body,
    },
  );

  const synced = await syncOrgSubscriptionFromStripe(env, updatedSubscription);
  if (synced) return synced;

  const customerId =
    getStripeCustomerId(updatedSubscription.customer) ??
    getStripeCustomerId(subscription.customer) ??
    latestOrg.billing_customer_id ??
    null;
  const updatedOrg = await getOrgStub(env, latestOrg.id).updateBillingState({
    billing_status: mapStripeSubscriptionBillingStatus(updatedSubscription),
    billing_plan: plan,
    billing_seat_count: seatCount,
    billing_customer_id: customerId,
    billing_subscription_id: updatedSubscription.id,
    billing_subscription_status: updatedSubscription.status ?? null,
    billing_trial_started_at: updatedSubscription.trial_start
      ? updatedSubscription.trial_start * 1000
      : latestOrg.billing_trial_started_at,
    billing_trial_ends_at: updatedSubscription.trial_end
      ? updatedSubscription.trial_end * 1000
      : latestOrg.billing_trial_ends_at,
  });
  if (!updatedOrg) {
    throw new Error("Failed to update organization billing state.");
  }
  return updatedOrg;
}

interface LegacySubscriptionSelection {
  subscription: StripeSubscription;
  item: StripeSubscriptionItem;
  priceId: string;
}

function isLegacyMigrationSubscriptionStatus(
  status: string | null | undefined,
) {
  return status === "active" || status === "past_due";
}

function getLegacyMigrationSelection(
  subscriptions: StripeSubscription[],
  candidate: LegacyStripeMigrationCandidate,
): LegacySubscriptionSelection | null {
  const candidateSubscriptionIds = new Set(candidate.subscriptionIds);
  const candidateItemIds = new Set(candidate.subscriptionItemIds);

  const selections: LegacySubscriptionSelection[] = [];
  for (const subscription of subscriptions) {
    if (!isLegacyMigrationSubscriptionStatus(subscription.status)) continue;
    if (
      candidateSubscriptionIds.size > 0 &&
      !candidateSubscriptionIds.has(subscription.id)
    ) {
      continue;
    }
    for (const item of subscription.items?.data ?? []) {
      if (candidateItemIds.size > 0 && !candidateItemIds.has(item.id)) {
        continue;
      }
      const priceId = getStripePriceId(item.price);
      if (!priceId || !LEGACY_MIGRATION_PRICE_IDS.has(priceId)) continue;
      selections.push({ subscription, item, priceId });
    }
  }

  return (
    selections.find((selection) =>
      LEGACY_TEAM_PRICE_IDS.has(selection.priceId),
    ) ??
    selections[0] ??
    null
  );
}

async function fetchLegacyCandidateSubscriptions(
  env: StripeBillingEnv,
  candidate: LegacyStripeMigrationCandidate,
): Promise<StripeSubscription[]> {
  if (candidate.subscriptionIds.length > 0) {
    return Promise.all(
      candidate.subscriptionIds.map((subscriptionId) =>
        fetchStripeSubscription(env, subscriptionId),
      ),
    );
  }

  const params = new URLSearchParams();
  params.set("customer", candidate.customerId);
  params.set("status", "all");
  params.set("limit", "100");
  const response = await stripeRequest<StripeListResponse<StripeSubscription>>(
    env,
    `/subscriptions?${params.toString()}`,
  );
  return response.data ?? [];
}

function getActiveLegacySubscriptionCount(
  subscriptions: StripeSubscription[],
): number {
  const activeLegacySubscriptionIds = new Set<string>();
  for (const subscription of subscriptions) {
    if (!isLegacyMigrationSubscriptionStatus(subscription.status)) continue;
    const hasLegacyItem = (subscription.items?.data ?? []).some((item) => {
      const priceId = getStripePriceId(item.price);
      return Boolean(priceId && LEGACY_MIGRATION_PRICE_IDS.has(priceId));
    });
    if (hasLegacyItem) {
      activeLegacySubscriptionIds.add(subscription.id);
    }
  }
  return activeLegacySubscriptionIds.size;
}

interface PreparedLegacyStripeMigration {
  orgStub: DurableObjectStub<OrgDO>;
  latestOrg: Organization;
  candidate: LegacyStripeMigrationCandidate;
  selection: LegacySubscriptionSelection;
  plan: SubscriptionBillingPlan;
  priceId: string;
  seatCount: number;
  includedCreditCents: number;
}

async function prepareLegacyStripeMigration(args: {
  env: StripeBillingEnv;
  org: Organization;
  userEmail: string | null | undefined;
  plan: BillingPlan;
  seatCount?: number | null;
}): Promise<PreparedLegacyStripeMigration> {
  const { env, org, userEmail } = args;
  const candidate = getLegacyMigrationCandidateForEmail(env, userEmail);
  if (!candidate?.customerId) {
    throw new Error(
      "This account is not eligible for legacy billing migration.",
    );
  }
  if (candidate.activeLegacySubscriptionCount < 1) {
    throw new Error(
      "This account is not eligible for legacy billing migration.",
    );
  }
  const plan = normalizeBillingPlan(args.plan, org.billing_status);
  if (plan === "free" || plan === "payg" || plan === "enterprise") {
    throw new Error("Choose Starter, Pro, or Team for migration.");
  }

  const priceId = getConfiguredSubscriptionPriceId(env, plan);
  if (!priceId) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }

  const orgStub = getOrgStub(env, org.id);
  const latestOrg = (await orgStub.getInfo()) ?? org;
  if (
    latestOrg.billing_status === "enterprise" ||
    latestOrg.billing_status === "active" ||
    latestOrg.billing_status === "trialing" ||
    latestOrg.billing_subscription_id
  ) {
    throw new Error("This organization already has v2 billing.");
  }

  const subscriptions = await fetchLegacyCandidateSubscriptions(env, candidate);
  if (getActiveLegacySubscriptionCount(subscriptions) > 1) {
    throw new Error(
      "This account has multiple active legacy subscriptions. Contact support to migrate without double billing.",
    );
  }
  const selection = getLegacyMigrationSelection(subscriptions, candidate);
  if (!selection) {
    throw new Error(
      "No active legacy subscription was found for this account.",
    );
  }

  const seatCount = normalizeSeatCount(
    plan,
    plan === "team"
      ? (args.seatCount ??
          selection.item.quantity ??
          candidate.totalLegacyQuantity ??
          getMinimumSeats("team"))
      : 1,
  );
  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    plan,
    seatCount,
  );

  return {
    orgStub,
    latestOrg,
    candidate,
    selection,
    plan,
    priceId,
    seatCount,
    includedCreditCents,
  };
}

function getPlanMonthlyPriceCents(
  plan: SubscriptionBillingPlan,
  seatCount: number,
): number | null {
  const monthlyPriceCents = BILLING_PLAN_LIMITS[plan].monthlyPriceCents;
  if (typeof monthlyPriceCents !== "number") return null;
  return monthlyPriceCents * (plan === "team" ? seatCount : 1);
}

async function createLegacyStripeMigrationPreview(args: {
  env: StripeBillingEnv;
  selection: LegacySubscriptionSelection;
  candidate: LegacyStripeMigrationCandidate;
  plan: SubscriptionBillingPlan;
  priceId: string;
  seatCount: number;
  includedCreditCents: number;
}): Promise<LegacyStripeMigrationPreview> {
  const params = new URLSearchParams();
  params.set("customer", args.candidate.customerId);
  params.set("subscription", args.selection.subscription.id);
  params.set("subscription_details[proration_behavior]", "always_invoice");
  params.set("subscription_details[items][0][id]", args.selection.item.id);
  params.set("subscription_details[items][0][price]", args.priceId);
  params.set(
    "subscription_details[items][0][quantity]",
    String(args.seatCount),
  );

  const invoice = await stripeRequest<StripeInvoice>(
    args.env,
    `/invoices/create_preview?${params.toString()}`,
  );
  const lines = invoice.lines?.data ?? [];
  const prorationLines = lines.filter(isStripeProrationLine);
  const legacyCreditCents = Math.abs(
    prorationLines
      .filter((line) => (line.amount ?? 0) < 0)
      .reduce((sum, line) => sum + (line.amount ?? 0), 0),
  );
  const newPlanProrationCents = prorationLines
    .filter((line) => (line.amount ?? 0) > 0)
    .reduce((sum, line) => sum + (line.amount ?? 0), 0);

  return {
    plan: args.plan,
    seatCount: args.seatCount,
    currency:
      invoice.lines?.data?.find((line) => line.currency)?.currency ??
      "usd",
    monthlyPriceCents: getPlanMonthlyPriceCents(args.plan, args.seatCount),
    amountDueTodayCents: invoice.amount_due ?? invoice.total ?? null,
    legacyCreditCents: legacyCreditCents > 0 ? legacyCreditCents : null,
    newPlanProrationCents:
      newPlanProrationCents > 0 ? newPlanProrationCents : null,
    includedCreditCents: args.includedCreditCents,
  };
}

export async function migrateLegacyStripeSubscription(args: {
  env: StripeBillingEnv;
  org: Organization;
  userEmail: string | null | undefined;
  plan: BillingPlan;
  seatCount?: number | null;
}): Promise<Organization> {
  const { env, org } = args;
  const {
    orgStub,
    latestOrg,
    candidate,
    selection,
    plan,
    priceId,
    seatCount,
    includedCreditCents,
  } = await prepareLegacyStripeMigration(args);
  const idempotencyKeyPrefix = `legacy-migration:${org.id}:${selection.subscription.id}:${plan}`;

  const customerBody = new URLSearchParams();
  customerBody.set(`metadata[${LEGACY_MIGRATION_META_ORG_ID}]`, org.id);
  customerBody.set(
    `metadata[${LEGACY_MIGRATION_META_SUBSCRIPTION_ID}]`,
    selection.subscription.id,
  );
  customerBody.set(`metadata[${LEGACY_MIGRATION_META_TARGET_PLAN}]`, plan);
  customerBody.set(`metadata[${LEGACY_MIGRATION_META_SEAT_COUNT}]`, String(seatCount));
  customerBody.set(
    `metadata[${LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS}]`,
    String(includedCreditCents),
  );
  customerBody.set(`metadata[${LEGACY_MIGRATION_META_SOURCE_PRICE_ID}]`, selection.priceId);
  await stripeRequest<StripeCustomer>(env, `/customers/${candidate.customerId}`, {
    method: "POST",
    body: customerBody,
  });

  const body = new URLSearchParams();
  body.set("items[0][id]", selection.item.id);
  body.set("items[0][price]", priceId);
  body.set("items[0][quantity]", String(seatCount));
  body.set("proration_behavior", "always_invoice");
  body.set("metadata[org_id]", org.id);
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set("metadata[trial_credit_cents]", "0");
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );
  body.set("metadata[migrated_from_legacy_customer_id]", candidate.customerId);
  body.set(
    "metadata[migrated_from_legacy_subscription_id]",
    selection.subscription.id,
  );
  body.set("metadata[migrated_from_legacy_price_id]", selection.priceId);
  body.set("metadata[migrated_to_v2_at]", String(Date.now()));

  const updatedSubscription = await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${selection.subscription.id}`,
    {
      method: "POST",
      body,
      idempotencyKey: `${idempotencyKeyPrefix}:subscription-update`,
    },
  );

  const synced =
    (await syncOrgSubscriptionFromStripe(env, updatedSubscription)) ??
    (await orgStub.updateBillingState({
      billing_status: mapStripeSubscriptionBillingStatus(updatedSubscription),
      billing_plan: plan,
      billing_seat_count: seatCount,
      billing_customer_id: candidate.customerId,
      billing_subscription_id: updatedSubscription.id,
      billing_subscription_status: updatedSubscription.status,
    }));

  return synced ?? latestOrg;
}

export async function createLegacyStripeMigrationPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  userEmail: string | null | undefined;
  returnUrl: string;
  plan: BillingPlan;
  seatCount?: number | null;
}): Promise<{
  billingPortalUrl: string;
  preview: LegacyStripeMigrationPreview | null;
}> {
  const { env } = args;
  const {
    latestOrg,
    orgStub,
    candidate,
    selection,
    plan,
    priceId,
    seatCount,
    includedCreditCents,
  } = await prepareLegacyStripeMigration(args);

  await orgStub
    .updateBillingState({ billing_customer_id: candidate.customerId })
    .catch((error) => {
      console.error("[billing] failed to store legacy migration customer id", {
        orgId: latestOrg.id,
        customerId: candidate.customerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  const customerBody = new URLSearchParams();
  customerBody.set(`metadata[${LEGACY_MIGRATION_META_ORG_ID}]`, latestOrg.id);
  customerBody.set(
    `metadata[${LEGACY_MIGRATION_META_SUBSCRIPTION_ID}]`,
    selection.subscription.id,
  );
  customerBody.set(`metadata[${LEGACY_MIGRATION_META_TARGET_PLAN}]`, plan);
  customerBody.set(
    `metadata[${LEGACY_MIGRATION_META_SEAT_COUNT}]`,
    String(seatCount),
  );
  customerBody.set(
    `metadata[${LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS}]`,
    String(includedCreditCents),
  );
  customerBody.set(
    `metadata[${LEGACY_MIGRATION_META_SOURCE_PRICE_ID}]`,
    selection.priceId,
  );
  await stripeRequest<StripeCustomer>(
    env,
    `/customers/${candidate.customerId}`,
    {
      method: "POST",
      body: customerBody,
    },
  );

  const preview = await createLegacyStripeMigrationPreview({
    env,
    candidate,
    selection,
    plan,
    priceId,
    seatCount,
    includedCreditCents,
  }).catch((error) => {
    console.error("[billing] failed to preview legacy migration invoice", {
      orgId: latestOrg.id,
      customerId: candidate.customerId,
      subscriptionId: selection.subscription.id,
      plan,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  const body = new URLSearchParams();
  body.set("customer", candidate.customerId);
  body.set("return_url", args.returnUrl);
  body.set("flow_data[type]", "subscription_update_confirm");
  body.set(
    "flow_data[subscription_update_confirm][subscription]",
    selection.subscription.id,
  );
  body.set(
    "flow_data[subscription_update_confirm][items][0][id]",
    selection.item.id,
  );
  body.set("flow_data[subscription_update_confirm][items][0][price]", priceId);
  body.set(
    "flow_data[subscription_update_confirm][items][0][quantity]",
    String(seatCount),
  );
  body.set("flow_data[after_completion][type]", "redirect");
  body.set(
    "flow_data[after_completion][redirect][return_url]",
    args.returnUrl,
  );
  body.set(
    "configuration",
    await getOrCreateBillingPortalConfiguration(env, "upgrade"),
  );

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

  return { billingPortalUrl: session.url, preview };
}

async function fetchStripeCustomerMetadata(
  env: StripeBillingEnv,
  customerId: string | null | undefined,
): Promise<Record<string, string> | null> {
  const trimmedCustomerId = customerId?.trim();
  if (!trimmedCustomerId) return null;

  const customer = await stripeRequest<StripeCustomer>(
    env,
    `/customers/${trimmedCustomerId}`,
  );
  return customer.metadata ?? null;
}

function resolveOrgIdFromStripeCustomerMetadata(
  metadata: Record<string, string> | null | undefined,
): string | null {
  return metadata?.org_id?.trim() || null;
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

async function bestEffortSyncStripeSubscriptionBillingMetadata(args: {
  env: StripeBillingEnv;
  subscription: StripeSubscription;
  orgId: string;
  plan: BillingPlan;
  seatCount: number;
}): Promise<void> {
  const { env, subscription, orgId, plan, seatCount } = args;
  if (plan === "free" || plan === "payg" || plan === "enterprise") return;

  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    plan,
    seatCount,
  );
  const metadata = subscription.metadata ?? {};
  if (
    metadata.org_id === orgId &&
    metadata.billing_plan === plan &&
    metadata.seat_count === String(seatCount) &&
    metadata.subscription_included_credit_cents === String(includedCreditCents)
  ) {
    return;
  }

  const body = new URLSearchParams();
  body.set("metadata[org_id]", orgId);
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );

  try {
    await stripeRequest<StripeSubscription>(
      env,
      `/subscriptions/${subscription.id}`,
      {
        method: "POST",
        body,
      },
    );
  } catch (error) {
    console.error("[billing] failed to sync Stripe subscription metadata", {
      orgId,
      subscriptionId: subscription.id,
      plan,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface PendingLegacyMigrationCustomerMetadata {
  orgId: string;
  subscriptionId: string;
  targetPlan: BillingPlan;
  includedCreditCents: number;
  seatCount: number;
}

function getPendingLegacyMigrationCustomerMetadata(
  metadata: Record<string, string> | null | undefined,
): PendingLegacyMigrationCustomerMetadata | null {
  const orgId =
    metadata?.[LEGACY_MIGRATION_META_ORG_ID]?.trim() ||
    metadata?.pending_legacy_migration_org_id?.trim();
  const subscriptionId =
    metadata?.[LEGACY_MIGRATION_META_SUBSCRIPTION_ID]?.trim() ||
    metadata?.pending_legacy_migration_subscription_id?.trim();
  if (!orgId || !subscriptionId) return null;
  const targetPlan = normalizeBillingPlan(
    metadata?.[LEGACY_MIGRATION_META_TARGET_PLAN] ||
      metadata?.pending_legacy_migration_target_plan,
  );
  if (
    targetPlan === "free" ||
    targetPlan === "payg" ||
    targetPlan === "enterprise"
  ) {
    return null;
  }
  return {
    orgId,
    subscriptionId,
    targetPlan,
    includedCreditCents:
      parsePositiveInteger(
        metadata?.[LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS] ||
          metadata?.pending_legacy_migration_included_credit_cents,
      ) ?? 0,
    seatCount:
      parsePositiveInteger(
        metadata?.[LEGACY_MIGRATION_META_SEAT_COUNT] ||
          metadata?.pending_legacy_migration_seat_count,
      ) ?? getMinimumSeats(targetPlan),
  };
}

async function bestEffortClearPendingLegacyMigrationCustomerMetadata(args: {
  env: StripeBillingEnv;
  customerId: string | null | undefined;
  orgId: string;
}): Promise<void> {
  const trimmedCustomerId = args.customerId?.trim();
  if (!trimmedCustomerId) return;

  const body = new URLSearchParams();
  body.set("metadata[org_id]", args.orgId);
  body.set(`metadata[${LEGACY_MIGRATION_META_ORG_ID}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_SUBSCRIPTION_ID}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_TARGET_PLAN}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_SEAT_COUNT}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_SOURCE_PRICE_ID}]`, "");
  body.set("metadata[pending_legacy_migration_org_id]", "");
  body.set("metadata[pending_legacy_migration_subscription_id]", "");
  body.set("metadata[pending_legacy_migration_target_plan]", "");
  body.set("metadata[pending_legacy_migration_seat_count]", "");
  body.set("metadata[pending_legacy_migration_source_price_id]", "");

  try {
    await stripeRequest<StripeCustomer>(
      args.env,
      `/customers/${trimmedCustomerId}`,
      {
        method: "POST",
        body,
      },
    );
  } catch (error) {
    console.error(
      "[billing] failed to clear legacy migration customer metadata",
      {
        orgId: args.orgId,
        customerId: trimmedCustomerId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function syncOrgSubscriptionFromStripe(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): Promise<Organization | null> {
  const directOrgId = subscription.metadata?.org_id?.trim();
  const customerId = getStripeCustomerId(subscription.customer);
  let customerMetadata =
    typeof subscription.customer === "object"
      ? (subscription.customer?.metadata ?? null)
      : null;
  if (!directOrgId && customerId && !customerMetadata) {
    customerMetadata = await fetchStripeCustomerMetadata(env, customerId);
  }
  const itemPlan = getSubscriptionPlanFromItems(env, subscription);
  const pendingLegacyMigration =
    getPendingLegacyMigrationCustomerMetadata(customerMetadata);
  const pendingLegacyMigrationOrgId =
    pendingLegacyMigration &&
    pendingLegacyMigration.subscriptionId === subscription.id &&
    itemPlan &&
    pendingLegacyMigration.targetPlan === itemPlan.plan
      ? pendingLegacyMigration.orgId
      : null;
  const orgId =
    directOrgId ||
    pendingLegacyMigrationOrgId ||
    resolveOrgIdFromStripeCustomerMetadata(customerMetadata);
  if (!orgId) {
    return null;
  }

  const orgStub = getOrgStub(env, orgId);
  const existing = await orgStub.getInfo();
  if (!existing) return null;

  const nextStatus = mapStripeSubscriptionBillingStatus(subscription);
  const shouldClearStripeSubscription = isTerminalStripeSubscriptionStatus(
    subscription.status,
  );
  const shouldUsePayAsYouGoPlan =
    shouldClearStripeSubscription || nextStatus === "canceled";
  const nextBillingStatus =
    existing.billing_status === "enterprise"
      ? "enterprise"
      : shouldUsePayAsYouGoPlan
        ? "inactive"
        : nextStatus;
  const nextPlan =
    existing.billing_status === "enterprise"
      ? "enterprise"
      : shouldUsePayAsYouGoPlan
        ? "payg"
      : (itemPlan?.plan ??
        getMetadataBillingPlan(subscription.metadata, nextStatus));
  const subscriptionSeatQuantity =
    itemPlan?.item.quantity ??
    getStripeSubscriptionSeatQuantity(
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
  await bestEffortSyncStripeSubscriptionBillingMetadata({
    env,
    subscription,
    orgId,
    plan: nextPlan,
    seatCount,
  });

  const result = await orgStub.syncSubscriptionBillingState(
    {
      billing_status: nextBillingStatus,
      billing_plan: nextPlan,
      billing_seat_count: seatCount,
      billing_customer_id: customerId,
      billing_subscription_id:
        shouldClearStripeSubscription ? null : subscription.id,
      billing_subscription_status:
        shouldClearStripeSubscription ? null : (subscription.status ?? null),
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

export function getInvoiceSubscriptionId(invoice: StripeInvoice): string | null {
  const subscription =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  return typeof subscription === "string" ? subscription : (subscription?.id ?? null);
}

export function getInvoiceSubscriptionMetadata(
  invoice: StripeInvoice,
): Record<string, string> | null | undefined {
  return (
    invoice.parent?.subscription_details?.metadata ||
    invoice.subscription_details?.metadata ||
    (typeof invoice.subscription === "object" ? invoice.subscription?.metadata : null)
  );
}

export function getInvoiceLinePriceId(line: StripeInvoiceLine): string | null {
  return getStripePriceId(line.pricing?.price_details?.price ?? line.price);
}

export function isStripeProrationLine(line: StripeInvoiceLine): boolean {
  return Boolean(line.proration || line.parent?.subscription_item_details?.proration);
}

export function isRecurringSubscriptionInvoice(
  invoice: StripeInvoice,
): boolean {
  return RECURRING_INCLUDED_CREDIT_BILLING_REASONS.has(
    invoice.billing_reason ?? "",
  );
}

function getInvoiceMetadata(
  invoice: StripeInvoice,
): Record<string, string> | null | undefined {
  return (
    getInvoiceSubscriptionMetadata(invoice) ||
    invoice.metadata
  );
}

function isPaidInvoice(invoice: StripeInvoice): boolean {
  return invoice.status === "paid";
}

export interface SubscriptionInvoiceGrantResolution {
  command: SubscriptionInvoiceGrantCommand | null;
  ignoredReason: string | null;
}

function catalogEntryForPrice(
  catalog: CanonicalPaidPlanCatalogEntry[],
  priceId: string | null | undefined,
): CanonicalPaidPlanCatalogEntry | null {
  return catalog.find((entry) => entry.priceId === priceId) ?? null;
}

function recognizedSubscriptionItem(
  subscription: StripeSubscription,
  catalog: CanonicalPaidPlanCatalogEntry[],
): { entry: CanonicalPaidPlanCatalogEntry; item: StripeSubscriptionItem } | null {
  const matches = (subscription.items?.data ?? []).flatMap((item) => {
    const entry = catalogEntryForPrice(catalog, getStripePriceId(item.price));
    return entry ? [{ entry, item }] : [];
  });
  if (matches.length > 1) throw new Error("Stripe subscription has multiple paid-plan items.");
  return matches[0] ?? null;
}

function isRecurringSubscriptionInvoiceLine(line: StripeInvoiceLine): boolean {
  if (isStripeProrationLine(line)) return false;
  if (line.parent?.invoice_item_details || line.type === "invoiceitem") {
    return false;
  }
  return Boolean(
    line.parent?.subscription_item_details ||
    line.subscription_item ||
    line.type === "subscription" ||
    getInvoiceLinePriceId(line),
  );
}

function getInvoiceLineSeatCount(
  invoiceId: string,
  line: StripeInvoiceLine,
  plan: SubscriptionBillingPlan,
): number {
  if (
    typeof line.quantity !== "number" ||
    !Number.isFinite(line.quantity) ||
    line.quantity <= 0
  ) {
    throw new Error(
      `Paid invoice ${invoiceId} has no valid quantity for ${plan}.`,
    );
  }
  return normalizeSeatCount(plan, line.quantity);
}

function recognizedRecurringInvoiceLine(
  invoice: StripeInvoice,
  lines: StripeInvoiceLine[],
  catalog: CanonicalPaidPlanCatalogEntry[],
): {
  entry: CanonicalPaidPlanCatalogEntry;
  line: StripeInvoiceLine;
  seatCount: number;
} | null {
  const matches = lines.flatMap((line) => {
    if (!isRecurringSubscriptionInvoiceLine(line)) return [];
    const entry = catalogEntryForPrice(catalog, getInvoiceLinePriceId(line));
    return entry
      ? [
          {
            entry,
            line,
            seatCount: getInvoiceLineSeatCount(invoice.id, line, entry.plan),
          },
        ]
      : [];
  });
  if (matches.length > 1) {
    throw new Error(
      `Paid ${invoice.billing_reason ?? "subscription"} invoice ${invoice.id} has multiple recognized recurring plan lines.`,
    );
  }
  return matches[0] ?? null;
}

export function resolveSubscriptionInvoiceGrant(args: {
  env: Pick<StripeBillingEnv, "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS">;
  invoice: StripeInvoice;
  lines: StripeInvoiceLine[];
  subscription: StripeSubscription;
  catalog: CanonicalPaidPlanCatalogEntry[];
  orgId: string;
  customerId: string;
  customerMetadata?: Record<string, string> | null;
}): SubscriptionInvoiceGrantResolution {
  const { invoice, subscription, catalog } = args;
  if (!isPaidInvoice(invoice)) return { command: null, ignoredReason: "invoice_not_paid" };
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return { command: null, ignoredReason: "not_subscription_invoice" };
  if (subscriptionId !== subscription.id) {
    throw new Error(`Invoice ${invoice.id} references a different subscription.`);
  }
  const billingReason = invoice.billing_reason;
  if (
    billingReason !== "subscription_create" &&
    billingReason !== "subscription_cycle" &&
    billingReason !== "subscription_update"
  ) {
    return { command: null, ignoredReason: "unsupported_billing_reason" };
  }
  const recognized =
    billingReason === "subscription_update"
      ? recognizedSubscriptionItem(subscription, catalog)
      : null;
  const pendingMigration = getPendingLegacyMigrationCustomerMetadata(
    args.customerMetadata,
  );
  const isLegacyMigration =
    billingReason === "subscription_update" &&
    recognized !== null &&
    pendingMigration?.orgId === args.orgId &&
    pendingMigration.subscriptionId === subscription.id &&
    pendingMigration.targetPlan === recognized.entry.plan &&
    normalizeSeatCount(recognized.entry.plan, pendingMigration.seatCount) ===
      normalizeSeatCount(recognized.entry.plan, recognized.item.quantity);
  if (isLegacyMigration) {
    const plan = recognized!.entry.plan;
    const seatCount = normalizeSeatCount(plan, recognized!.item.quantity);
    return {
      command: {
        invoiceId: invoice.id,
        subscriptionId,
        customerId: args.customerId,
        billingReason,
        source: "legacy_migration",
        plan,
        seatCount,
        grantCents: getSubscriptionIncludedCreditCentsForPlan(args.env, plan, seatCount),
      },
      ignoredReason: null,
    };
  }
  if (billingReason === "subscription_update") {
    if (!recognized) throw new Error(`Paid update invoice ${invoice.id} has no recognized plan.`);
    let netAllowance = 0;
    const positiveTargets: Array<{
      plan: SubscriptionBillingPlan;
      seatCount: number;
    }> = [];
    for (const line of args.lines) {
      if (!isStripeProrationLine(line)) continue;
      const priceId = getInvoiceLinePriceId(line);
      const entry = catalogEntryForPrice(catalog, priceId);
      if (!entry) {
        throw new Error(
          `Paid subscription update invoice ${invoice.id} contains unknown proration price ${priceId ?? "missing"}.`,
        );
      }
      const quantity = normalizeSeatCount(entry.plan, line.quantity ?? getMinimumSeats(entry.plan));
      const denominator = entry.unitAmount * quantity;
      if (typeof line.amount !== "number" || denominator <= 0) {
        throw new Error(`Stripe proration line for ${entry.priceId} is invalid.`);
      }
      netAllowance +=
        (line.amount / denominator) *
        getSubscriptionIncludedCreditCentsForPlan(
          args.env,
          entry.plan,
          quantity,
        );
      if (line.amount > 0) {
        positiveTargets.push({ plan: entry.plan, seatCount: quantity });
      }
    }
    const distinctPositiveTargets = positiveTargets.filter(
      (target, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.plan === target.plan &&
            candidate.seatCount === target.seatCount,
        ) === index,
    );
    if (distinctPositiveTargets.length > 1) {
      throw new Error(
        `Paid subscription update invoice ${invoice.id} has ambiguous target plan lines.`,
      );
    }
    const invoiceTarget = distinctPositiveTargets[0];
    const plan = invoiceTarget?.plan ?? recognized.entry.plan;
    const seatCount =
      invoiceTarget?.seatCount ??
      normalizeSeatCount(plan, recognized.item.quantity);
    return {
      command: {
        invoiceId: invoice.id,
        subscriptionId,
        customerId: args.customerId,
        billingReason,
        source: "plan_change",
        plan,
        seatCount,
        grantCents: Math.max(0, Math.floor(netAllowance)),
      },
      ignoredReason: null,
    };
  }
  const recurringLine = recognizedRecurringInvoiceLine(
    invoice,
    args.lines,
    catalog,
  );
  let plan = recurringLine?.entry.plan ?? null;
  let seatCount = recurringLine?.seatCount ?? null;
  if (!plan || seatCount === null) {
    const invoiceMetadata = getInvoiceMetadata(invoice);
    const fallback = normalizeBillingPlan(invoiceMetadata?.billing_plan);
    const hasLegacyPrice = args.lines.some((line) => {
      if (!isRecurringSubscriptionInvoiceLine(line)) return false;
      const priceId = getInvoiceLinePriceId(line);
      return Boolean(priceId && LEGACY_MIGRATION_PRICE_IDS.has(priceId));
    });
    if (
      billingReason !== "subscription_cycle" ||
      !["starter", "pro", "team"].includes(fallback) ||
      !hasLegacyPrice
    ) {
      throw new Error(`Paid ${billingReason} invoice ${invoice.id} has no recognized plan.`);
    }
    plan = fallback as SubscriptionBillingPlan;
    seatCount = getMetadataSeatCount(invoiceMetadata, plan);
  }
  return {
    command: {
      invoiceId: invoice.id,
      subscriptionId,
      customerId: args.customerId,
      billingReason,
      source: billingReason === "subscription_create" ? "initial" : "renewal",
      plan,
      seatCount,
      grantCents: getSubscriptionIncludedCreditCentsForPlan(args.env, plan, seatCount),
    },
    ignoredReason: null,
  };
}

export async function retrieveCanonicalStripeInvoice(args: {
  env: StripeBillingEnv;
  invoiceId: string;
}): Promise<{ invoice: StripeInvoice; lines: StripeInvoiceLine[] }> {
  const invoiceId = args.invoiceId.trim();
  if (!invoiceId) throw new Error("Stripe invoice id is required.");
  const invoice = await stripeRequest<StripeInvoice>(
    args.env,
    `/invoices/${encodeURIComponent(invoiceId)}`,
  );
  const lines: StripeInvoiceLine[] = [];
  let startingAfter: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const page = await stripeRequest<StripeListResponse<StripeInvoiceLine>>(
      args.env,
      `/invoices/${encodeURIComponent(invoiceId)}/lines?${params.toString()}`,
    );
    lines.push(...(page.data ?? []));
    if (!page.has_more) break;
    startingAfter = page.data?.at(-1)?.id?.trim() ?? null;
    if (!startingAfter) throw new Error(`Stripe invoice ${invoiceId} pagination has no cursor.`);
  } while (startingAfter);
  return { invoice, lines };
}

type EligibleInvoiceGrant = {
  invoice: StripeInvoice;
  subscription: StripeSubscription;
  command: SubscriptionInvoiceGrantCommand;
  orgId: string;
  customerId: string;
  customerMetadata: Record<string, string> | null | undefined;
  org: Organization;
  orgStub: ReturnType<typeof getOrgStub>;
  oldKvMarker: boolean;
  existingLedger: Awaited<
    ReturnType<ReturnType<typeof getOrgStub>["getSubscriptionInvoiceGrant"]>
  >;
};

async function preparePaidSubscriptionInvoice(
  env: StripeBillingEnv,
  invoiceId: string,
): Promise<
  | { kind: "ignored"; result: Extract<PaidSubscriptionInvoiceProcessingResult, { status: "ignored" }> }
  | { kind: "eligible"; grant: EligibleInvoiceGrant }
> {
  const { invoice, lines } = await retrieveCanonicalStripeInvoice({ env, invoiceId });
  if (!isPaidInvoice(invoice)) {
    return {
      kind: "ignored",
      result: {
        status: "ignored",
        reason: "invoice_not_paid",
        invoiceId: invoice.id,
        subscriptionId: getInvoiceSubscriptionId(invoice),
      },
    };
  }
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return { kind: "ignored", result: { status: "ignored", reason: "not_subscription_invoice", invoiceId: invoice.id } };
  }
  if (!invoice.billing_reason || !["subscription_create", "subscription_cycle", "subscription_update"].includes(invoice.billing_reason)) {
    return {
      kind: "ignored",
      result: { status: "ignored", reason: "unsupported_billing_reason", invoiceId: invoice.id, subscriptionId },
    };
  }
  const [subscription, catalog] = await Promise.all([
    fetchStripeSubscription(env, subscriptionId),
    loadCanonicalPaidPlanCatalog(env),
  ]);
  const invoiceCustomerId = getStripeCustomerId(invoice.customer);
  const subscriptionCustomerId = getStripeCustomerId(subscription.customer);
  if (invoiceCustomerId && subscriptionCustomerId && invoiceCustomerId !== subscriptionCustomerId) {
    throw new Error(`Invoice ${invoice.id} and subscription ${subscription.id} have different customers.`);
  }
  const customerId = subscriptionCustomerId ?? invoiceCustomerId;
  if (!customerId) throw new Error(`Paid subscription invoice ${invoice.id} has no customer.`);
  const directOrgId =
    subscription.metadata?.org_id?.trim() ||
    getInvoiceSubscriptionMetadata(invoice)?.org_id?.trim() ||
    null;
  let customerMetadata =
    typeof subscription.customer === "object" ? subscription.customer?.metadata : null;
  if (!customerMetadata && (!directOrgId || invoice.billing_reason === "subscription_update")) {
    customerMetadata = await fetchStripeCustomerMetadata(env, customerId);
  }
  const orgId = directOrgId || resolveOrgIdFromStripeCustomerMetadata(customerMetadata);
  if (!orgId) throw new Error(`Paid subscription invoice ${invoice.id} has no organization.`);
  const orgStub = getOrgStub(env, orgId);
  const org = await orgStub.getInfo();
  if (!org) throw new Error(`Organization ${orgId} does not exist.`);
  const resolution = resolveSubscriptionInvoiceGrant({
    env,
    invoice,
    lines,
    subscription,
    catalog,
    orgId,
    customerId,
    customerMetadata,
  });
  if (
    resolution.command?.source === "renewal" &&
    !recognizedRecurringInvoiceLine(invoice, lines, catalog)
  ) {
    console.warn("[billing] using legacy renewal price metadata fallback", {
      invoiceId: invoice.id,
      subscriptionId,
      orgId,
      plan: resolution.command.plan,
      seatCount: resolution.command.seatCount,
    });
  }
  if (!resolution.command) {
    return {
      kind: "ignored",
      result: {
        status: "ignored",
        reason: resolution.ignoredReason ?? "not_eligible",
        invoiceId: invoice.id,
        subscriptionId,
      },
    };
  }
  const [oldKvMarker, existingLedger] = await Promise.all([
    hasProcessedIncludedCreditInvoice(env, invoice.id),
    orgStub.getSubscriptionInvoiceGrant(invoice.id),
  ]);
  return {
    kind: "eligible",
    grant: {
      invoice,
      subscription,
      command: resolution.command,
      orgId,
      customerId,
      customerMetadata,
      org,
      orgStub,
      oldKvMarker,
      existingLedger,
    },
  };
}

async function applyEligibleInvoiceGrant(
  env: StripeBillingEnv,
  grant: EligibleInvoiceGrant,
): Promise<{
  result: Extract<PaidSubscriptionInvoiceProcessingResult, { status: "processed" | "duplicate" }>;
  grantResult: ApplySubscriptionInvoiceGrantResult;
}> {
  await syncOrgSubscriptionFromStripe(env, grant.subscription);
  const grantResult = await grant.orgStub.applySubscriptionInvoiceGrant(
    grant.command,
    {
      legacyProcessed: grant.oldKvMarker,
    },
  );
  if (!grantResult) throw new Error(`Organization ${grant.orgId} disappeared.`);
  if (grantResult.invariantError) throw new Error(grantResult.invariantError);
  await markIncludedCreditInvoiceProcessed(env, grant.invoice.id);
  if (grant.command.source === "legacy_migration") {
    await bestEffortClearPendingLegacyMigrationCustomerMetadata({
      env,
      customerId: grant.customerId,
      orgId: grant.orgId,
    });
  }
  return {
    grantResult,
    result: {
      status: grantResult.applied ? "processed" : "duplicate",
      invoiceId: grant.invoice.id,
      subscriptionId: grant.command.subscriptionId,
      orgId: grant.orgId,
      plan: grant.command.plan,
      seatCount: grant.command.seatCount,
      grantCents: grantResult.credited ? grant.command.grantCents : 0,
      source: grant.command.source,
      org: grantResult.org,
    },
  };
}

export async function processPaidSubscriptionInvoice(
  env: StripeBillingEnv,
  invoiceId: string,
): Promise<PaidSubscriptionInvoiceProcessingResult> {
  const prepared = await preparePaidSubscriptionInvoice(env, invoiceId);
  if (prepared.kind === "ignored") return prepared.result;
  return (await applyEligibleInvoiceGrant(env, prepared.grant)).result;
}

export async function reconcilePaidSubscriptionInvoice(
  env: StripeBillingEnv,
  invoiceId: string,
  options: { apply?: boolean } = {},
): Promise<SubscriptionInvoiceReconciliationReport> {
  const prepared = await preparePaidSubscriptionInvoice(env, invoiceId);
  if (prepared.kind === "ignored") {
    return {
      status: "ignored",
      invoiceId: prepared.result.invoiceId,
      subscriptionId: prepared.result.subscriptionId ?? null,
      reason: prepared.result.reason,
    };
  }
  const grant = prepared.grant;
  const applied = options.apply ? await applyEligibleInvoiceGrant(env, grant) : null;
  const legacyMarker =
    grant.oldKvMarker || grant.org.billing_last_included_credit_invoice_id === grant.invoice.id;
  const wouldCredit =
    !legacyMarker && !grant.existingLedger && grant.org.billing_status !== "enterprise";
  return {
    status: applied ? applied.result.status : "preview",
    invoiceId: grant.invoice.id,
    subscriptionId: grant.command.subscriptionId,
    orgId: grant.orgId,
    billingReason: grant.command.billingReason,
    plan: grant.command.plan,
    seatCount: grant.command.seatCount,
    source: grant.command.source,
    computedGrantCents: grant.command.grantCents,
    creditedGrantCents: applied
      ? applied.grantResult.credited
        ? grant.command.grantCents
        : 0
      : wouldCredit
        ? grant.command.grantCents
        : 0,
    oldKvMarker: grant.oldKvMarker,
    lastInvoiceMarker: grant.org.billing_last_included_credit_invoice_id ?? null,
    ledgerStatus: grant.existingLedger
      ? grant.existingLedger.source === "legacy_processed"
        ? "legacy_processed"
        : "recorded"
      : "not_recorded",
  };
}

export async function applySubscriptionIncludedCreditsFromInvoice(
  env: StripeBillingEnv,
  invoice: StripeInvoice,
): Promise<Organization | null> {
  const result = await processPaidSubscriptionInvoice(env, invoice.id);
  return result.status === "ignored" ? null : result.org;
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
  const response = await stripeRequest<
    StripeListResponse<StripeInvoiceListEntry>
  >(env, `/invoices?${params.toString()}`);
  return response.data ?? [];
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
    current_period_end_ms: stripeTimestampMs(
      getSubscriptionPeriodEndSeconds(env, subscription),
    ),
    cancel_at_ms: stripeTimestampMs(subscription.cancel_at),
    cancellation_date_ms: getSubscriptionCancellationDateMs(env, subscription),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    is_canceling: isSubscriptionCanceling(subscription),
    trial_end_ms: stripeTimestampMs(subscription.trial_end),
  };
}
