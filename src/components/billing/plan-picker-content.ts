import { BILLING_PLAN_LIMITS } from "@/lib/billing-plans";
import type { BillingPlan } from "@/types";

export type PlanPickerCtaKind =
  | "byok"
  | "payg"
  | "trial"
  | "contact"
  | "downgrade";

export interface PlanContent {
  tagline: string;
  ctaLabel: string;
  ctaKind: PlanPickerCtaKind;
  features: string[];
}

export const PLAN_CONTENT: Record<BillingPlan, PlanContent> = {
  free: {
    tagline: "Try the platform",
    ctaLabel: "Add my API key",
    ctaKind: "byok",
    features: [
      "Bring your own API key",
      "1 workspace",
      "3 deployed apps",
      "5 GB storage",
      "2 cron jobs (daily)",
    ],
  },
  payg: {
    tagline: "For a trial run, bring your own LLM provider",
    ctaLabel: "Continue",
    ctaKind: "payg",
    features: [
      "Buy credits before usage",
      "No monthly subscription",
      "1 workspace",
      "3 deployed apps",
      "2 cron jobs (daily)",
    ],
  },
  starter: {
    tagline: "For solo builders",
    ctaLabel: "Start 7-day free trial",
    ctaKind: "trial",
    features: [
      "$10 of model credits / mo",
      "Bring your own API key",
      "30 deployed apps",
      "50 GB storage",
      "10 cron jobs (hourly)",
    ],
  },
  pro: {
    tagline: "For power users",
    ctaLabel: "Start 7-day free trial",
    ctaKind: "trial",
    features: [
      "$30 of model credits / mo",
      "Bring your own API key",
      "Unlimited deployed apps",
      "100 GB storage",
      "50 cron jobs (5-min)",
      "Email inbox",
    ],
  },
  team: {
    tagline: "For teams shipping together",
    ctaLabel: "Start 7-day free trial",
    ctaKind: "trial",
    features: [
      "$10 of model credits / seat / mo",
      "Everything in Pro",
      "2 workspaces",
      "Role-based access",
      "Email inbox",
    ],
  },
  enterprise: {
    tagline: "Talk to sales",
    ctaLabel: "Contact sales",
    ctaKind: "contact",
    features: [
      "SSO / SAML",
      "BYOCloud",
      "Multiple workspaces",
      "Dedicated Slack support",
      "HIPAA / SOC 2",
    ],
  },
};

export function formatPlanPrice(plan: BillingPlan): {
  amount: string;
  suffix: string | null;
  subtitle: string | null;
} {
  const limits = BILLING_PLAN_LIMITS[plan];
  if (limits.monthlyPriceCents === null) {
    return { amount: "Custom", suffix: null, subtitle: null };
  }
  const dollars = limits.monthlyPriceCents / 100;
  const amount = `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
  if (plan === "free") {
    return { amount, suffix: "/mo", subtitle: null };
  }
  if (plan === "payg") {
    return { amount, suffix: "/mo", subtitle: "prepaid credits" };
  }
  const suffix = plan === "team" ? "/seat/mo" : "/mo";
  return { amount, suffix, subtitle: "+ usage after credits" };
}

export const INDIVIDUAL_PLANS: BillingPlan[] = [
  "payg",
  "starter",
  "pro",
];
export const TEAM_PLANS: BillingPlan[] = ["team", "enterprise"];
