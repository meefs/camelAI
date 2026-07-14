import { normalizeDispatchScriptVersion } from "../../main/src/usage-guard-config.js";

export interface ScriptUsage {
  scriptName: string;
  scriptVersion: string;
  rowsRead: number;
  rowsWritten: number;
}

interface Aggregate {
  value?: number;
  groups?: Array<{ key?: string; value?: unknown }>;
}

interface TelemetryResponse {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: {
    run?: { id?: string; statistics?: { abr_level?: number } };
    calculations?: Array<{ alias?: string; aggregates?: Aggregate[] }>;
  };
}

function aggregateGroup(aggregate: Aggregate, key: string): string | null {
  const group = aggregate.groups?.find((candidate) => candidate.key === key);
  return typeof group?.value === "string" && group.value.trim() ? group.value.trim() : null;
}

export function scriptUsageKey(scriptName: string, scriptVersion: string): string {
  return `${scriptName}\0${normalizeDispatchScriptVersion(scriptVersion)}`;
}

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export async function queryDurableObjectRows(input: {
  accountId: string;
  apiToken: string;
  from: number;
  to: number;
  fetcher?: typeof fetch;
}): Promise<{ runId: string | null; usage: ScriptUsage[] }> {
  const fetcher = input.fetcher ?? fetch;
  const byScript = new Map<string, ScriptUsage>();
  let runId: string | null = null;
  const pageSize = 2_000;

  for (let offsetBy = 0; ; offsetBy += pageSize) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          queryId: `camelai-usage-guard-${input.from}-${input.to}-${offsetBy}`,
          timeframe: { from: input.from, to: input.to },
          view: "calculations",
          dry: true,
          ignoreSeries: true,
          limit: pageSize,
          offsetBy,
          parameters: {
            datasets: ["cloudflare-workers"],
            calculations: [
              {
                operator: "sum",
                alias: "rows_read",
                key: "cloudflare.durable_object.response.rows_read",
                keyType: "number",
              },
              {
                operator: "sum",
                alias: "rows_written",
                key: "cloudflare.durable_object.response.rows_written",
                keyType: "number",
              },
            ],
            groupBys: [
              { type: "string", value: "cloudflare.script_name" },
              { type: "string", value: "cloudflare.script_version.id" },
            ],
            limit: pageSize,
          },
        }),
      },
    );
    const body = await response.json<TelemetryResponse>();
    if (!response.ok || body.success !== true || !body.result) {
      const message = body.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
      throw new Error(`Workers Observability query failed: ${message}`);
    }
    const abrLevel = body.result.run?.statistics?.abr_level ?? 1;
    if (abrLevel !== 1) {
      throw new Error(`Workers Observability query used unsupported ABR level ${abrLevel}`);
    }
    runId ??= body.result.run?.id ?? null;

    let largestPage = 0;
    for (const calculation of body.result.calculations ?? []) {
      const aggregates = calculation.aggregates ?? [];
      largestPage = Math.max(largestPage, aggregates.length);
      for (const aggregate of aggregates) {
        const scriptName = aggregateGroup(aggregate, "cloudflare.script_name");
        const scriptVersion = aggregateGroup(aggregate, "cloudflare.script_version.id");
        if (!scriptName || !scriptVersion) continue;
        const key = scriptUsageKey(scriptName, scriptVersion);
        const usage = byScript.get(key) ?? { scriptName, scriptVersion, rowsRead: 0, rowsWritten: 0 };
        if (calculation.alias === "rows_read") usage.rowsRead += finiteCounter(aggregate.value);
        if (calculation.alias === "rows_written") usage.rowsWritten += finiteCounter(aggregate.value);
        byScript.set(key, usage);
      }
    }
    if (largestPage < pageSize) break;
  }

  return { runId, usage: [...byScript.values()] };
}
