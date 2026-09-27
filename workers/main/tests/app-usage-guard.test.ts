import { env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runUsageGuard } from "../../app-usage-guard/src/index";
import { evaluateUsage, estimatedSqliteCostUsd, type UsageWindow } from "../../app-usage-guard/src/policy";
import { quarantineDispatchScript, quarantineModule } from "../../app-usage-guard/src/quarantine";
import { clearNamespaceScriptCache, queryDurableObjectRows } from "../../app-usage-guard/src/telemetry";
import {
  acquireUsageGuardOperationLease,
  acquireUsageGuardOperationLeaseWithRetry,
  ensureUsageGuardSchema,
  releaseUsageGuardOperationLease,
  USAGE_GUARD_OPERATION_LEASE_TTL_MS,
} from "../src/usage-guard-state";

function window(overrides: Partial<UsageWindow>): UsageWindow {
  const usage = {
    scriptName: "demo--acme",
    rowsRead: 0,
    rowsWritten: 0,
    windowMinutes: 15 as const,
    estimatedCostUsd: 0,
    runId: "run-1",
    windowEnd: 1_000,
    ...overrides,
  };
  return usage;
}

describe("app usage guard policy", () => {
  it("calculates gross SQLite row cost", () => {
    expect(estimatedSqliteCostUsd({ rowsRead: 1_000_000, rowsWritten: 2_000_000 })).toBe(2.001);
  });

  it("warns, suspends on the raw write limit, and recognizes catastrophic cost", () => {
    expect(evaluateUsage([window({ estimatedCostUsd: 0.5 })])).toMatchObject({ action: "warn" });
    expect(evaluateUsage([window({ rowsWritten: 1_000_000, estimatedCostUsd: 1 })])).toMatchObject({
      action: "suspend",
      catastrophic: false,
    });
    expect(evaluateUsage([window({ estimatedCostUsd: 5 })])).toMatchObject({
      action: "suspend",
      catastrophic: true,
    });
  });
});

describe.sequential("usage guard operation leases", () => {
  const db = (testEnv as unknown as { APP_DB: D1Database }).APP_DB;
  const appId = "lease-test-org:lease-test-app";
  const leaseName = `app-operation:${appId}`;

  afterEach(async () => {
    await db.prepare("DELETE FROM app_usage_guard_leases WHERE name = ?").bind(leaseName).run();
  });

  it("allows an abandoned lease to be replaced after one minute", async () => {
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "first", now: 1_000 })).toBe(true);
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "second", now: 1_000 + USAGE_GUARD_OPERATION_LEASE_TTL_MS - 1 })).toBe(false);
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "second", now: 1_000 + USAGE_GUARD_OPERATION_LEASE_TTL_MS })).toBe(true);
  });

  it("waits through brief contention and acquires the expired lease", async () => {
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "first", now: 0, ttlMs: 1_000 })).toBe(true);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    const result = await acquireUsageGuardOperationLeaseWithRetry(
      { db, appId, holder: "second", ttlMs: 1_000, waitMs: 1_500, retryMs: 500 },
      { now: () => now, sleep, random: () => 0.5 },
    );

    expect(result).toEqual({ acquired: true, attempts: 3, waitedMs: 1_000 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops waiting at the acquisition deadline", async () => {
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "first", now: 0 })).toBe(true);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await acquireUsageGuardOperationLeaseWithRetry(
      { db, appId, holder: "second", waitMs: 1_000, retryMs: 500 },
      { now: () => now, sleep, random: () => 0.5 },
    );

    expect(result).toEqual({ acquired: false, attempts: 3, waitedMs: 1_000 });
    expect(consoleWarn).toHaveBeenCalledWith(
      "[usage-guard-lease] acquisition timed out",
      expect.objectContaining({ appId, attempts: 3, waitedMs: 1_000 }),
    );
    consoleWarn.mockRestore();
  });

  it("does not let an old holder release a replacement lease", async () => {
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "first", now: 0, ttlMs: 1_000 })).toBe(true);
    expect(await acquireUsageGuardOperationLease({ db, appId, holder: "second", now: 1_000, ttlMs: 1_000 })).toBe(true);

    await releaseUsageGuardOperationLease({ db, appId, holder: "first" });

    const row = await db.prepare("SELECT holder FROM app_usage_guard_leases WHERE name = ?")
      .bind(leaseName)
      .first<{ holder: string }>();
    expect(row?.holder).toBe("second");
  });
});

function analyticsResponse(groups: Array<{ namespaceId: string; rowsRead: number; rowsWritten: number }>) {
  return Response.json({
    data: {
      viewer: {
        accounts: [{
          groups: groups.map(({ namespaceId, rowsRead, rowsWritten }) => ({
            dimensions: { namespaceId },
            sum: { rowsRead, rowsWritten },
          })),
        }],
      },
    },
    errors: null,
  });
}

