export interface ScriptUsage {
  scriptName: string;
  rowsRead: number;
  rowsWritten: number;
}

interface GraphqlResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        groups?: Array<{
          dimensions?: { namespaceId?: unknown };
          sum?: { rowsRead?: unknown; rowsWritten?: unknown };
        }>;
      }>;
    };
  } | null;
  errors?: Array<{ message?: string }> | null;
}

interface NamespaceResponse {
  success?: boolean;
  result?: { script?: unknown };
  errors?: Array<{ message?: string }>;
}

// Namespace ownership never changes, so the mapping is safe to keep for the
// isolate's lifetime. A deleted namespace resolves to null and is skipped.
const namespaceScripts = new Map<string, Promise<string | null>>();

// Far more than the account's namespace count; a full page could hide usage,
// so it is an error rather than a silent undercount.
const GROUP_LIMIT = 10_000;

const QUERY = `query DurableObjectRows($accountTag: string!, $from: Time!, $to: Time!, $limit: uint64!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      groups: durableObjectsPeriodicGroups(
        limit: $limit
        filter: { datetimeMinute_geq: $from, datetimeMinute_lt: $to }
      ) {
        dimensions { namespaceId }
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

async function resolveNamespaceScript(input: {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  fetcher: typeof fetch;
}): Promise<string | null> {
  const response = await input.fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(input.namespaceId)}`,
    { headers: { Authorization: `Bearer ${input.apiToken}` } },
  );
  if (response.status === 404) return null;
  const body = await response.json<NamespaceResponse>().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Durable Object namespace lookup failed for ${input.namespaceId}: ${message}`);
  }
  return typeof body.result?.script === "string" && body.result.script.trim() ? body.result.script.trim() : null;
}

function namespaceScript(input: {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  fetcher: typeof fetch;
}): Promise<string | null> {
  const cached = namespaceScripts.get(input.namespaceId);
  if (cached) return cached;
  const pending = resolveNamespaceScript(input);
  namespaceScripts.set(input.namespaceId, pending);
  // Failures are not cached; the next run retries the lookup.
  pending.catch(() => namespaceScripts.delete(input.namespaceId));
  return pending;
}

export function clearNamespaceScriptCache(): void {
  namespaceScripts.clear();
}

/**
 * Sums Durable Object SQLite rows by owning script from the account's billing
 * analytics. Workers Observability events no longer carry row counts.
 */
export async function queryDurableObjectRows(input: {
  accountId: string;
  apiToken: string;
  from: number;
  to: number;
  fetcher?: typeof fetch;
}): Promise<{ runId: string | null; usage: ScriptUsage[] }> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        accountTag: input.accountId,
        from: new Date(input.from).toISOString(),
        to: new Date(input.to).toISOString(),
        limit: GROUP_LIMIT,
      },
    }),
  });
  const body = await response.json<GraphqlResponse>().catch(() => null);
  if (!response.ok || !body?.data || body.errors?.length) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Durable Object analytics query failed: ${message}`);
  }
  const accounts = body.data.viewer?.accounts;
  if (!accounts || accounts.length !== 1) {
    throw new Error("Durable Object analytics query returned no account");
  }
  const groups = accounts[0].groups ?? [];
  if (groups.length >= GROUP_LIMIT) {
    throw new Error(`Durable Object analytics query reached its ${GROUP_LIMIT} group limit`);
  }

  const byNamespace = new Map<string, { rowsRead: number; rowsWritten: number }>();
  for (const group of groups) {
    const namespaceId = group.dimensions?.namespaceId;
    if (typeof namespaceId !== "string" || !namespaceId) continue;
    const rowsRead = finiteCounter(group.sum?.rowsRead);
    const rowsWritten = finiteCounter(group.sum?.rowsWritten);
    if (rowsRead === 0 && rowsWritten === 0) continue;
    const usage = byNamespace.get(namespaceId) ?? { rowsRead: 0, rowsWritten: 0 };
    usage.rowsRead += rowsRead;
    usage.rowsWritten += rowsWritten;
    byNamespace.set(namespaceId, usage);
  }

  const byScript = new Map<string, ScriptUsage>();
  const owners = await Promise.all([...byNamespace.keys()].map((namespaceId) =>
    namespaceScript({ accountId: input.accountId, apiToken: input.apiToken, namespaceId, fetcher })));
  [...byNamespace.values()].forEach((usage, index) => {
    const scriptName = owners[index];
    if (!scriptName) return;
    const total = byScript.get(scriptName) ?? { scriptName, rowsRead: 0, rowsWritten: 0 };
    total.rowsRead += usage.rowsRead;
    total.rowsWritten += usage.rowsWritten;
    byScript.set(scriptName, total);
  });

  return { runId: null, usage: [...byScript.values()] };
}
