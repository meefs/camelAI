import { describe, expect, it } from "vitest";
import {
  buildCreditCheckoutReturnUrl,
  canBuyCreditsForBillingState,
  formatTopUpCreditPack,
  sanitizeCreditCheckoutReturnPath,
} from "@/lib/billing-credit-packs";

describe("billing credit pack helpers", () => {
  it("formats Stripe credit pack summaries for the top-up dialog", () => {
    expect(
      formatTopUpCreditPack({
        id: "price_123",
        unit_amount: 500,
        currency: "usd",
      }),
    ).toEqual({
      id: "price_123",
      creditsLabel: "5.00 credits",
      priceLabel: "$5.00",
    });
  });

  it("matches credit purchase eligibility rules", () => {
    expect(
      canBuyCreditsForBillingState({
        billing_status: "inactive",
        billing_plan: "payg",
      }),
    ).toBe(true);
    expect(
      canBuyCreditsForBillingState({
        billing_status: "trialing",
        billing_plan: "starter",
      }),
    ).toBe(true);
    expect(
      canBuyCreditsForBillingState({
        billing_status: "active",
        billing_plan: "pro",
      }),
    ).toBe(true);
    expect(
      canBuyCreditsForBillingState({
        billing_status: "active",
        billing_plan: "free",
      }),
    ).toBe(true);
    expect(
      canBuyCreditsForBillingState({
        billing_status: "past_due",
        billing_plan: "starter",
      }),
    ).toBe(false);
    expect(
      canBuyCreditsForBillingState({
        billing_status: "enterprise",
        billing_plan: "enterprise",
      }),
    ).toBe(false);
  });

  it("only accepts same-origin chat return paths", () => {
    expect(sanitizeCreditCheckoutReturnPath("/chat/abc?group=1#composer")).toBe(
      "/chat/abc?group=1#composer",
    );
    expect(sanitizeCreditCheckoutReturnPath("/chat?group=1")).toBe(
      "/chat?group=1",
    );
    expect(sanitizeCreditCheckoutReturnPath("https://evil.com/chat")).toBe(
      "/chat",
    );
    expect(sanitizeCreditCheckoutReturnPath("//evil.com/chat")).toBe("/chat");
    expect(sanitizeCreditCheckoutReturnPath("/settings/organization/usage")).toBe(
      "/chat",
    );
  });

  it("preserves chat query params when adding checkout status", () => {
    expect(
      buildCreditCheckoutReturnUrl(
        "https://app.example.test/api/billing/credit-packs",
        "/chat/thread_123?group=abc&checkout=old#bottom",
        "success",
      ),
    ).toBe(
      "https://app.example.test/chat/thread_123?group=abc&checkout=success#bottom",
    );
  });
});
