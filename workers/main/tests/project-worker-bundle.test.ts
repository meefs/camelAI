import { describe, expect, it, vi } from "vitest";

import { collectWorkerBundleFromSandbox, type ProjectBuildSandboxLike } from "../src/project-worker-bundle";

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
});
