import { normalizeBillingPlan } from "@/lib/billing-plans";
import type { BillingPlan, BillingStatus } from "@/types";

export interface CreditPackPriceSummary {
  id: string;
  unit_amount: number | null;
  currency: string;
}

export interface TopUpCreditPack {
  id: string;
  creditsLabel: string | null;
  priceLabel: string | null;
}

export type CheckoutReturnStatus = "success" | "cancelled";

export const DEFAULT_CREDIT_CHECKOUT_RETURN_PATH = "/chat";

export function formatCreditPackPriceLabel(
  price: Pick<CreditPackPriceSummary, "unit_amount" | "currency"> | null,
): string | null {
  if (!price?.unit_amount) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.unit_amount / 100);
}

export function formatCreditPackCreditsLabel(
  price: Pick<CreditPackPriceSummary, "unit_amount">,
): string | null {
  if (!price.unit_amount) return null;
  return `${(price.unit_amount / 100).toFixed(2)} credits`;
}

export function formatTopUpCreditPack(
  pack: CreditPackPriceSummary,
): TopUpCreditPack {
  return {
    id: pack.id,
    priceLabel: formatCreditPackPriceLabel(pack),
    creditsLabel: formatCreditPackCreditsLabel(pack),
  };
}

export function formatTopUpCreditPacks(
  packs: CreditPackPriceSummary[],
): TopUpCreditPack[] {
  return packs.map(formatTopUpCreditPack);
}

export function canBuyCreditsForBillingState(state: {
  billing_status?: BillingStatus | null;
  billing_plan?: BillingPlan | null;
}): boolean {
  const billingPlan = normalizeBillingPlan(
    state.billing_plan,
    state.billing_status,
  );
  return (
    billingPlan === "payg" ||
    state.billing_status === "trialing" ||
    (state.billing_status === "active" && billingPlan !== "free")
  );
}

export function sanitizeCreditCheckoutReturnPath(
  returnTo: FormDataEntryValue | string | null | undefined,
): string {
  const rawValue = typeof returnTo === "string" ? returnTo.trim() : "";
  if (!rawValue || rawValue.startsWith("//")) {
    return DEFAULT_CREDIT_CHECKOUT_RETURN_PATH;
  }

  const baseUrl = "https://camelai.local";
  let parsed: URL;
  try {
    parsed = new URL(rawValue, baseUrl);
  } catch {
    return DEFAULT_CREDIT_CHECKOUT_RETURN_PATH;
  }

  if (parsed.origin !== baseUrl) {
    return DEFAULT_CREDIT_CHECKOUT_RETURN_PATH;
  }
  if (parsed.pathname !== "/chat" && !parsed.pathname.startsWith("/chat/")) {
    return DEFAULT_CREDIT_CHECKOUT_RETURN_PATH;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function buildCreditCheckoutReturnUrl(
  requestUrl: string,
  returnTo: FormDataEntryValue | string | null | undefined,
  status: CheckoutReturnStatus,
): string {
  const path = sanitizeCreditCheckoutReturnPath(returnTo);
  const url = new URL(path, requestUrl);
  url.searchParams.set("checkout", status);
  return url.toString();
}
