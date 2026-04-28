import type { AdminOrgDirectoryRow } from '../../admin-index-do.js';
import type { Env } from '../../types.js';

export interface OrgUsageAnalyticsItem {
  org_id: string;
  total_cost_usd: number;
  total_requests: number;
  spend_7d: number;
  spend_30d: number;
  windows: Array<{
    label: string;
    window_ms: number;
    limit_usd: number;
    spent_usd: number;
    exceeded: boolean;
  }>;
}

export interface DailySpendAnalyticsSummary {
  date: string;
  total_spend_usd: number;
  total_requests: number;
  spam_spend_usd: number;
  non_spam_spend_usd: number;
}

export interface DailySpendAnalyticsHourlyRow {
  hour: number;
  spend_usd: number;
  requests: number;
  spam_spend_usd: number;
  non_spam_spend_usd: number;
}

export interface DailySpendAnalyticsHostModelRow {
  model: string;
  spend_usd: number;
  requests: number;
}

export interface DailySpendAnalyticsHostOrgRow {
  org_id: string;
  spend_usd: number;
  requests: number;
  is_spam: boolean;
}

export interface DailySpendAnalyticsHostResponse {
  date: string;
  is_partial: boolean;
  total_spend_usd: number;
  total_requests: number;
  spam_spend_usd: number;
  non_spam_spend_usd: number;
  spam_org_count: number;
  non_spam_org_count: number;
  previous_day: DailySpendAnalyticsSummary;
  hourly_series: DailySpendAnalyticsHourlyRow[];
  model_breakdown: DailySpendAnalyticsHostModelRow[];
  top_orgs: DailySpendAnalyticsHostOrgRow[];
  other_orgs_spend_usd: number;
  other_orgs_count: number;
}

export interface DailySpendDashboardModelRow extends DailySpendAnalyticsHostModelRow {
  pct_of_total: number;
}

export interface DailySpendDashboardOrgRow extends DailySpendAnalyticsHostOrgRow {
  org_name: string;
  org_slug: string | null;
  billing_plan: string;
}

export interface DailySpendDashboardResponse
  extends Omit<DailySpendAnalyticsHostResponse, 'model_breakdown' | 'top_orgs'> {
  model_breakdown: DailySpendDashboardModelRow[];
  top_orgs: DailySpendDashboardOrgRow[];
}

async function fetchSandboxHostJson<T>(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!env.SANDBOX_HOST) {
    throw new Error('SANDBOX_HOST binding not configured');
  }

  const response = await env.SANDBOX_HOST.fetch(`http://sandbox${path}`, init);
  if (!response.ok) {
    throw new Error(`Sandbox host returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchSpamOrgIds(env: Env): Promise<string[]> {
  const response = await fetchSandboxHostJson<{ org_ids: string[] }>(
    env,
    '/v1/usage/analytics/spam-org-ids',
  );
  return response.org_ids ?? [];
}

export async function fetchOrgUsageAnalytics(
  env: Env,
  orgIds: string[],
  options: {
    includeWindows?: boolean;
  } = {},
): Promise<Map<string, OrgUsageAnalyticsItem>> {
  const dedupedOrgIds = Array.from(
    new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
  );
  if (dedupedOrgIds.length === 0) {
    return new Map();
  }

  const response = await fetchSandboxHostJson<{ items: OrgUsageAnalyticsItem[] }>(
    env,
    '/v1/usage/analytics/orgs/query',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_ids: dedupedOrgIds,
        include_windows: options.includeWindows ?? false,
      }),
    },
  );

  return new Map(
    (response.items ?? []).map((item) => [
      item.org_id,
      {
        ...item,
        windows: item.windows ?? [],
      },
    ]),
  );
}

export async function fetchDailySpendAnalytics(
  env: Env,
  options: {
    date: string;
    orgIds: string[];
    topOrgsLimit: number;
  },
): Promise<DailySpendAnalyticsHostResponse> {
  return fetchSandboxHostJson<DailySpendAnalyticsHostResponse>(
    env,
    '/v1/usage/analytics/daily-spend/query',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: options.date,
        org_ids: options.orgIds,
        top_orgs_limit: options.topOrgsLimit,
      }),
    },
  );
}

export function normalizeInternalDomains(
  rawValue: string | undefined,
  defaultDomains: string[] = [],
): Set<string> {
  const source = rawValue && rawValue.trim().length > 0 ? rawValue : defaultDomains.join(',');
  return new Set(
    source
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .map((domain) => domain.replace(/^@+/, '').replace(/\.+$/, ''))
      .filter((domain) => domain.length > 0),
  );
}

export function getEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) {
    return null;
  }
  return email.slice(atIndex + 1).trim().toLowerCase();
}

export function isOrgExcludedByInternalDomains(
  org: Pick<AdminOrgDirectoryRow, 'creator_email'>,
  internalDomains: Set<string>,
): boolean {
  if (internalDomains.size === 0) {
    return false;
  }
  const domain = getEmailDomain(org.creator_email);
  return domain ? internalDomains.has(domain) : false;
}

export function normalizeBillingStatus(status: string | null | undefined): 'active' | 'free' {
  return status === 'paying' || status === 'active' || status === 'trialing' || status === 'enterprise' ? 'active' : 'free';
}
