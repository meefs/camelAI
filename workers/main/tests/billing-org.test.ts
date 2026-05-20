import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";
import {
  createSubscriptionCheckoutSession,
  getBillingAccessSnapshot,
  syncOrgSubscriptionFromStripe,
  type StripeBillingEnv,
  type StripeSubscription,
} from "../../../src/lib/billing.server";

const testEmail = () =>
  `billing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("OrgDO billing grant idempotency", () => {
  const testEnv = env as unknown as TestEnv;

  function stripeBillingEnv(): StripeBillingEnv {
    return {
      ...(testEnv as unknown as StripeBillingEnv),
      STRIPE_STARTER_PRICE_ID: "price_starter_test",
    };
  }

  function trialingStarterSubscription(
    orgId: string,
    cancelAtPeriodEnd: boolean,
  ): StripeSubscription {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      id: `sub_${crypto.randomUUID()}`,
      status: "trialing",
      customer: "cus_test",
      trial_start: nowSeconds,
      trial_end: nowSeconds + 7 * 24 * 60 * 60,
      cancel_at_period_end: cancelAtPeriodEnd,
      metadata: {
        org_id: orgId,
        billing_plan: "starter",
        seat_count: "1",
        trial_credit_cents: "1000",
        subscription_included_credit_cents: "1000",
      },
      items: {
        data: [
          {
            id: "si_starter_test",
            quantity: 1,
            price: {
              id: "price_starter_test",
              unit_amount: 4000,
              currency: "usd",
            },
          },
        ],
      },
    };
  }

  function pausedStarterSubscription(orgId: string): StripeSubscription {
    return {
      id: `sub_${crypto.randomUUID()}`,
      status: "paused",
      customer: "cus_test",
      cancel_at_period_end: false,
      metadata: {
        org_id: orgId,
        billing_plan: "starter",
        seat_count: "1",
        subscription_included_credit_cents: "1000",
      },
      items: {
        data: [
          {
            id: "si_starter_test",
            quantity: 1,
            price: {
              id: "price_starter_test",
              unit_amount: 4000,
              currency: "usd",
            },
          },
        ],
      },
    };
  }

  it("moves canceled trial subscriptions to Pay as you go and preserves resumable Stripe linkage", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Canceled Trial Org", ownerId, {
      billingPlan: "payg",
    });

    const subscription = trialingStarterSubscription(org.id, true);
    const synced = await syncOrgSubscriptionFromStripe(
      stripeBillingEnv(),
      subscription,
    );

    expect(synced?.billing_status).toBe("inactive");
    expect(synced?.billing_plan).toBe("payg");
    expect(synced?.billing_subscription_id).toBe(subscription.id);
    expect(synced?.billing_subscription_status).toBe("trialing");
    expect(synced?.billing_credit_grant_total_cents).toBe(0);
    expect(synced?.billing_trial_credit_grant_cents).toBe(0);
    expect(synced?.billing_trial_credit_granted_at).toBeNull();

    const snapshot = await getBillingAccessSnapshot(stripeBillingEnv(), org.id);
    expect(snapshot?.billing_status).toBe("inactive");
    expect(snapshot?.billing_plan).toBe("payg");
  });

  it("preserves paused Stripe subscriptions instead of converting them to Pay as you go", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Paused Subscription Org", ownerId, {
      billingPlan: "payg",
    });
    const subscription = pausedStarterSubscription(org.id);

    const synced = await syncOrgSubscriptionFromStripe(
      stripeBillingEnv(),
      subscription,
    );

    expect(synced?.billing_status).toBe("inactive");
    expect(synced?.billing_plan).toBe("starter");
    expect(synced?.billing_subscription_id).toBe(subscription.id);
    expect(synced?.billing_subscription_status).toBe("paused");
  });

  it("creates paid subscription checkout without a free trial period", async () => {
    const { userId: ownerId, user } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Paid Checkout Org", ownerId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const billingOrg = await orgStub.updateBillingState({
      billing_customer_id: "cus_test",
    });
    expect(billingOrg).not.toBeNull();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          id: "cs_test",
          mode: "subscription",
          url: "https://checkout.stripe.test/session",
        }),
      );

    try {
      await expect(
        createSubscriptionCheckoutSession({
          env: {
            ...stripeBillingEnv(),
            STRIPE_MODE: "test",
            STRIPE_SECRET_KEY: "sk_test_checkout",
            STRIPE_STARTER_PRICE_ID: "price_starter_test",
          },
          org: billingOrg!,
          customerEmail: user.email,
          successUrl: "https://camelai.test/success",
          cancelUrl: "https://camelai.test/cancel",
          plan: "starter",
          seatCount: 1,
        }),
      ).resolves.toBe("https://checkout.stripe.test/session");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(String(init.body));

      expect(body.get("mode")).toBe("subscription");
      expect(body.get("subscription_data[trial_period_days]")).toBeNull();
      expect(body.get("metadata[trial_credit_cents]")).toBe("0");
      expect(body.get("subscription_data[metadata][trial_credit_cents]")).toBe(
        "0",
      );
      expect(body.get("metadata[initial_included_credit_cents]")).toBe("1000");
      expect(
        body.get("subscription_data[metadata][initial_included_credit_cents]"),
      ).toBe("1000");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("continues granting first-trial credits when the Stripe trial is not canceling", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Active Trial Org", ownerId, {
      billingPlan: "payg",
    });

    const synced = await syncOrgSubscriptionFromStripe(
      stripeBillingEnv(),
      trialingStarterSubscription(org.id, false),
    );

    expect(synced?.billing_status).toBe("trialing");
    expect(synced?.billing_subscription_status).toBe("trialing");
    expect(synced?.billing_credit_grant_total_cents).toBe(1000);
    expect(synced?.billing_trial_credit_grant_cents).toBe(1000);
    expect(synced?.billing_trial_credit_granted_at).toEqual(
      expect.any(Number),
    );
  });

  it("applies trial credits once when subscription events are delivered more than once", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Trial Grant Org", ownerId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const trialStart = Date.now();
    const trialEnd = trialStart + 7 * 24 * 60 * 60 * 1000;

    const first = await orgStub.syncSubscriptionBillingState(
      {
        billing_status: "trialing",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_test",
        billing_subscription_id: "sub_test",
        billing_subscription_status: "trialing",
        billing_trial_started_at: trialStart,
        billing_trial_ends_at: trialEnd,
      },
      1200,
    );

    expect(first?.trialCreditGranted).toBe(true);
    expect(first?.org.billing_credit_grant_total_cents).toBe(1200);
    expect(first?.org.billing_trial_credit_grant_cents).toBe(1200);
    expect(first?.org.billing_trial_credit_granted_at).toEqual(
      expect.any(Number),
    );

    const duplicate = await orgStub.syncSubscriptionBillingState(
      {
        billing_status: "trialing",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_test",
        billing_subscription_id: "sub_test",
        billing_subscription_status: "trialing",
        billing_trial_started_at: trialStart,
        billing_trial_ends_at: trialEnd,
      },
      1200,
    );

    expect(duplicate?.trialCreditGranted).toBe(false);
    expect(duplicate?.org.billing_credit_grant_total_cents).toBe(1200);
    expect(duplicate?.org.billing_trial_credit_grant_cents).toBe(1200);
  });

  it("does not grant trial credits again after any prior org trial", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Prior Trial Org", ownerId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const priorTrialStart = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const trialStart = Date.now();
    const trialEnd = trialStart + 7 * 24 * 60 * 60 * 1000;

    await orgStub.updateBillingState({
      billing_trial_started_at: priorTrialStart,
      billing_trial_ends_at: priorTrialStart + 7 * 24 * 60 * 60 * 1000,
    });

    const result = await orgStub.syncSubscriptionBillingState(
      {
        billing_status: "trialing",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_customer_id: "cus_test",
        billing_subscription_id: "sub_test",
        billing_subscription_status: "trialing",
        billing_trial_started_at: trialStart,
        billing_trial_ends_at: trialEnd,
      },
      3000,
    );

    expect(result?.trialCreditGranted).toBe(false);
    expect(result?.org.billing_credit_grant_total_cents).toBe(0);
    expect(result?.org.billing_trial_credit_grant_cents).toBe(0);
    expect(result?.org.billing_trial_credit_granted_at).toBeNull();
  });

  it("applies manual credit grants idempotently by grant id", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Manual Grant Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const first = await orgStub.applyManualCreditGrant(
      2500,
      "manual onboarding credit",
      "grant-test-1",
    );
    expect(first?.applied).toBe(true);
    expect(first?.amountCents).toBe(2500);
    expect(first?.reason).toBe("manual onboarding credit");
    expect(first?.org.billing_credit_grant_total_cents).toBe(2500);

    const duplicate = await orgStub.applyManualCreditGrant(
      2500,
      "manual onboarding credit",
      "grant-test-1",
    );
    expect(duplicate?.applied).toBe(false);
    expect(duplicate?.amountCents).toBe(2500);
    expect(duplicate?.org.billing_credit_grant_total_cents).toBe(2500);
  });
});
