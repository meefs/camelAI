#!/usr/bin/env bun
/**
 * Re-applies user-app cost controls (Durable Object alarm guard + CPU limit)
 * to apps deployed before they existed, by replaying each app's latest cached
 * deploy artifact through the main worker's rollback path
 * (POST /api/admin/apps/:dispatchScriptName/cost-controls).
 *
 * Dry run by default: only Cloudflare API reads (namespace scripts, script
 * settings, D1 usage-guard state, GraphQL analytics). --apply redeploys, which
 * restarts every Durable Object instance of each replayed app.
 *
 * Usage: bun scripts/backfill-user-app-cost-controls.ts --env staging|prod [--apply]
 *          [--scripts a,b,c] [--limit N] [--order name|alarm-spend] [--delay-ms N]
 *
 * Env: CLOUDFLARE_API_TOKEN (Workers Scripts read, D1 read, Analytics read);
 *      ADMIN_API_KEY for the target environment when --apply is set.
 */

import path from "node:path";

import {
  userAppCostControlsConfig,
  readDispatchScriptEntrypoint,
  readDispatchScriptSettings,
  type CostControlsBackfillGuardState,
  type CostControlsBackfillSkipReason,
  type UserAppCostControlsEnv,
} from "../workers/main/src/user-app-cost-controls-policy";
import {
  BACKFILL_USAGE,
  alarmInvocationsByScript,
  parseBackfillArgs,
  runBackfill,
  selectBackfillCandidates,
  summarizeBackfill,
  type AlarmInvocationGroup,
} from "./lib/user-app-cost-controls-backfill";

const CF_API = "https://api.cloudflare.com/client/v4";
const OPERATION_LEASE_PREFIX = "app-operation:";

interface WranglerEnvConfig {
  vars?: Record<string, string> & UserAppCostControlsEnv;
  d1_databases?: Array<{ binding: string; database_id: string }>;
}

async function cloudflare<T>(token: string, url: string, init: RequestInit = {}): Promise<{ result: T; result_info?: { cursor?: string } }> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json() as { success?: boolean; result: T; result_info?: { cursor?: string }; errors?: unknown };
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API ${init.method ?? "GET"} ${url} failed: HTTP ${response.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body;
}

