import type { OrgBillingOverview } from '@/lib/billing.server';
import {
  isCreditFreeHostedModel,
  isLlmModelCoveredByByokProvider,
  isLlmModelCoveredByOpenAiSubscription,
} from '@/lib/llm-provider-config';
import type { BillingStatus, LlmModel } from '@/types';

export interface BillingCreditStatus {
  availableCreditsCents: number;
  totalCreditLimitCents: number;
  isExhausted: boolean;
  hasByokProvider: boolean;
  billingStatus?: BillingStatus | null;
}

export const LOW_CREDIT_THRESHOLDS_CENTS = [500, 250, 100, 50] as const;

export type DevChatCreditState =
  | 'healthy'
  | 'low-500'
  | 'low-250'
  | 'low-100'
  | 'low-50'
  | 'exhausted'
  | 'exhausted-byok';

export function activeLowCreditTier(availableCents: number): number | null {
  if (availableCents <= 0) return null;
  let tier: number | null = null;
  for (const threshold of LOW_CREDIT_THRESHOLDS_CENTS) {
    if (availableCents < threshold && (tier === null || threshold < tier)) {
      tier = threshold;
    }
  }
  return tier;
}

export function shouldShowLowCreditAlert(
  activeTier: number | null,
  dismissedTier: number | null,
): boolean {
  if (activeTier === null) return false;
  return dismissedTier === null || activeTier < dismissedTier;
}

export function buildBillingCreditStatus(
  overview: OrgBillingOverview | null,
  byokProvider: string | null | undefined | boolean,
  _threadModel?: LlmModel | null,
): BillingCreditStatus | null {
  if (!overview || overview.billing_status === 'enterprise') {
    return null;
  }
  const hasByokProvider = Boolean(byokProvider);

  return {
    availableCreditsCents: overview.available_credits_cents,
    totalCreditLimitCents: overview.total_credit_limit_cents,
    isExhausted: overview.available_credits_cents <= 0,
    hasByokProvider,
    billingStatus: overview.billing_status,
  };
}

export function resolveDisplayedBillingCreditStatus(
  status: BillingCreditStatus | null | undefined,
  threadModel: LlmModel | null | undefined,
  hostedCreditsPaused: boolean,
  byokProvider?: string | null,
  allowOpenAiSubscription = false,
): BillingCreditStatus | null {
  if (isCreditFreeHostedModel(threadModel) && !hostedCreditsPaused) {
    return null;
  }
  if (
    isLlmModelCoveredByByokProvider(threadModel, byokProvider) ||
    (threadModel &&
      allowOpenAiSubscription &&
      isLlmModelCoveredByOpenAiSubscription(threadModel))
  ) {
    return null;
  }
  return status ?? null;
}

export function shouldSwitchExhaustedThreadModel(
  status: BillingCreditStatus | null | undefined,
  threadModel: LlmModel | null | undefined,
  byokProvider?: string | null,
  allowOpenAiSubscription = false,
): boolean {
  return Boolean(
    status?.isExhausted &&
      threadModel &&
      !isCreditFreeHostedModel(threadModel) &&
      !isLlmModelCoveredByByokProvider(threadModel, byokProvider) &&
      !(
        allowOpenAiSubscription &&
        isLlmModelCoveredByOpenAiSubscription(threadModel)
      ),
  );
}

export function resolveRefreshedThreadModel(
  currentModel: LlmModel,
  refresh:
    | {
        requestedModel: LlmModel;
        model: LlmModel;
      }
    | null
    | undefined,
): LlmModel | null {
  if (!refresh || refresh.requestedModel !== currentModel) return null;
  return refresh.model === currentModel ? null : refresh.model;
}

export function parseDevChatCreditState(searchParams: URLSearchParams): DevChatCreditState | null {
  if (!import.meta.env.DEV) return null;
  const value = searchParams.get('devCreditState');
  return value === 'healthy' ||
    value === 'low-500' ||
    value === 'low-250' ||
    value === 'low-100' ||
    value === 'low-50' ||
    value === 'exhausted' ||
    value === 'exhausted-byok'
    ? value
    : null;
}

export function getDevBillingCreditStatus(searchParams: URLSearchParams): BillingCreditStatus | null {
  const state = parseDevChatCreditState(searchParams);
  if (!state) return null;

  const availableCreditsByState: Record<DevChatCreditState, number> = {
    healthy: 650,
    'low-500': 450,
    'low-250': 220,
    'low-100': 80,
    'low-50': 45,
    exhausted: 0,
    'exhausted-byok': 0,
  };
  const exhausted = state === 'exhausted' || state === 'exhausted-byok';
  return {
    availableCreditsCents: availableCreditsByState[state],
    totalCreditLimitCents: 1000,
    isExhausted: exhausted,
    hasByokProvider: state === 'exhausted-byok',
  };
}

export function applyDevBillingCreditStatusOverride(
  status: BillingCreditStatus | null,
  searchParams: URLSearchParams,
): BillingCreditStatus | null {
  const override = getDevBillingCreditStatus(searchParams);
  return override
    ? {
        ...override,
        billingStatus: status?.billingStatus ?? null,
      }
    : status;
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