function namespaceResponse(url: string, owners: Record<string, string>) {
  const namespaceId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
  const script = owners[namespaceId];
  if (!script) return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
  return Response.json({ success: true, result: { id: namespaceId, script } });
}

describe("Durable Object analytics", () => {
  afterEach(() => clearNamespaceScriptCache());

  it("sums rows by owning script and skips deleted namespaces", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
        expect(body.variables).toMatchObject({
          accountTag: "account",
          from: "2026-09-27T00:00:00.000Z",
          to: "2026-09-27T00:15:00.000Z",
        });
        return analyticsResponse([
          { namespaceId: "ns-a", rowsRead: 4000, rowsWritten: 1000 },
          { namespaceId: "ns-b", rowsRead: 2, rowsWritten: 2 },
          { namespaceId: "ns-deleted", rowsRead: 0, rowsWritten: 9 },
          { namespaceId: "ns-idle", rowsRead: 0, rowsWritten: 0 },
        ]);
      }
      return namespaceResponse(url, { "ns-a": "demo--acme", "ns-b": "demo--acme", "ns-idle": "idle--acme" });
    });

    await expect(queryDurableObjectRows({
      accountId: "account",
      apiToken: "token",
      from: Date.parse("2026-09-27T00:00:00Z"),
      to: Date.parse("2026-09-27T00:15:00Z"),
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toEqual({
      runId: null,
      usage: [{ scriptName: "demo--acme", rowsRead: 4002, rowsWritten: 1002 }],
    });
    // Namespaces with no usage are never looked up.
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("ns-idle"))).toEqual([]);
  });

  it("caches namespace owners across queries", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/graphql")) return analyticsResponse([{ namespaceId: "ns-a", rowsRead: 1, rowsWritten: 1 }]);
      return namespaceResponse(url, { "ns-a": "demo--acme" });
    });
    const query = () => queryDurableObjectRows({
      accountId: "account",
      apiToken: "token",
      from: 1,
      to: 2,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await Promise.all([query(), query()]);
    await query();
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/durable_objects/namespaces/"))).toHaveLength(1);
  });

  it("fails loudly on query errors instead of reporting zero usage", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: null, errors: [{ message: "not authorized" }] }));
    await expect(queryDurableObjectRows({
      accountId: "account",
      apiToken: "token",
      from: 1,
      to: 2,
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow("Durable Object analytics query failed: not authorized");
  });

  it("fails when a namespace owner cannot be resolved", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/graphql")) return analyticsResponse([{ namespaceId: "ns-a", rowsRead: 1, rowsWritten: 1 }]);
      return Response.json({ success: false, errors: [{ message: "rate limited" }] }, { status: 429 });
    });
    await expect(queryDurableObjectRows({
      accountId: "account",
      apiToken: "token",
      from: 1,
      to: 2,
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow("namespace lookup failed for ns-a: rate limited");
  });
});

