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

export function normalizeInternalDomains(
  rawValue: string | undefined,
  defaultDomains: string[] = [],
): Set<string> {
  const source = rawValue ?? defaultDomains.join(',');
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
  return status === 'paying' ? 'active' : 'free';
}

export function compareOrgRows(
  left: Pick<AdminOrgDirectoryRow, 'created_at' | 'name' | 'id'>,
  right: Pick<AdminOrgDirectoryRow, 'created_at' | 'name' | 'id'>,
  sortBy: 'created_at' | 'name',
  sortDir: 'asc' | 'desc',
): number {
  const direction = sortDir === 'asc' ? 1 : -1;
  if (sortBy === 'name') {
    const nameComparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    if (nameComparison !== 0) return nameComparison * direction;
    return left.id.localeCompare(right.id) * direction;
  }

  if (left.created_at !== right.created_at) {
    return (left.created_at - right.created_at) * direction;
  }
  return left.id.localeCompare(right.id) * direction;
}
