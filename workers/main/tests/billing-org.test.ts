import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEmail = () =>
  `billing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("OrgDO billing grant idempotency", () => {
  const testEnv = env as unknown as TestEnv;

  it("applies trial credits once when subscription events are delivered more than once", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Trial Grant Org", ownerId);
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
    const { org } = await createOrg(testEnv, "Prior Trial Org", ownerId);
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