describe("runtime quarantine", () => {
  it("exports safe alarm handlers for every local Durable Object class", () => {
    const module = quarantineModule(["AlarmDO", "OtherDO"]);
    expect(module).toContain("async alarm() {}");
    expect(module).toContain("This app needs an update");
    expect(module).toContain('"X-CamelAI-App-Status": "suspended"');
    expect(module).toContain("export { QuarantinedDurableObject as AlarmDO }");
    expect(module).toContain("export { QuarantinedDurableObject as OtherDO }");
  });

  it("preserves bindings, omits migrations, and verifies the live version", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/settings")) {
        return Response.json({
          success: true,
          result: {
            compatibility_date: "2026-07-01",
            bindings: [
              { type: "durable_object_namespace", name: "ALARM", class_name: "AlarmDO" },
              { type: "plain_text", name: "VALUE", text: "kept" },
              { type: "secret_text", name: "SECRET" },
            ],
          },
        });
      }
      if (!init?.method && url.endsWith("/demo--acme")) {
        return Response.json({ success: true, result: { deployment_id: "eligible-version" } });
      }
      return Response.json({ success: true, result: { deployment_id: "quarantine-version" } });
    });

    await expect(quarantineDispatchScript({
      accountId: "account",
      dispatchNamespace: "namespace",
      scriptName: "demo--acme",
      apiToken: "token",
      expectedVersion: "eligible-version",
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toBe("quarantine-version");

    const upload = fetcher.mock.calls.find((call) => call[1]?.method === "PUT");
    const form = upload?.[1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "durable_object_namespace", name: "ALARM", class_name: "AlarmDO" }),
      { type: "inherit", name: "VALUE" },
      { type: "plain_text", name: "CAMELAI_USAGE_GUARD_QUARANTINE", text: "eligible-version" },
    ]));
    expect(metadata.bindings).not.toContainEqual(expect.objectContaining({ name: "SECRET" }));
    expect(metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(metadata.keep_assets).toBe(true);
    expect(metadata.migrations).toBeUndefined();
    expect(metadata.observability.traces).toEqual({ enabled: true, persist: true, head_sampling_rate: 1 });
  });

  it("recognizes an already-installed quarantine on retry", async () => {
    const fetcher = vi.fn(async () => Response.json({
      success: true,
      result: { bindings: [{ type: "plain_text", name: "CAMELAI_USAGE_GUARD_QUARANTINE", text: "eligible-version" }] },
    }));
    await expect(quarantineDispatchScript({
      accountId: "account",
      dispatchNamespace: "namespace",
      scriptName: "demo--acme",
      apiToken: "token",
      expectedVersion: "eligible-version",
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toBe("quarantine:eligible-version");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite a newer user deployment", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/settings")) return Response.json({ success: true, result: { bindings: [] } });
      return Response.json({ success: true, result: { deployment_id: "newer-version" } });
    });
    await expect(quarantineDispatchScript({
      accountId: "account",
      dispatchNamespace: "namespace",
      scriptName: "demo--acme",
      apiToken: "token",
      expectedVersion: "old-version",
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow("Refusing to quarantine stale deployment");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

type GuardTestEnv = {
  APP_DB: D1Database;
  APP_KV: KVNamespace;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CF_DISPATCH_NAMESPACE: string;
  USAGE_GUARD_MODE: string;
};

function guardFetcher(options: { failSettingsOnce?: boolean; failTelemetry?: boolean; onTelemetry?: () => Promise<void> } = {}) {
  let quarantined = false;
  let settingsFailed = false;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/graphql")) {
      await options.onTelemetry?.();
      if (options.failTelemetry) throw new Error("telemetry unavailable");
      return analyticsResponse([{ namespaceId: "guard-state-namespace", rowsRead: 0, rowsWritten: 1_000_000 }]);
    }
    if (url.includes("/durable_objects/namespaces/")) {
      return namespaceResponse(url, { "guard-state-namespace": "guard-state-app--acme" });
    }
    if (url.endsWith("/settings")) {
      if (options.failSettingsOnce && !settingsFailed) {
        settingsFailed = true;
        return Response.json({ success: false }, { status: 503 });
      }
      return Response.json({
        success: true,
        result: {
          bindings: [{ type: "durable_object_namespace", name: "DO", class_name: "AlarmDO" }],
        },
      });
    }
    if (init?.method === "PUT") {
      quarantined = true;
      return Response.json({ success: true, result: { deployment_id: "quarantine-version" } });
    }
    return Response.json({
      success: true,
      result: { script: { version_id: quarantined ? "quarantine-version" : "eligible-version" } },
    });
  });
}

async function stateEnv(appId: string, status: "active" | "probation" | "error" = "active") {
  const db = (testEnv as unknown as { APP_DB: D1Database }).APP_DB;
  await ensureUsageGuardSchema(db);
  await db.prepare("DELETE FROM app_usage_guard_state WHERE app_id = ? OR dispatch_script_name = 'guard-state-app--acme'")
    .bind(appId)
    .run();
  await db.prepare(`
    INSERT INTO app_usage_guard_state (
      app_id, dispatch_script_name, org_id, workspace_id, script_name, status,
      eligible_script_version, eligible_at, trace_audited_at, probation_until,
      consecutive_over_limit, artifact_cache_key, quarantine_attempts, next_retry_at, updated_at
    ) VALUES (?, 'guard-state-app--acme', 'org', 'workspace', 'guard-state-app', ?,
              'eligible-version', ?, ?, ?, 0, NULL, ?, ?, ?)
  `).bind(
    appId,
    status,
    Date.now() - 2 * 24 * 60 * 60_000,
    Date.now() - 2 * 24 * 60 * 60_000,
    status === "probation" ? Date.now() + 60 * 60_000 : null,
    status === "error" ? 1 : 0,
    status === "error" ? 0 : null,
    Date.now(),
  ).run();
  const registry = new Map<string, string>([[
    "script:guard-state-app--acme",
    JSON.stringify({ org_id: "org", org_slug: "acme", is_public: true, usage_guard_status: status }),
  ]]);
  const kv = {
    get: async (key: string) => registry.get(key) ?? null,
    put: async (key: string, value: string) => { registry.set(key, value); },
  } as unknown as KVNamespace;
  return {
    env: {
      APP_DB: db,
      APP_KV: kv,
      CF_ACCOUNT_ID: "account",
      CF_API_TOKEN: "token",
      CF_DISPATCH_NAMESPACE: "namespace",
      USAGE_GUARD_MODE: "enforce",
    } satisfies GuardTestEnv,
    registry,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.sequential("usage guard state machine", () => {
  it("requires two normal strikes, quarantines without an artifact, and suspends", async () => {
    const appId = `state-two-strikes-${crypto.randomUUID()}`;
    const setup = await stateEnv(appId);
    vi.stubGlobal("fetch", guardFetcher());
    const now = Date.now();

    await runUsageGuard(setup.env, now);
    expect(await setup.env.APP_DB.prepare("SELECT status, consecutive_over_limit FROM app_usage_guard_state WHERE app_id = ?")
      .bind(appId).first()).toMatchObject({ status: "warned", consecutive_over_limit: 1 });

    await runUsageGuard(setup.env, now + 5 * 60_000);
    expect(await setup.env.APP_DB.prepare("SELECT status, quarantine_version FROM app_usage_guard_state WHERE app_id = ?")
      .bind(appId).first()).toMatchObject({ status: "suspended", quarantine_version: "quarantine-version" });
    expect(JSON.parse(setup.registry.get("script:guard-state-app--acme")!)).toMatchObject({
      usage_guard_status: "suspended",
    });
  });

  it("suspends a probation breach on the first strike", async () => {
    const appId = `state-probation-${crypto.randomUUID()}`;
    const setup = await stateEnv(appId, "probation");
    vi.stubGlobal("fetch", guardFetcher());

    await runUsageGuard(setup.env, Date.now());
    expect(await setup.env.APP_DB.prepare("SELECT status FROM app_usage_guard_state WHERE app_id = ?")
      .bind(appId).first()).toMatchObject({ status: "suspended" });
  });

  it("records a failed quarantine and retries it after backoff", async () => {
    const appId = `state-retry-${crypto.randomUUID()}`;
    const setup = await stateEnv(appId, "error");
    vi.stubGlobal("fetch", guardFetcher({ failSettingsOnce: true }));
    const now = Date.now();

    await runUsageGuard(setup.env, now);
    const failed = await setup.env.APP_DB.prepare(
      "SELECT status, quarantine_attempts, next_retry_at FROM app_usage_guard_state WHERE app_id = ?",
    ).bind(appId).first<{ status: string; quarantine_attempts: number; next_retry_at: number }>();
    expect(failed).toMatchObject({ status: "error", quarantine_attempts: 2 });
    expect(failed!.next_retry_at).toBeGreaterThan(now);

    await runUsageGuard(setup.env, failed!.next_retry_at + 1);
    expect(await setup.env.APP_DB.prepare("SELECT status FROM app_usage_guard_state WHERE app_id = ?")
      .bind(appId).first()).toMatchObject({ status: "suspended" });
  });

  it("retries a persisted quarantine before telemetry collection", async () => {
    const appId = `state-retry-no-telemetry-${crypto.randomUUID()}`;
    const setup = await stateEnv(appId, "error");
    vi.stubGlobal("fetch", guardFetcher({ failTelemetry: true }));

    await expect(runUsageGuard(setup.env, Date.now())).rejects.toThrow("telemetry unavailable");
    expect(await setup.env.APP_DB.prepare("SELECT status FROM app_usage_guard_state WHERE app_id = ?")
      .bind(appId).first()).toMatchObject({ status: "suspended" });
  });

  it("abandons a stale enforcement claim without changing the registry", async () => {
    const appId = `state-stale-claim-${crypto.randomUUID()}`;
    const setup = await stateEnv(appId);
    let changed = false;
    vi.stubGlobal("fetch", guardFetcher({
      onTelemetry: async () => {
        if (changed) return;
        changed = true;
        await setup.env.APP_DB.prepare(`
          UPDATE app_usage_guard_state
          SET eligible_script_version = 'new-user-version', status = 'probation', updated_at = ?
          WHERE app_id = ?
        `).bind(Date.now(), appId).run();
      },
    }));

    await runUsageGuard(setup.env, Date.now());
    expect(await setup.env.APP_DB.prepare("SELECT status, eligible_script_version FROM app_usage_guard_state WHERE app_id = ?")
      .bind(appId).first()).toMatchObject({ status: "probation", eligible_script_version: "new-user-version" });
    expect(JSON.parse(setup.registry.get("script:guard-state-app--acme")!)).toMatchObject({
      usage_guard_status: "active",
    });
  });
});
