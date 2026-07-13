// Synthesizes the deploy artifact for a "published notebook": a static worker
// serving the pre-built notebook renderer SPA (public/notebook-renderer/, built
// by scripts/build-notebook-renderer.mjs from sandbox/create-worker/renderer)
// plus the executed .ipynb as a static asset. No container build is involved —
// the renderer files are read through the main worker's ASSETS binding and
// repackaged, so notebook deploys go through the exact same direct-dispatch
// upload + app registration path as built react-router projects.

import type { DirectWorkerMetadata } from "./direct-dispatch-deploy.js";
import { base64ToBytes } from "./base64-codec.js";
import { contentTypeForAsset, type ProjectWorkerBundle } from "./project-worker-bundle.js";
import { normalizeWorkspacePath } from "./workspace-filesystem-do.js";

export const NOTEBOOK_RENDERER_ASSET_PREFIX = "/notebook-renderer";
export const NOTEBOOK_WORKER_MAIN_MODULE = "worker.js";
// Static asset serving only; independent of the main app's compatibility date.
export const NOTEBOOK_WORKER_COMPATIBILITY_DATE = "2025-12-01";

// Same SPA-fallback router the legacy `publish` CLI shipped: serve the asset,
// and fall back to the renderer index for any unknown path.
const NOTEBOOK_WORKER_MODULE_SOURCE = `export default {
  async fetch(request, env) {
    let response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      response = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }
    return response;
  },
};
`;

export interface NotebookRendererAssetSource {
  fetch(request: Request): Promise<Response>;
}

// The slice of ProjectFilesystemClient the notebook deploy decision needs.
export interface NotebookProjectFileStore {
  exists(path: string): Promise<{ exists: boolean; isFile?: boolean }>;
  readFile(path: string): Promise<{ success: boolean; content?: string; encoding?: "utf8" | "base64"; error?: string }>;
  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean; limit?: number },
  ): Promise<{ success: boolean; files: Array<{ name: string; type: "file" | "directory"; absolutePath: string }>; error?: string }>;
}

// Data-analysis projects have no build step, so deploy_project publishes the
// executed notebook as a static report app instead of running the container
// build. Returns the notebook path to publish, or null when the project should
// take the normal build+deploy path (package.json with a build script).
export async function resolveNotebookDeployPath(
  projectFiles: NotebookProjectFileStore,
  requestedPath: string | null,
): Promise<string | null> {
  if (await projectHasBuildScript(projectFiles)) {
    if (requestedPath) {
      throw new Error(
        "path selects the notebook for data-analysis deploys; this project has a package.json build script and deploys its built worker instead.",
      );
    }
    return null;
  }
  if (requestedPath) {
    const requested = normalizeWorkspacePath(requestedPath);
    if (!requested.toLowerCase().endsWith(".ipynb")) {
      throw new Error(`path must point to a .ipynb notebook, got: ${requestedPath}`);
    }
    const stat = await projectFiles.exists(requested);
    if (!stat.exists || stat.isFile === false) {
      throw new Error(`Notebook not found in project: ${requested}`);
    }
    return requested;
  }
  const defaultPath = "/analysis.ipynb";
  const defaultStat = await projectFiles.exists(defaultPath);
  if (defaultStat.exists && defaultStat.isFile !== false) return defaultPath;
  const listing = await projectFiles.listFiles("/", { recursive: true, includeHidden: false, limit: 10_000 });
  if (!listing.success) throw new Error(listing.error || "Failed to list project files");
  const notebooks = listing.files
    .filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".ipynb"))
    .map((entry) => entry.absolutePath);
  if (notebooks.length === 1) return notebooks[0]!;
  if (notebooks.length > 1) {
    throw new Error(
      `Project has multiple notebooks (${notebooks.join(", ")}); pass path to choose which one to publish.`,
    );
  }
  return null;
}

