import { env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backfillUserAppCostControls } from "../src/user-app-cost-controls-backfill";
import { ensureUsageGuardSchema } from "../src/usage-guard-state";

const db = (testEnv as unknown as { APP_DB: D1Database }).APP_DB;
const dispatchScriptName = "backfill-app--acme";
const appId = "org-1:backfill-app";
const artifactCacheKey = "deploy-artifacts/org-1/workspace-1/project-1/backfill-app--acme/v1.json";
const doBinding = { type: "durable_object_namespace", name: "ROOM", class_name: "Room" };

function artifactBucket() {
  const record = JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    scriptName: "backfill-app",
    dispatchScriptName,
    identity: { orgId: "org-1", orgSlug: "acme", workspaceId: "workspace-1" },
    metadata: { main_module: "index.js", bindings: [doBinding] },
    modules: [{ name: "index.js", contentType: "application/javascript+module", contentBase64: "ZXhwb3J0IGRlZmF1bHQge307" }],
    assetsRecord: null,
  });
  return {
    get: vi.fn(async (key: string) => key === artifactCacheKey ? { text: async () => record } : null),
    put: vi.fn(async () => undefined),
  };
}

function cloudflareApi(live: {
  settings: Record<string, unknown> | null;
  entrypoint?: string;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/settings")) {
      return live.settings
        ? Response.json({ success: true, result: live.settings })
        : Response.json({ success: false, result: null }, { status: 404 });
    }
    if (url.endsWith("/content")) {
      return new Response("--multipart--", { headers: { "cf-entrypoint": live.entrypoint ?? "index.js" } });
    }
    if (init?.method === "PUT") return Response.json({ success: true, result: { id: "version-2" } });
    return Response.json({ success: true, result: { id: "version-2" } });
  });
}

function backfillEnv() {
  return {
    CF_API_TOKEN: "cf-token",
    CF_ACCOUNT_ID: "account-id",
    CF_DISPATCH_NAMESPACE: "dispatch-ns",
    WORKER_BASE_URL: "https://camelai.dev",
    APP_DB: db,
    R2_BUCKET: artifactBucket() as unknown as R2Bucket,
  };
}

async function seedGuardState(status = "active", artifact: string | null = artifactCacheKey) {
  await db.prepare(`
    INSERT INTO app_usage_guard_state (
      app_id, dispatch_script_name, org_id, workspace_id, script_name, status,
      eligible_script_version, eligible_at, artifact_cache_key, updated_at
    ) VALUES (?, ?, 'org-1', 'workspace-1', 'backfill-app', ?, 'version-1', 1, ?, 1)
  `).bind(appId, dispatchScriptName, status, artifact).run();
}

describe.sequential("backfillUserAppCostControls", () => {
  beforeEach(async () => {
    await ensureUsageGuardSchema(db);
  });

  afterEach(async () => {
    await db.prepare("DELETE FROM app_usage_guard_state WHERE app_id = ?").bind(appId).run();
    await db.prepare("DELETE FROM app_usage_guard_leases WHERE name = ?").bind(`app-operation:${appId}`).run();
  });

  it("replays the latest artifact with cost controls and reports the new version", async () => {
    await seedGuardState();
    const fetcher = cloudflareApi({ settings: { bindings: [doBinding] } });
    const onDeploySideEffects = vi.fn(async () => undefined);

    const result = await backfillUserAppCostControls(backfillEnv(), dispatchScriptName, {
      fetcher: fetcher as unknown as typeof fetch,
      onDeploySideEffects,
    });

    expect(result).toEqual({ status: "applied", dispatchScriptName, artifactCacheKey, scriptVersion: "version-2" });
    const upload = fetcher.mock.calls.find((call) => call[1]?.method === "PUT")!;
    expect(String(upload[0])).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/backfill-app--acme",
    );
    const form = upload[1]!.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).toMatchObject({ main_module: "__camelai_entry.js", limits: { cpu_ms: 1000 } });
    expect(onDeploySideEffects).toHaveBeenCalledWith(expect.objectContaining({
      dispatchScriptName,
      orgId: "org-1",
      scriptVersion: "version-2",
      artifactCacheKey,
    }));
    // The operation lease is released after the upload.
    expect(await db.prepare("SELECT 1 FROM app_usage_guard_leases WHERE name = ?").bind(`app-operation:${appId}`).first()).toBeNull();
  });

  it.each([
    ["already-applied", { settings: { limits: { cpu_ms: 1000 }, bindings: [doBinding] }, entrypoint: "__camelai_entry.js" }],
    ["quarantined", { settings: { bindings: [doBinding, { type: "plain_text", name: "CAMELAI_USAGE_GUARD_QUARANTINE", text: "v1" }] } }],
    ["not-live", { settings: null }],
  ] as const)("skips %s apps without uploading", async (reason, live) => {
    await seedGuardState();
    const fetcher = cloudflareApi(live);
    const result = await backfillUserAppCostControls(backfillEnv(), dispatchScriptName, { fetcher: fetcher as unknown as typeof fetch });
    expect(result).toEqual({ status: "skipped", dispatchScriptName, reason });
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(false);
  });

  it("skips suspended apps, apps without an artifact record, and apps with a held lease", async () => {
    const fetcher = cloudflareApi({ settings: { bindings: [doBinding] } });
    const run = () => backfillUserAppCostControls(backfillEnv(), dispatchScriptName, { fetcher: fetcher as unknown as typeof fetch });

    expect(await run()).toMatchObject({ status: "skipped", reason: "no-artifact-record" });

    await seedGuardState("suspended");
    expect(await run()).toMatchObject({ status: "skipped", reason: "suspended" });

    await db.prepare("UPDATE app_usage_guard_state SET status = 'active' WHERE app_id = ?").bind(appId).run();
    await db.prepare("INSERT INTO app_usage_guard_leases (name, holder, expires_at) VALUES (?, 'deploy', ?)")
      .bind(`app-operation:${appId}`, Date.now() + 60_000).run();
    expect(await run()).toMatchObject({ status: "skipped", reason: "lease-held" });

    expect(fetcher.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(false);
  });

  it("fails loudly when the re-upload is rejected", async () => {
    await seedGuardState();
    const api = cloudflareApi({ settings: { bindings: [doBinding] } });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      init?.method === "PUT"
        ? Response.json({ success: false, errors: [{ message: "bad bundle" }] }, { status: 400 })
        : api(input, init));
    await expect(backfillUserAppCostControls(backfillEnv(), dispatchScriptName, { fetcher: fetcher as unknown as typeof fetch }))
      .rejects.toThrow(/HTTP 400.*bad bundle/);
  });
});