async function listLiveScripts(token: string, accountId: string, namespace: string): Promise<string[]> {
  const names: string[] = [];
  let cursor = "";
  do {
    const url = `${CF_API}/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const page = await cloudflare<Array<{ id: string }>>(token, url);
    names.push(...page.result.map((script) => script.id));
    const next = page.result_info?.cursor ?? "";
    cursor = next && next !== cursor && page.result.length > 0 ? next : "";
  } while (cursor);
  return [...new Set(names)];
}

async function queryD1<T>(token: string, accountId: string, databaseId: string, sql: string): Promise<T[]> {
  const body = await cloudflare<Array<{ results: T[] }>>(token, `${CF_API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
  return body.result[0]?.results ?? [];
}

async function alarmInvocationsLast7Days(token: string, accountId: string): Promise<Map<string, number>> {
  const today = new Date();
  const from = new Date(today.getTime() - 7 * 86_400_000);
  const query = `query($accountTag: String!, $from: Date!, $to: Date!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $from, date_leq: $to, type: "alarm" }
        orderBy: [sum_requests_DESC]
      ) { sum { requests } dimensions { scriptName type } }
    } }
  }`;
  const response = await fetch(`${CF_API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) },
    }),
  });
  const body = await response.json() as {
    data?: { viewer?: { accounts?: Array<{ durableObjectsInvocationsAdaptiveGroups?: AlarmInvocationGroup[] }> } };
    errors?: unknown;
  };
  if (!response.ok || body.errors) throw new Error(`GraphQL alarm query failed: ${JSON.stringify(body.errors ?? response.status)}`);
  return alarmInvocationsByScript(body.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? []);
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${BACKFILL_USAGE}`);
    return 2;
  }
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? "").trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const adminKey = (process.env.ADMIN_API_KEY ?? "").trim();
  if (args.apply && !adminKey) throw new Error(`ADMIN_API_KEY for ${args.env} is required with --apply`);

  const rootDir = path.resolve(import.meta.dir, "..");
  const wrangler = Bun.JSONC.parse(await Bun.file(path.join(rootDir, `wrangler.${args.env}.jsonc`)).text()) as WranglerEnvConfig;
  const vars = wrangler.vars ?? {};
  const accountId = vars.CF_ACCOUNT_ID;
  const namespace = vars.CF_DISPATCH_NAMESPACE;
  const baseUrl = vars.WORKER_BASE_URL;
  const databaseId = wrangler.d1_databases?.find((database) => database.binding === "APP_DB")?.database_id;
  if (!accountId || !namespace || !baseUrl || !databaseId) {
    throw new Error(`wrangler.${args.env}.jsonc is missing CF_ACCOUNT_ID, CF_DISPATCH_NAMESPACE, WORKER_BASE_URL or APP_DB`);
  }
  // The deployed main worker applies controls from its own vars; mirror them
  // so "already-applied" matches what an upload would produce.
  const config = userAppCostControlsConfig(vars);

  console.log(`${args.apply ? "APPLY" : "DRY RUN"} env=${args.env} namespace=${namespace} order=${args.order}` +
    `${args.limit !== null ? ` limit=${args.limit}` : ""}${args.scripts ? ` scripts=${args.scripts.length}` : ""}`);
  console.log(`controls: cpu_ms=${config.cpuMs} alarmMinIntervalMs=${config.alarmMinIntervalMs} alarmDailyBudget=${config.alarmDailyBudget}`);

  const liveScripts = await listLiveScripts(token, accountId, namespace);
  const guardRows = await queryD1<CostControlsBackfillGuardState & { dispatch_script_name: string }>(token, accountId, databaseId, `
    SELECT app_id, dispatch_script_name, org_id, workspace_id, script_name, status, artifact_cache_key
    FROM app_usage_guard_state
  `);
  const leaseRows = await queryD1<{ name: string; expires_at: number }>(token, accountId, databaseId,
    `SELECT name, expires_at FROM app_usage_guard_leases WHERE name LIKE '${OPERATION_LEASE_PREFIX}%'`);
  const leases = new Map(leaseRows.map((row) => [row.name, row.expires_at]));
  const alarms = args.order === "alarm-spend" ? await alarmInvocationsLast7Days(token, accountId) : new Map<string, number>();
  const { candidates, notLive } = selectBackfillCandidates(liveScripts, args, alarms);
  console.log(`live scripts=${liveScripts.length} usage-guard rows=${guardRows.length} candidates=${candidates.length}\n`);
  for (const name of notLive) console.log(`skipped      ${name} (not-live)`);

  const api = (scriptName: string) => ({ accountId, dispatchNamespace: namespace, scriptName, apiToken: token });
  const outcomes = await runBackfill(candidates, args, config, {
    guardStates: new Map(guardRows.map((row) => [row.dispatch_script_name, row])),
    leaseExpiresAt: (appId) => leases.get(`${OPERATION_LEASE_PREFIX}${appId}`) ?? null,
    readSettings: (name) => readDispatchScriptSettings(api(name)),
    readEntrypoint: (name) => readDispatchScriptEntrypoint(api(name)),
    applyOne: async (name) => {
      const response = await fetch(`${baseUrl}/api/admin/apps/${encodeURIComponent(name)}/cost-controls`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      const body = await response.json().catch(() => ({})) as {
        status?: "applied" | "skipped";
        reason?: CostControlsBackfillSkipReason;
        scriptVersion?: string;
        error?: string;
      };
      if (!response.ok || !body.status) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body.status === "applied"
        ? { status: "applied", ...(body.scriptVersion ? { scriptVersion: body.scriptVersion } : {}) }
        : { status: "skipped", reason: body.reason! };
    },
    sleep: (ms) => Bun.sleep(ms),
    log: (line) => console.log(line),
    now: () => Date.now(),
  });

  const summary = summarizeBackfill([
    ...notLive.map((dispatchScriptName) => ({ dispatchScriptName, result: "skipped" as const, reason: "not-live" as const })),
    ...outcomes,
  ]);
  const skipped = Object.entries(summary.skipped).map(([reason, count]) => `${reason}=${count}`).join(" ") || "none";
  console.log(`\nSummary: ${args.apply ? `applied=${summary.applied}` : `would-apply=${summary.wouldApply}`}` +
    ` skipped=${Object.values(summary.skipped).reduce((sum, count) => sum + (count ?? 0), 0)} (${skipped}) failed=${summary.failed}`);
  return summary.failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
