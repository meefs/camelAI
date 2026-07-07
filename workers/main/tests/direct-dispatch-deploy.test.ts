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

  it("attaches the tail worker as a tail consumer when TAIL_WORKER_NAME is set", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect({ ...env, TAIL_WORKER_NAME: "chiridion-user-logs-tail" }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js" },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toEqual([{ service: "chiridion-user-logs-tail" }]);
  });

  it("preserves project-declared tail consumers and dedupes the platform one", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect({ ...env, TAIL_WORKER_NAME: "chiridion-user-logs-tail" }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        tail_consumers: [
          { service: "project-own-tail" },
          { service: "chiridion-user-logs-tail" },
          { service: "chiridion-user-logs-tail", environment: "staging" },
        ],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    // The exact platform consumer is deduped; an environment-scoped consumer
    // for the same service is preserved (Wrangler treats it as distinct).
    expect(metadata.tail_consumers).toEqual([
      { service: "project-own-tail" },
      { service: "chiridion-user-logs-tail", environment: "staging" },
      { service: "chiridion-user-logs-tail" },
    ]);
  });

  it("omits tail consumers when TAIL_WORKER_NAME is not configured", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js" },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toBeUndefined();
  });

  it("normalizes wrangler durable object migrations for first deploy", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({ success: false, errors: [{ code: 10092, message: "not found" }], result: null }, { status: 404 });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        migrations: [{ tag: "v1", new_sqlite_classes: ["CounterDO"] }],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["CounterDO"] }],
    });
  });

  it("skips durable object migrations that are already applied", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({ success: true, result: { script: { migration_tag: "v2" } } });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        migrations: [
          { tag: "v1", new_sqlite_classes: ["CounterDO"] },
          { tag: "v2", new_sqlite_classes: ["SessionDO"] },
        ],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toBeUndefined();
  });

  it("uploads only pending durable object migration steps after the current tag", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({ success: true, result: { script: { migration_tag: "v1" } } });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        migrations: [
          { tag: "v1", new_sqlite_classes: ["CounterDO"] },
          { tag: "v2", new_sqlite_classes: ["SessionDO"] },
        ],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["SessionDO"] }],
    });
  });

  it("uploads build assets natively and publishes the self-host manifest after script upload succeeds", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] } });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });
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
        assets: { directory: "../client", binding: "STATIC_ASSETS" },
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "index.html", content: new TextEncoder().encode("hello"), contentType: "text/html; charset=utf-8" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);
    expect(result.sideEffects.artifactCacheKey).toMatch(/^deploy-artifacts\/org-1\/workspace-1\/project-1\/demo-app--acme\/[a-f0-9]{64}\.json$/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [sessionUrl, sessionInit] = fetcher.mock.calls[0]!;
    expect(sessionUrl).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme/assets-upload-session");
    expect(sessionInit).toMatchObject({ method: "POST" });
    const sessionBody = JSON.parse(sessionInit?.body as string);
    expect(sessionBody.manifest["/index.html"]).toMatchObject({ size: 5 });
    const assetHash = sessionBody.manifest["/index.html"].hash;
    const [, uploadInit] = fetcher.mock.calls[1]!;
    expect((uploadInit?.headers as Record<string, string>).Authorization).toBe("Bearer upload-jwt");
    const uploadForm = uploadInit?.body as FormData;
    expect(await (uploadForm.get(assetHash) as Blob).text()).toBe("aGVsbG8=");
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
      type: "assets",
      name: "STATIC_ASSETS",
    });
    expect(cachedRecord.metadata.assets).toEqual({ jwt: "assets-jwt" });

    const form = fetcher.mock.calls[2]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
    expect(metadata.bindings).toContainEqual({
      type: "assets",
      name: "STATIC_ASSETS",
    });
  });

  it("does not publish the active self-host asset manifest when script upload fails", async () => {
    const kvPut = vi.fn(async () => undefined);
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt", buckets: [] } });
      }
      return Response.json({ success: false, errors: [{ message: "script failed" }] }, { status: 500 });
    });

    const result = await deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: kvPut },
      R2_BUCKET: { put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })) },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "index.html", content: new TextEncoder().encode("hello"), contentType: "text/html; charset=utf-8" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(false);
    expect(kvPut).not.toHaveBeenCalledWith(selfhostAssetsKey("demo-app--acme"), expect.any(String));
  });

  it("continues native asset deploy when the local rollback asset cache R2 put fails", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] } });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });
    const r2Put = vi.fn(async () => {
      throw new Error("put: Unspecified error (0)");
    });

    const result = await deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: { put: r2Put },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "index.html", content: new TextEncoder().encode("hello"), contentType: "text/html; charset=utf-8" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result).toMatchObject({
      success: true,
      result: { success: true, result: { has_assets: true } },
    });
    expect(result.warnings).toEqual(["Deploy artifact cache unavailable: put: Unspecified error (0)"]);
    expect(result.sideEffects.artifactCacheKey).toBeUndefined();
    expect(r2Put).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
    const metadata = JSON.parse(await ((fetcher.mock.calls[2]![1]?.body as FormData).get("metadata") as Blob).text());
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
  });

  it("includes Cloudflare error bodies when asset upload session returns result null", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({
          success: false,
          errors: [{ code: 10001, message: "upload session denied" }],
          messages: [],
          result: null,
        }, { status: 400 });
      }
      return Response.json({ success: true });
    });

    await expect(deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: { put: vi.fn(async () => undefined) },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "index.html", content: new TextEncoder().encode("hello"), contentType: "text/html; charset=utf-8" }],
    }, { fetcher: fetcher as unknown as typeof fetch })).rejects.toThrow(/upload session denied/);
  });

  it("rolls back by replaying a cached deploy artifact", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] } });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true });
    });
    const rollbackEnv = {
      ...env,
      APP_KV: { put: vi.fn(async (key: string, value: string) => kv.set(key, value)) },
      R2_BUCKET: {
        put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? {
            text: async () => item.body as string,
            arrayBuffer: async () => item.body instanceof Uint8Array
              ? item.body.buffer.slice(item.body.byteOffset, item.body.byteOffset + item.body.byteLength)
              : new TextEncoder().encode(item.body).buffer,
          } : null;
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
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/assets-upload-session");
    expect(String(fetcher.mock.calls[1]![0])).toContain("/workers/assets/upload?base64=true");
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
    const form = init?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
    expect(metadata.bindings).toContainEqual({
      type: "assets",
      name: "ASSETS",
    });
    expect(form.get("index.js")).toBeInstanceOf(Blob);
  });

  it("re-applies the platform tail consumer when rolling back an artifact cached without one", async () => {
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    const rollbackEnv = {
      ...env,
      TAIL_WORKER_NAME: "chiridion-user-logs-tail",
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: {
        put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? { text: async () => item.body as string } : null;
        }),
      },
    };
    // Cache an artifact whose metadata predates the tail-consumer behavior.
    const artifactCacheKey = "deploy-artifacts/org-1/workspace-1/project-1/demo-app--acme/legacy.json";
    r2.set(artifactCacheKey, {
      body: JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        scriptName: "demo-app",
        dispatchScriptName: "demo-app--acme",
        identity,
        metadata: { main_module: "index.js" },
        modules: [{ name: "index.js", contentType: "application/javascript+module", contentBase64: "ZXhwb3J0IGRlZmF1bHQge307" }],
        assetsRecord: null,
      }),
    });

    await rollbackWorkerDeployFromArtifactCache(rollbackEnv, {
      artifactCacheKey,
      hostname: "camelai.dev",
      expected: { orgId: "org-1", workspaceId: "workspace-1", scriptName: "demo-app" },
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls.at(-1)![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toEqual([{ service: "chiridion-user-logs-tail" }]);
  });
});
