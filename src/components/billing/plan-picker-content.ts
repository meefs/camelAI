import { BILLING_PLAN_LIMITS } from "@/lib/billing-plans";
import type { BillingPlan } from "@/types";

export type PlanPickerCtaKind =
  | "byok"
  | "payg"
  | "subscribe"
  | "manage"
  | "contact"
  | "downgrade";

export interface PlanContent {
  tagline: string;
  /** Optional "Everything in X, plus:" prefix shown above the bullet list. Renders muted, no checkmark. */
  upsellPrefix?: string;
  ctaLabel: string;
  ctaKind: PlanPickerCtaKind;
  features: string[];
}

export const PLAN_CONTENT: Record<BillingPlan, PlanContent> = {
  free: {
    // Not rendered by the upgrade picker. It exists to keep BillingPlan content
    // exhaustive for callers that inspect legacy plan ids.
    tagline: "Try it out",
    ctaLabel: "Continue",
    ctaKind: "payg",
    features: [],
  },
  payg: {
    // Internal legacy id for the Free plan. Credit purchases are exposed as a
    // separate Top up action, never as a plan card.
    tagline: "",
    ctaLabel: "",
    ctaKind: "payg",
    features: [],
  },
  starter: {
    tagline: "Solo builders",
    upsellPrefix: "Everything in Free, plus:",
    ctaLabel: "Subscribe",
    ctaKind: "subscribe",
    features: [
      "$10 of model credits / mo (at cost)",
      "5× daily web search, research, and Oracle allowances",
      "Priority over free traffic on camelCode",
      "30 deployed apps",
      "10 custom domains",
      "1 automated task hourly",
      "50 GB storage",
      "Workspace email inbox",
    ],
  },
  pro: {
    tagline: "Power users",
    upsellPrefix: "Everything in Starter, plus:",
    ctaLabel: "Subscribe",
    ctaKind: "subscribe",
    features: [
      "$40 of model credits / mo (at cost)",
      "20× daily web search, research, and Oracle allowances",
      "Priority over free traffic on camelCode",
      "Unlimited deployed apps",
      "Unlimited custom domains",
      "Automations every 5 minutes",
      "100 GB storage",
    ],
  },
  team: {
    tagline: "Teams shipping together",
    upsellPrefix: "Everything in Pro for every seat, plus:",
    ctaLabel: "Subscribe",
    ctaKind: "subscribe",
    features: [
      "$50 of model credits / seat / mo",
      "20× daily web search, research, and Oracle allowances",
      "Priority over free traffic on camelCode",
      "2 shared workspaces",
      "Role-based access (admin / member)",
    ],
  },
  enterprise: {
    tagline: "For larger teams",
    upsellPrefix: "Everything in Team, plus:",
    ctaLabel: "Contact sales",
    ctaKind: "contact",
    features: [
      "Priority over free traffic on camelCode",
      "SSO / SAML",
      "Bring your own cloud (BYOCloud)",
      "Multiple workspaces",
      "HIPAA / SOC 2",
      "Dedicated Slack support",
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

export const INDIVIDUAL_PLANS: BillingPlan[] = ["starter", "pro"];
export const TEAM_PLANS: BillingPlan[] = ["team", "enterprise"];
