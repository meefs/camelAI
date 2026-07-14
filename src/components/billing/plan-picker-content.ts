import { BILLING_PLAN_LIMITS } from "@/lib/billing-plans";
import type { BillingPlan } from "@/types";

export type PlanPickerCtaKind =
  | "byok"
  | "payg"
  | "subscribe"
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
    // Not rendered by the picker — INDIVIDUAL_PLANS does not include "free".
    // Exists only to satisfy Record<BillingPlan, PlanContent>. Pay as you go is
    // the actual free tier shown to users.
    tagline: "Try it out",
    ctaLabel: "Continue",
    ctaKind: "payg",
    features: [],
  },
  payg: {
    tagline: "Try it out",
    ctaLabel: "Continue",
    ctaKind: "payg",
    features: [
      "Pay only for what you use, or bring your own API key",
      "3 deployed apps",
      "1 automated task daily",
      "5 GB storage",
    ],
  },
  starter: {
    tagline: "Solo builders",
    upsellPrefix: "Everything in Pay as you go, plus:",
    ctaLabel: "Subscribe",
    ctaKind: "subscribe",
    features: [
      "$10 of model credits / mo (at cost)",
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

export const INDIVIDUAL_PLANS: BillingPlan[] = [
  "payg",
  "starter",
  "pro",
];
export const TEAM_PLANS: BillingPlan[] = ["team", "enterprise"];
