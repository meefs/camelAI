import { describe, expect, it } from "vitest";

import {
  buildNotebookWorkerBundle,
  resolveNotebookDeployPath,
  NOTEBOOK_WORKER_MAIN_MODULE,
  type NotebookProjectFileStore,
  type NotebookRendererAssetSource,
} from "../src/notebook-worker-bundle";

const RENDERER_INDEX_HTML = "<html><head><title>renderer</title></head><body></body></html>";

function fakeRendererAssets(files: Record<string, string> | null = null): NotebookRendererAssetSource {
  const defaults: Record<string, string> = {
    "manifest.json": JSON.stringify({ files: ["assets/app-abc123.js", "assets/app-abc123.css", "index.html"] }),
    "index.html": RENDERER_INDEX_HTML,
    "assets/app-abc123.js": "console.log('renderer');",
    "assets/app-abc123.css": "body{}",
  };
  const contents = files ?? defaults;
  return {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace(/^\/notebook-renderer\//, "");
      const content = contents[path];
      if (content == null) return new Response("not found", { status: 404 });
      return new Response(content, { status: 200 });
    },
  };
}

function decode(content: string | Uint8Array | ArrayBuffer): string {
  if (typeof content === "string") return content;
  return new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
}

describe("buildNotebookWorkerBundle", () => {
  const notebook = new TextEncoder().encode(JSON.stringify({ cells: [] }));

  it("packages the renderer, injected index.html, and the notebook as a static worker", async () => {
    const bundle = await buildNotebookWorkerBundle({
      rendererAssets: fakeRendererAssets(),
      filename: "analysis.ipynb",
      notebook,
    });

    expect(bundle.metadata.main_module).toBe(NOTEBOOK_WORKER_MAIN_MODULE);
    expect(bundle.metadata.assets).toEqual({ binding: "ASSETS" });
    expect(bundle.modules).toHaveLength(1);
    expect(bundle.modules[0]!.name).toBe(NOTEBOOK_WORKER_MAIN_MODULE);
    expect(decode(bundle.modules[0]!.content)).toContain("env.ASSETS.fetch");

    expect(bundle.assets.map((asset) => asset.path)).toEqual([
      "assets/app-abc123.css",
      "assets/app-abc123.js",
      "files/analysis.ipynb",
      "index.html",
    ]);

    const indexHtml = decode(bundle.assets.find((asset) => asset.path === "index.html")!.content);
    expect(indexHtml).toContain('window.__FILENAME__="analysis.ipynb"');
    expect(indexHtml).toContain("<title>analysis.ipynb</title>");

    const notebookAsset = bundle.assets.find((asset) => asset.path === "files/analysis.ipynb")!;
    expect(decode(notebookAsset.content)).toBe(JSON.stringify({ cells: [] }));
    expect(notebookAsset.contentType).toBe("application/x-ipynb+json");
  });

  it("escapes hostile filenames in the injected script and title", async () => {
    const filename = "x<script>alert(1)&.ipynb";
    const bundle = await buildNotebookWorkerBundle({
      rendererAssets: fakeRendererAssets(),
      filename,
      notebook,
    });
    const indexHtml = decode(bundle.assets.find((asset) => asset.path === "index.html")!.content);
    expect(indexHtml).not.toContain("<script>alert(1)");
    expect(indexHtml).toContain("\\u003cscript\\u003ealert(1)\\u0026");
    expect(indexHtml).toContain("<title>x&lt;script&gt;alert(1)&amp;.ipynb</title>");
  });

  it("rejects filenames containing path separators", async () => {
    await expect(
      buildNotebookWorkerBundle({ rendererAssets: fakeRendererAssets(), filename: "a/b.ipynb", notebook }),
    ).rejects.toThrow(/bare file name/);
  });

  it("fails with a rebuild hint when the renderer manifest is missing", async () => {
    await expect(
      buildNotebookWorkerBundle({ rendererAssets: fakeRendererAssets({}), filename: "analysis.ipynb", notebook }),
    ).rejects.toThrow(/build:renderer/);
  });

  it("fails when the manifest does not list index.html", async () => {
    const rendererAssets = fakeRendererAssets({
      "manifest.json": JSON.stringify({ files: ["assets/app.js"] }),
      "assets/app.js": "",
    });
    await expect(
      buildNotebookWorkerBundle({ rendererAssets, filename: "analysis.ipynb", notebook }),
    ).rejects.toThrow(/manifest\.json is invalid/);
  });
});

