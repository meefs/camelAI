import type { BillingPlan } from "../types";
import { normalizeBillingPlan } from "./billing-plans";

export const HOSTED_CAPABILITIES = [
  "web_search",
  "web_fetch",
  "research",
  "oracle",
] as const;

export type HostedCapability = (typeof HOSTED_CAPABILITIES)[number];

export interface CapabilityAllowancePolicy {
  dailyLimit: number | null;
}

type PlanCapabilityLimits = Record<HostedCapability, number | null>;

// Product-facing daily job limits. Provider dollars remain internal telemetry;
// callers consume stable capability jobs rather than à-la-carte credits.
export const CAPABILITY_DAILY_LIMITS: Record<BillingPlan, PlanCapabilityLimits> = {
  free: {
    web_search: 100,
    web_fetch: 200,
    research: 50,
    oracle: 100,
  },
  payg: {
    web_search: 100,
    web_fetch: 200,
    research: 50,
    oracle: 100,
  },
  starter: {
    web_search: 500,
    web_fetch: 1_000,
    research: 250,
    oracle: 500,
  },
  pro: {
    web_search: 2_000,
    web_fetch: 4_000,
    research: 1_000,
    oracle: 2_000,
  },
  team: {
    web_search: 2_000,
    web_fetch: 4_000,
    research: 1_000,
    oracle: 2_000,
  },
  enterprise: {
    web_search: null,
    web_fetch: null,
    research: null,
    oracle: null,
  },
};

export function isHostedCapability(value: unknown): value is HostedCapability {
  return typeof value === "string" &&
    HOSTED_CAPABILITIES.includes(value as HostedCapability);
}

export function getCapabilityAllowancePolicy(
  capability: HostedCapability,
  billingPlan: string | null | undefined,
  billingStatus?: string | null,
): CapabilityAllowancePolicy {
  const normalizedPlan = normalizeBillingPlan(billingPlan, billingStatus);
  const hasCurrentPaidAccess =
    billingStatus === "active" ||
    billingStatus === "trialing" ||
    billingStatus === "paying";
  const plan = normalizedPlan === "enterprise"
    ? billingStatus === "enterprise" ? "enterprise" : "payg"
    : normalizedPlan === "starter" || normalizedPlan === "pro" || normalizedPlan === "team"
      ? hasCurrentPaidAccess ? normalizedPlan : "payg"
      : normalizedPlan;
  return { dailyLimit: CAPABILITY_DAILY_LIMITS[plan][capability] };
}

export function utcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function nextUtcDayStart(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}
