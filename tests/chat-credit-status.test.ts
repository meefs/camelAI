import { describe, expect, it } from 'vitest';
import {
  activeLowCreditTier,
  applyDevBillingCreditStatusOverride,
  buildBillingCreditStatus,
  getDevChatInitialError,
  shouldShowLowCreditAlert,
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
  it('maps available credit balances to low-credit tiers', () => {
    expect(activeLowCreditTier(600)).toBeNull();
    expect(activeLowCreditTier(500)).toBeNull();
    expect(activeLowCreditTier(499)).toBe(500);
    expect(activeLowCreditTier(342)).toBe(500);
    expect(activeLowCreditTier(250)).toBe(500);
    expect(activeLowCreditTier(249)).toBe(250);
    expect(activeLowCreditTier(90)).toBe(100);
    expect(activeLowCreditTier(50)).toBe(100);
    expect(activeLowCreditTier(49)).toBe(50);
    expect(activeLowCreditTier(5)).toBe(50);
    expect(activeLowCreditTier(0)).toBeNull();
  });

  it('shows dismissed low-credit alerts again only at lower tiers', () => {
    expect(shouldShowLowCreditAlert(null, null)).toBe(false);
    expect(shouldShowLowCreditAlert(500, null)).toBe(true);
    expect(shouldShowLowCreditAlert(500, 500)).toBe(false);
    expect(shouldShowLowCreditAlert(250, 500)).toBe(true);
    expect(shouldShowLowCreditAlert(100, 250)).toBe(true);
    expect(shouldShowLowCreditAlert(50, 100)).toBe(true);
    expect(shouldShowLowCreditAlert(500, 100)).toBe(false);
  });

  it('returns credit status below a dollar threshold', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 820,
          available_credits_cents: 450,
        }),
        false,
      ),
    ).toMatchObject({
      availableCreditsCents: 450,
      totalCreditLimitCents: 1000,
      isExhausted: false,
      hasByokProvider: false,
    });
  });

  it('returns healthy status so dismissal state can reset after recovery', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 300,
          available_credits_cents: 700,
        }),
        false,
      ),
    ).toMatchObject({
      availableCreditsCents: 700,
      totalCreditLimitCents: 1000,
      isExhausted: false,
      hasByokProvider: false,
    });
  });

  it('returns exhausted status for never-funded hosted orgs', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 0,
          available_credits_cents: 0,
          total_credit_limit_cents: 0,
        }),
        false,
      ),
    ).toMatchObject({
      availableCreditsCents: 0,
      totalCreditLimitCents: 0,
      isExhausted: true,
      hasByokProvider: false,
    });
  });

  it('hides hosted credit status for threads covered by BYOK', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 1000,
          available_credits_cents: 0,
        }),
        'anthropic',
        'sonnet',
      ),
    ).toBeNull();

    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 1000,
          available_credits_cents: 0,
        }),
        'openai',
        'gpt-5.6-luna',
      ),
    ).toBeNull();
  });

  it('hides hosted credit status while a thread uses Camel Free', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          available_credits_cents: 0,
          total_credit_limit_cents: 0,
        }),
        false,
        'deepseek-v4-auto',
      ),
    ).toBeNull();
  });

  it('keeps hosted credit status for threads not covered by configured BYOK', () => {
    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 1000,
          available_credits_cents: 0,
        }),
        'openai',
        'sonnet',
      ),
    ).toMatchObject({
      isExhausted: true,
      hasByokProvider: true,
    });

    expect(
      buildBillingCreditStatus(
        makeOverview({
          chargeable_usage_cents: 560,
          available_credits_cents: 440,
        }),
        'anthropic',
        'gpt-5.6-luna',
      ),
    ).toMatchObject({
      availableCreditsCents: 440,
      isExhausted: false,
      hasByokProvider: true,
    });
  });

  it('forces dev credit states from query params', () => {
    const params = new URLSearchParams('devCreditState=exhausted-byok&devChatError=out-of-credits');

    expect(applyDevBillingCreditStatusOverride(null, params)).toMatchObject({
      availableCreditsCents: 0,
      isExhausted: true,
      hasByokProvider: true,
    });
    expect(getDevChatInitialError(params)).toBe(
      'Message not sent — top up credits or add an API key to continue.',
    );
  });

  it('forces dev dollar-tier credit states from query params', () => {
    expect(
      applyDevBillingCreditStatusOverride(null, new URLSearchParams('devCreditState=healthy')),
    ).toMatchObject({
      availableCreditsCents: 650,
      isExhausted: false,
    });
    expect(
      applyDevBillingCreditStatusOverride(null, new URLSearchParams('devCreditState=low-250')),
    ).toMatchObject({
      availableCreditsCents: 220,
      isExhausted: false,
    });
    expect(
      applyDevBillingCreditStatusOverride(null, new URLSearchParams('devCreditState=low-50')),
    ).toMatchObject({
      availableCreditsCents: 45,
      isExhausted: false,
    });
  });
});
