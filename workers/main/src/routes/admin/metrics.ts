import type { AdminOrgDirectoryRow } from '../../admin-index-types.js';
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

export async function fetchSpamOrgIds(env: Env): Promise<string[]> {
  void env;
  return [];
}

export async function fetchOrgUsageAnalytics(
  env: Env,
  orgIds: string[],
  options: {
    includeWindows?: boolean;
  } = {},
): Promise<Map<string, OrgUsageAnalyticsItem>> {
  void env;
  const dedupedOrgIds = Array.from(
    new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
  );
  if (dedupedOrgIds.length === 0) {
    return new Map();
  }

  void options;
  return new Map();
}

export async function fetchDailySpendAnalytics(
  env: Env,
  options: {
    date: string;
    orgIds: string[];
    topOrgsLimit: number;
  },
): Promise<DailySpendAnalyticsHostResponse> {
  void env;
  void options.orgIds;
  void options.topOrgsLimit;
  return {
    date: options.date,
    is_partial: false,
    total_spend_usd: 0,
    total_requests: 0,
    spam_spend_usd: 0,
    non_spam_spend_usd: 0,
    spam_org_count: 0,
    non_spam_org_count: 0,
    previous_day: {
      date: options.date,
      total_spend_usd: 0,
      total_requests: 0,
      spam_spend_usd: 0,
      non_spam_spend_usd: 0,
    },
    hourly_series: [],
    model_breakdown: [],
    top_orgs: [],
    other_orgs_spend_usd: 0,
    other_orgs_count: 0,
  };
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
