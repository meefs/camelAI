import type { Env } from "../../types.js";
import { getAdminIndexStub, getOrgStub } from "./helpers.js";

const LEGACY_USAGE_SOURCE = "sandbox_host_usage_log";

interface AdminOrgDirectoryLookup {
  getOrgDirectoryRows(): Promise<Array<{ id: string }>>;
}

interface LegacyHostUsageEntry {
  id: number;
  workspace_id?: string;
  user_id?: string;
  thread_id?: string;
  model?: string;
  provider?: string;
  billing_source?: string;
  credit_chargeable?: boolean | number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
  created_at_ms?: number;
}

interface LegacyHostUsagePage {
  entries?: LegacyHostUsageEntry[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface BackfillHostUsageOptions {
  orgIds?: string[];
  dryRun?: boolean;
  pageLimit?: number;
  maxOrgs?: number;
  maxEntries?: number;
}

export interface BackfillHostUsageResult {
  dry_run: boolean;
  orgs_scanned: number;
  legacy_entries_scanned: number;
  inserted: number;
  skipped_duplicates: number;
  errors: Array<{ org_id: string; error: string }>;
  truncated: boolean;
}

function normalizeOrgIds(orgIds: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of orgIds) {
    const orgId = raw.trim();
    if (!orgId || seen.has(orgId)) continue;
    seen.add(orgId);
    normalized.push(orgId);
  }
  return normalized;
}

function asNonNegativeInteger(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function asCost(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asCreditChargeable(value: unknown): boolean {
  return value === true || value === 1;
}

async function fetchLegacyUsagePage(
  env: Pick<Env, "SANDBOX_HOST">,
  orgId: string,
  options: { limit: number; cursor?: string },
): Promise<LegacyHostUsagePage> {
  if (!env.SANDBOX_HOST) {
    throw new Error("SANDBOX_HOST binding not configured");
  }
  const params = new URLSearchParams({
    limit: String(options.limit),
  });
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  const response = await env.SANDBOX_HOST.fetch(
    `http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/log?${params}`,
  );
  if (!response.ok) {
    throw new Error(`legacy usage host returned ${response.status}`);
  }
  return (await response.json()) as LegacyHostUsagePage;
}

export async function backfillHostUsageToOrgDOs(
  env: Env,
  options: BackfillHostUsageOptions = {},
): Promise<BackfillHostUsageResult> {
  const dryRun = options.dryRun === true;
  const pageLimit = Math.min(1000, Math.max(1, options.pageLimit ?? 1000));
  const orgIds = options.orgIds
    ? normalizeOrgIds(options.orgIds)
    : normalizeOrgIds(
        (
          await (
            getAdminIndexStub(env) as unknown as AdminOrgDirectoryLookup
          ).getOrgDirectoryRows()
        ).map((org) => org.id),
      );
  const selectedOrgIds = options.maxOrgs
    ? orgIds.slice(0, Math.max(0, options.maxOrgs))
    : orgIds;

  const result: BackfillHostUsageResult = {
    dry_run: dryRun,
    orgs_scanned: 0,
    legacy_entries_scanned: 0,
    inserted: 0,
    skipped_duplicates: 0,
    errors: [],
    truncated: false,
  };

  const maxEntries =
    options.maxEntries && options.maxEntries > 0 ? options.maxEntries : null;

  for (const orgId of selectedOrgIds) {
    if (maxEntries !== null && result.legacy_entries_scanned >= maxEntries) {
      result.truncated = true;
      break;
    }
    result.orgs_scanned += 1;
    let cursor: string | undefined;
    try {
      while (true) {
        const page = await fetchLegacyUsagePage(env, orgId, {
          limit: pageLimit,
          cursor,
        });
        const entries = Array.isArray(page.entries) ? page.entries : [];
        for (const entry of entries) {
          if (maxEntries !== null && result.legacy_entries_scanned >= maxEntries) {
            result.truncated = true;
            break;
          }
          result.legacy_entries_scanned += 1;
          if (dryRun) continue;
          const write = await getOrgStub(env, orgId).recordUsage({
            workspace_id: asText(entry.workspace_id),
            user_id: asText(entry.user_id),
            thread_id: asText(entry.thread_id),
            model: asText(entry.model) || "unknown",
            provider: asText(entry.provider) || "unknown",
            billing_source: asText(entry.billing_source) || "hosted",
            credit_chargeable: asCreditChargeable(entry.credit_chargeable),
            input_tokens: asNonNegativeInteger(entry.input_tokens),
            output_tokens: asNonNegativeInteger(entry.output_tokens),
            cache_creation_input_tokens: asNonNegativeInteger(
              entry.cache_creation_input_tokens,
            ),
            cache_read_input_tokens: asNonNegativeInteger(
              entry.cache_read_input_tokens,
            ),
            cost_usd: asCost(entry.cost_usd),
            duration_ms: asNonNegativeInteger(entry.duration_ms),
            created_at_ms: asNonNegativeInteger(entry.created_at_ms),
            source: LEGACY_USAGE_SOURCE,
            source_id: String(entry.id),
          });
          if (write.inserted === false) {
            result.skipped_duplicates += 1;
          } else {
            result.inserted += 1;
          }
        }
        if (result.truncated || !page.has_more || !page.next_cursor) {
          break;
        }
        cursor = page.next_cursor;
      }
    } catch (error) {
      result.errors.push({
        org_id: orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (options.maxOrgs && orgIds.length > selectedOrgIds.length) {
    result.truncated = true;
  }

  return result;
}
