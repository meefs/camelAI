import { describe, expect, it, vi } from "vitest";

import { deployWorkerModulesDirect, rollbackWorkerDeployFromArtifactCache } from "../src/direct-dispatch-deploy";
import { selfhostAssetObjectKey, selfhostAssetsKey } from "../src/selfhost-assets-registry";

const env = {
  CF_API_TOKEN: "cf-token",
  CF_ACCOUNT_ID: "account-id",
  CF_DISPATCH_NAMESPACE: "dispatch-ns",
  CF_WORKER_NAME: "chiridion-main",
};

const identity = {
  orgId: "org-1",
  orgSlug: "acme",
  workspaceId: "workspace-1",
  userId: "user-1",
  threadId: "thread-1",
  projectId: "project-1",
};

describe("deployWorkerModulesDirect", () => {
  it("uploads a module worker bundle directly to the dispatch namespace", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    const result = await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-06-01",
        config_path: "wrangler.jsonc",
        bindings: [
          { type: "kv_namespace", name: "KV", namespace_id: "messages" },
          { type: "ai", name: "AI" },
        ],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result).toMatchObject({
      success: true,
      scriptName: "demo-app",
      dispatchScriptName: "demo-app--acme",
      sideEffects: {
        scriptName: "demo-app",
        dispatchScriptName: "demo-app--acme",
        orgId: "org-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        projectId: "project-1",
        configPath: "wrangler.jsonc",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
    expect(init).toMatchObject({ method: "PUT" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cf-token");
    const form = init?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.bindings).toEqual([
      {
        type: "service",
        name: "KV",
        service: "chiridion-main",
        entrypoint: "KVVirtualNamespace",
        props: { workspaceId: "workspace-1", appId: "demo-app--acme", namespaceId: "messages" },
      },
      {
        type: "service",
        name: "AI",
        service: "chiridion-main",
        entrypoint: "AIVirtualBinding",
        props: { orgId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
      },
      {
        type: "service",
        name: "CONNECTIONS",
        service: "chiridion-main",
        entrypoint: "ConnectionsService",
        props: { orgId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
      },
    ]);
    expect(form.get("index.js")).toBeInstanceOf(Blob);
  });

  it("stores build assets locally and virtualizes the assets binding", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    const assetEnv = {
      ...env,
      APP_KV: { put: vi.fn(async (key: string, value: string) => kv.set(key, value)) },
      R2_BUCKET: { put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })) },
    };

    const result = await deployWorkerModulesDirect(assetEnv, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        assets: { directory: "../client" },
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "index.html", content: new TextEncoder().encode("hello"), contentType: "text/html; charset=utf-8" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);
    expect(result.sideEffects.artifactCacheKey).toMatch(/^deploy-artifacts\/org-1\/workspace-1\/project-1\/demo-app--acme\/[a-f0-9]{64}\.json$/);
    const stored = kv.get(selfhostAssetsKey("demo-app--acme"));
    expect(stored).toBeTruthy();
    const record = JSON.parse(stored!);
    expect(record.manifest["index.html"]).toMatchObject({ size: 5, contentType: "text/html; charset=utf-8" });
    expect(r2.has(selfhostAssetObjectKey("demo-app--acme", record.manifest["index.html"].hash))).toBe(true);
    const cached = r2.get(result.sideEffects.artifactCacheKey!);
    expect(cached).toBeTruthy();
    expect(cached?.options).toMatchObject({
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        type: "direct-deploy-artifact-cache",
        orgId: "org-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
      },
    });
    const cachedRecord = JSON.parse(cached?.body as string);
    expect(cachedRecord).toMatchObject({
      schemaVersion: 1,
      scriptName: "demo-app",
      dispatchScriptName: "demo-app--acme",
      identity,
      assetsRecord: { appId: "demo-app--acme" },
    });
    expect(cachedRecord.modules).toEqual([{ name: "index.js", contentType: "application/javascript+module", contentBase64: "ZXhwb3J0IGRlZmF1bHQge307" }]);
    expect(cachedRecord.metadata.bindings).toContainEqual({
      type: "service",
      name: "ASSETS",
      service: "chiridion-main",
      entrypoint: "AssetsVirtualBinding",
      props: { appId: "demo-app--acme" },
    });

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.assets).toBeUndefined();
    expect(metadata.bindings).toContainEqual({
      type: "service",
      name: "ASSETS",
      service: "chiridion-main",
      entrypoint: "AssetsVirtualBinding",
      props: { appId: "demo-app--acme" },
    });
  });

  it("rolls back by replaying a cached deploy artifact", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    const rollbackEnv = {
      ...env,
      APP_KV: { put: vi.fn(async (key: string, value: string) => kv.set(key, value)) },
      R2_BUCKET: {
        put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? { text: async () => item.body as string } : null;
        }),
      },
    };
    const deploy = await deployWorkerModulesDirect(rollbackEnv, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "index.html", content: new TextEncoder().encode("hello"), contentType: "text/html; charset=utf-8" }],
    }, { fetcher: fetcher as unknown as typeof fetch });
    kv.clear();
    fetcher.mockClear();

    const rollback = await rollbackWorkerDeployFromArtifactCache(rollbackEnv, {
      artifactCacheKey: deploy.sideEffects.artifactCacheKey!,
      hostname: "camelai.dev",
      expected: { orgId: "org-1", workspaceId: "workspace-1", scriptName: "demo-app" },
      threadId: "thread-rollback",
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(rollback).toMatchObject({
      success: true,
      scriptName: "demo-app",
      dispatchScriptName: "demo-app--acme",
      sideEffects: {
        threadId: "thread-rollback",
        artifactCacheKey: deploy.sideEffects.artifactCacheKey,
      },
    });
    expect(kv.get(selfhostAssetsKey("demo-app--acme"))).toBeTruthy();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
    const form = init?.body as FormData;
    expect(JSON.parse(await (form.get("metadata") as Blob).text()).bindings).toContainEqual({
      type: "service",
      name: "ASSETS",
      service: "chiridion-main",
      entrypoint: "AssetsVirtualBinding",
      props: { appId: "demo-app--acme" },
    });
    expect(form.get("index.js")).toBeInstanceOf(Blob);
  });
});
