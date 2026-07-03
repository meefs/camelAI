import { describe, expect, it, vi } from "vitest";

import { collectWorkerBundleFromSandbox, findUnexportedDurableObjectClasses, type ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import type { ProjectWorkerBundle } from "../src/project-worker-bundle";

function fakeBundleSandbox(files: Map<string, string>): ProjectBuildSandboxLike {
  return {
    exec: vi.fn(async () => ({ success: true, exitCode: 0 })),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content == null) throw new Error(`missing ${path}`);
      return { content: Buffer.from(content).toString("base64") };
    }),
    listFiles: vi.fn(async (root: string) => ({
      files: Array.from(files.keys()).filter((absolutePath) => absolutePath.startsWith(`${root}/`)).map((absolutePath) => ({
        name: absolutePath.split("/").pop() || "",
        type: "file" as const,
        absolutePath,
        relativePath: absolutePath.slice(root.length + 1),
      })),
    })),
  };
}

describe("collectWorkerBundleFromSandbox", () => {
  it("reads the build manifest and module files from build/server", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main_module: "index.js",
        compatibility_date: "2026-06-01",
        bindings: [{ type: "plain_text", name: "GREETING", text: "hi" }],
        assets: { directory: "../client" },
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ["/workspace/demo/build/server/chunk.js", "export const chunk = 1;"],
      ["/workspace/demo/build/server/index.js.map", "ignored"],
      ["/workspace/demo/build/client/index.html", "<html></html>"],
      ["/workspace/demo/build/client/assets/app.css", "body{}"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata).toMatchObject({ main_module: "index.js" });
    expect(bundle.modules.map((module) => module.name)).toEqual(["chunk.js", "index.js"]);
    expect(bundle.modules.map((module) => module.contentType)).toEqual([
      "application/javascript+module",
      "application/javascript+module",
    ]);
    expect(bundle.assets.map((asset) => ({ path: asset.path, contentType: asset.contentType }))).toEqual([
      { path: "assets/app.css", contentType: "text/css; charset=utf-8" },
      { path: "index.html", contentType: "text/html; charset=utf-8" },
    ]);
  });

  it("converts wrangler durable object config into upload bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main_module: "index.js",
        durable_objects: {
          bindings: [{ name: "TASK_STORE", class_name: "TaskStore" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TaskStore"] }],
      })],
      ["/workspace/demo/build/server/index.js", "export class TaskStore {}; export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata).toMatchObject({
      main_module: "index.js",
      migrations: [{ tag: "v1", new_sqlite_classes: ["TaskStore"] }],
      bindings: [{ type: "durable_object_namespace", name: "TASK_STORE", class_name: "TaskStore" }],
    });
    expect(bundle.metadata.durable_objects).toBeUndefined();
  });

  it("lifts wrangler kv_namespaces and r2_buckets into upload bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main_module: "index.js",
        kv_namespaces: [
          { binding: "SESSIONS", id: "kv-abc123" },
          { binding: "CACHE" },
        ],
        r2_buckets: [{ binding: "UPLOADS", bucket_name: "my-uploads" }],
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "kv-abc123" },
      { type: "kv_namespace", name: "CACHE" },
      { type: "r2_bucket", name: "UPLOADS", bucket_name: "my-uploads" },
    ]);
    // The idiomatic top-level arrays are consumed, not passed through raw
    // (the deploy metadata only reads `bindings`).
    expect(bundle.metadata.kv_namespaces).toBeUndefined();
    expect(bundle.metadata.r2_buckets).toBeUndefined();
  });

  it("does not duplicate a binding already present in manifest.bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main_module: "index.js",
        bindings: [{ type: "kv_namespace", name: "SESSIONS", namespace_id: "explicit" }],
        kv_namespaces: [{ binding: "SESSIONS", id: "duplicate" }],
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "explicit" },
    ]);
  });
});

describe("findUnexportedDurableObjectClasses", () => {
  const bundleWith = (mainSource: string, classNames: string[]): ProjectWorkerBundle => ({
    metadata: {
      main_module: "worker.js",
      bindings: classNames.map((class_name) => ({
        type: "durable_object_namespace",
        name: class_name.toUpperCase(),
        class_name,
      })),
    },
    modules: [{ name: "worker.js", contentType: "application/javascript+module", content: mainSource }],
    assets: [],
    manifestPath: "build/server/wrangler.json",
  });

  it("returns nothing when there are no DO bindings", () => {
    expect(findUnexportedDurableObjectClasses(bundleWith("export default {};", []))).toEqual([]);
  });

  it("accepts a directly-exported class", () => {
    const src = "export class LeaderboardDO { fetch() {} }\nexport default {};";
    expect(findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"]))).toEqual([]);
  });

  it("accepts an aliased re-export in a consolidated export clause (esbuild shape)", () => {
    const src = [
      "class LeaderboardDO2 { fetch() {} }",
      "var worker_default = { fetch() {} };",
      "export {",
      "  LeaderboardDO2 as LeaderboardDO,",
      "  worker_default as default",
      "};",
    ].join("\n");
    expect(findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"]))).toEqual([]);
  });

  it("flags a declared class that is never exported", () => {
    const src = "class LeaderboardDO {}\nexport default {};";
    expect(findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"]))).toEqual(["LeaderboardDO"]);
  });

  it("flags a misspelled/missing class among several", () => {
    const src = "export class ScoreDO {}\nexport { X as ChatDO };\nexport default {};";
    expect(
      findUnexportedDurableObjectClasses(bundleWith(src, ["ScoreDO", "ChatDO", "PresenceDO"])),
    ).toEqual(["PresenceDO"]);
  });

  it("does not block when the entry module is absent", () => {
    const bundle = bundleWith("", ["LeaderboardDO"]);
    bundle.modules = [];
    expect(findUnexportedDurableObjectClasses(bundle)).toEqual([]);
  });

  it("skips the check when the entry has a star re-export it can't resolve", () => {
    expect(
      findUnexportedDurableObjectClasses(bundleWith('export * from "./do.js";\nexport default {};', ["LeaderboardDO"])),
    ).toEqual([]);
    expect(
      findUnexportedDurableObjectClasses(bundleWith('export * as ns from "./do.js";\nexport default {};', ["LeaderboardDO"])),
    ).toEqual([]);
  });
});
