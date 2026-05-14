import { describe, expect, it } from 'vitest';
import {
  applyDevBillingCreditStatusOverride,
  buildBillingCreditStatus,
  getDevChatInitialError,
} from '@/lib/chat-credit-status';
import type { OrgBillingOverview } from '@/lib/billing.server';

function makeOverview(overrides: Partial<OrgBillingOverview>): OrgBillingOverview {
  return {
    org_id: 'org_123',
    billing_status: 'active',
    billing_plan: 'starter',
    billing_seat_count: 1,
    billing_subscription_status: 'active',
    billing_trial_started_at: null,
    billing_trial_ends_at: null,
    billing_credit_purchase_total_cents: 0,
    billing_credit_grant_total_cents: 1000,
    billing_trial_credit_grant_cents: 0,
    billing_trial_credit_granted_at: null,
    billing_free_credit_grant_cents: 0,
    billing_free_credit_granted_at: null,
    billing_last_included_credit_invoice_id: null,
    billing_credit_usage_started_at: null,
    lifetime_spend_cents: 0,
    chargeable_usage_cents: 0,
    chargeable_request_count: 0,
    available_credits_cents: 1000,
    total_credit_limit_cents: 1000,
    trial_credit_allowance_cents: 1000,
    subscription_included_credit_cents: 1000,
    ...overrides,
  };
}

describe('chat credit status', () => {
  it('shows low credit status at 80 percent usage', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 820,
          available_credits_cents: 180,
        }),
        false,
      ),
    ).toMatchObject({
      availableCreditsCents: 180,
      totalCreditLimitCents: 1000,
      usedPercent: 82,
      isLow: true,
      isExhausted: false,
      hasByokProvider: false,
    });
  });

  it('hides credit status when usage is not low', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 300,
          available_credits_cents: 700,
        }),
        false,
      ),
    ).toBeNull();
  });

  it('hides hosted credit status for threads covered by BYOK', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 1000,
          available_credits_cents: 0,
        }),
        'anthropic',
        'claude',
      ),
    ).toBeNull();
  });

  it('shows hosted credit status for threads not covered by BYOK', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 1000,
          available_credits_cents: 0,
        }),
        'anthropic',
        'codex',
      ),
    ).toMatchObject({
      isExhausted: true,
      hasByokProvider: true,
    });
  });

  it('forces dev credit states from query params', () => {
    const params = new URLSearchParams('devCreditState=exhausted-byok&devChatError=out-of-credits');

    expect(applyDevBillingCreditStatusOverride(null, params)).toMatchObject({
      availableCreditsCents: 0,
      usedPercent: 100,
      isExhausted: true,
      hasByokProvider: true,
    });
    expect(getDevChatInitialError(params)).toBe(
      'Message not sent — top up credits or add an API key to continue.',
    );
  });
});