async function projectHasBuildScript(projectFiles: NotebookProjectFileStore): Promise<boolean> {
  const read = await projectFiles.readFile("/package.json");
  if (!read.success || typeof read.content !== "string") return false;
  try {
    const text = read.encoding === "base64" ? new TextDecoder().decode(base64ToBytes(read.content)) : read.content;
    const parsed = JSON.parse(text) as { scripts?: unknown };
    const scripts = parsed && typeof parsed === "object" ? parsed.scripts : undefined;
    const build = scripts && typeof scripts === "object" ? (scripts as { build?: unknown }).build : undefined;
    return typeof build === "string" && build.trim().length > 0;
  } catch {
    return false;
  }
}

export interface NotebookWorkerBundleOptions {
  // The main worker's ASSETS binding (or a stand-in for tests).
  rendererAssets: NotebookRendererAssetSource;
  // Notebook filename shown in the toolbar/title and served at /files/<filename>.
  filename: string;
  notebook: Uint8Array;
}

export async function buildNotebookWorkerBundle(options: NotebookWorkerBundleOptions): Promise<ProjectWorkerBundle> {
  const filename = options.filename;
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`Notebook filename must be a bare file name, got: ${filename}`);
  }

  const manifest = await readRendererManifest(options.rendererAssets);
  const assets: ProjectWorkerBundle["assets"] = [];
  // The renderer SPA + one notebook are small, so the bytes are read here and
  // held in the handle closures; the lazy-handle shape just matches what the
  // deploy path consumes (see ProjectWorkerBundle.assets).
  for (const path of manifest.files) {
    const content = await readRendererFile(options.rendererAssets, path);
    const bytes = path === "index.html"
      ? new TextEncoder().encode(injectNotebookFilename(new TextDecoder().decode(content), filename))
      : content;
    assets.push({ path, contentType: contentTypeForAsset(path), size: bytes.byteLength, read: async () => bytes });
  }
  assets.push({
    path: `files/${filename}`,
    contentType: filename.toLowerCase().endsWith(".ipynb") ? "application/x-ipynb+json" : contentTypeForAsset(filename),
    size: options.notebook.byteLength,
    read: async () => options.notebook,
  });
  assets.sort((a, b) => a.path.localeCompare(b.path));

  const metadata: DirectWorkerMetadata = {
    main_module: NOTEBOOK_WORKER_MAIN_MODULE,
    compatibility_date: NOTEBOOK_WORKER_COMPATIBILITY_DATE,
    assets: { binding: "ASSETS" },
  };
  return {
    metadata,
    modules: [
      {
        name: NOTEBOOK_WORKER_MAIN_MODULE,
        contentType: "application/javascript+module",
        content: new TextEncoder().encode(NOTEBOOK_WORKER_MODULE_SOURCE),
      },
    ],
    assets,
    manifestPath: `${NOTEBOOK_RENDERER_ASSET_PREFIX.slice(1)}/manifest.json`,
  };
}

async function readRendererManifest(source: NotebookRendererAssetSource): Promise<{ files: string[] }> {
  const bytes = await readRendererFile(source, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Notebook renderer manifest.json is not valid JSON — rebuild with `bun run build:renderer`");
  }
  const files = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string") || !files.includes("index.html")) {
    throw new Error("Notebook renderer manifest.json is invalid — rebuild with `bun run build:renderer`");
  }
  return { files: files as string[] };
}

async function readRendererFile(source: NotebookRendererAssetSource, path: string): Promise<Uint8Array> {
  const response = await source.fetch(
    new Request(`https://assets.internal${NOTEBOOK_RENDERER_ASSET_PREFIX}/${path}`),
  );
  if (!response.ok) {
    throw new Error(
      `Notebook renderer asset ${path} is unavailable (status ${response.status}). ` +
        "The app build must include public/notebook-renderer/ — run `bun run build:renderer`.",
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

// window.__FILENAME__ drives the renderer SPA: which file to fetch from
// /files/<name> and how to render it (getPreviewType). Escapes match the legacy
// publish CLI so a hostile filename can't break out of the script tag or title.
function injectNotebookFilename(html: string, filename: string): string {
  const withScript = html.replace(
    "</head>",
    `<script>window.__FILENAME__=${escapeScriptJson(filename)}</script>\n</head>`,
  );
  if (withScript === html) {
    throw new Error("Notebook renderer index.html is missing </head>; cannot inject filename");
  }
  return withScript.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtmlText(filename)}</title>`);
}

function escapeScriptJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}