function fakeProjectStore(options: {
  files: Record<string, string>;
}): NotebookProjectFileStore {
  const paths = Object.keys(options.files);
  return {
    exists: async (path) => ({ exists: paths.includes(path), isFile: paths.includes(path) }),
    readFile: async (path) => {
      const content = options.files[path];
      if (content == null) return { success: false, error: "File not found" };
      return { success: true, content, encoding: "utf8" as const };
    },
    listFiles: async () => ({
      success: true,
      files: paths.map((absolutePath) => ({
        name: absolutePath.split("/").pop() || "",
        type: "file" as const,
        absolutePath,
      })),
    }),
  };
}

describe("resolveNotebookDeployPath", () => {
  const notebookJson = JSON.stringify({ cells: [] });

  it("returns null for projects with a package.json build script", async () => {
    const store = fakeProjectStore({
      files: {
        "/package.json": JSON.stringify({ scripts: { build: "react-router build" } }),
        "/analysis.ipynb": notebookJson,
      },
    });
    expect(await resolveNotebookDeployPath(store, null)).toBeNull();
  });

  it("rejects an explicit notebook path when the project has a build script", async () => {
    const store = fakeProjectStore({
      files: {
        "/package.json": JSON.stringify({ scripts: { build: "react-router build" } }),
        "/analysis.ipynb": notebookJson,
      },
    });
    await expect(resolveNotebookDeployPath(store, "analysis.ipynb")).rejects.toThrow(/build script/);
  });

  it("defaults to /analysis.ipynb for notebook projects", async () => {
    const store = fakeProjectStore({
      files: { "/analysis.ipynb": notebookJson, "/README.md": "readme" },
    });
    expect(await resolveNotebookDeployPath(store, null)).toBe("/analysis.ipynb");
  });

  it("uses the single notebook when analysis.ipynb is absent", async () => {
    const store = fakeProjectStore({
      files: { "/reports/q3.ipynb": notebookJson, "/README.md": "readme" },
    });
    expect(await resolveNotebookDeployPath(store, null)).toBe("/reports/q3.ipynb");
  });

  it("requires path when multiple notebooks exist and none is analysis.ipynb", async () => {
    const store = fakeProjectStore({
      files: { "/a.ipynb": notebookJson, "/b.ipynb": notebookJson },
    });
    await expect(resolveNotebookDeployPath(store, null)).rejects.toThrow(/multiple notebooks/);
  });

  it("honors an explicit notebook path", async () => {
    const store = fakeProjectStore({
      files: { "/a.ipynb": notebookJson, "/b.ipynb": notebookJson },
    });
    expect(await resolveNotebookDeployPath(store, "b.ipynb")).toBe("/b.ipynb");
  });

  it("rejects an explicit path that is not a notebook or does not exist", async () => {
    const store = fakeProjectStore({ files: { "/a.ipynb": notebookJson, "/data.csv": "x" } });
    await expect(resolveNotebookDeployPath(store, "data.csv")).rejects.toThrow(/\.ipynb/);
    await expect(resolveNotebookDeployPath(store, "missing.ipynb")).rejects.toThrow(/not found/i);
  });

  it("returns null when the project has neither a build script nor notebooks", async () => {
    const store = fakeProjectStore({ files: { "/README.md": "readme" } });
    expect(await resolveNotebookDeployPath(store, null)).toBeNull();
  });

  it("treats an unparseable package.json as having no build script", async () => {
    const store = fakeProjectStore({
      files: { "/package.json": "not json", "/analysis.ipynb": notebookJson },
    });
    expect(await resolveNotebookDeployPath(store, null)).toBe("/analysis.ipynb");
  });
});
