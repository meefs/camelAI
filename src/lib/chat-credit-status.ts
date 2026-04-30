import type { OrgBillingOverview } from '@/lib/billing.server';

export interface BillingCreditStatus {
  availableCreditsCents: number;
  totalCreditLimitCents: number;
  usedPercent: number;
  isLow: boolean;
  isExhausted: boolean;
  hasByokProvider: boolean;
}

export type DevChatCreditState = 'low' | 'low-byok' | 'exhausted' | 'exhausted-byok';

export function buildBillingCreditStatus(
  overview: OrgBillingOverview | null,
  hasByokProvider: boolean,
): BillingCreditStatus | null {
  if (!overview || overview.billing_status === 'enterprise') {
    return null;
  }
  if (overview.total_credit_limit_cents <= 0) {
    return null;
  }

  const usedPercent = Math.min(
    100,
    Math.max(0, Math.round((overview.chargeable_usage_cents / overview.total_credit_limit_cents) * 100)),
  );
  const isExhausted = overview.available_credits_cents <= 0;
  const isLow = !isExhausted && usedPercent >= 80;
  if (!isLow && !isExhausted) {
    return null;
  }

  return {
    availableCreditsCents: overview.available_credits_cents,
    totalCreditLimitCents: overview.total_credit_limit_cents,
    usedPercent,
    isLow,
    isExhausted,
    hasByokProvider,
  };
}

export function parseDevChatCreditState(searchParams: URLSearchParams): DevChatCreditState | null {
  if (!import.meta.env.DEV) return null;
  const value = searchParams.get('devCreditState');
  return value === 'low' || value === 'low-byok' || value === 'exhausted' || value === 'exhausted-byok' ? value : null;
}

export function getDevBillingCreditStatus(searchParams: URLSearchParams): BillingCreditStatus | null {
  const state = parseDevChatCreditState(searchParams);
  if (!state) return null;

  const exhausted = state === 'exhausted' || state === 'exhausted-byok';
  const byok = state === 'low-byok' || state === 'exhausted-byok';
  return {
    availableCreditsCents: exhausted ? 0 : 175,
    totalCreditLimitCents: 1000,
    usedPercent: exhausted ? 100 : 83,
    isLow: !exhausted,
    isExhausted: exhausted,
    hasByokProvider: byok,
  };
}

export function applyDevBillingCreditStatusOverride(
  status: BillingCreditStatus | null,
  searchParams: URLSearchParams,
): BillingCreditStatus | null {
  return getDevBillingCreditStatus(searchParams) ?? status;
}

export function getDevChatInitialError(searchParams: URLSearchParams): string | null {
  if (!import.meta.env.DEV) return null;
  const value = searchParams.get('devChatError');
  if (value === 'out-of-credits') {
    return 'Message not sent — top up credits or add an API key to continue.';
  }
  if (value === 'billing-required') {
    return 'Hosted models require billing access. Start a subscription or add your own API key in Settings -> AI Provider. Your workspace is saved.';
  }
  return null;
}
