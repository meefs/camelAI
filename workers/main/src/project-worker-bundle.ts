import type { DirectWorkerMetadata, DirectWorkerModule } from "./direct-dispatch-deploy.js";
import type { WorkerBinding } from "./cf-api-proxy.js";

const BUNDLE_READ_CONCURRENCY = 16;

export interface ProjectBuildSandboxLike {
  // Matches @cloudflare/sandbox ExecOptions: the execution bound is `timeout`
  // (ms). Do not add a `timeoutMs` alias — the SDK silently ignores it.
  exec(command: string, options?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number }): Promise<{
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string, options?: { encoding?: "base64" | "utf8" }): Promise<unknown>;
  readFile?(path: string, options?: { encoding?: "base64" | "utf8" }): Promise<{ content: string }>;
  listFiles?(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<{ files: Array<{
    name: string;
    type: "file" | "directory";
    relativePath?: string;
    absolutePath?: string;
  }> }>;
}

export interface ProjectWorkerBundle {
  metadata: DirectWorkerMetadata;
  modules: DirectWorkerModule[];
  assets: Array<{ path: string; content: Uint8Array; contentType?: string }>;
  manifestPath: string;
}

export async function collectWorkerBundleFromSandbox(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  manifestPath = "build/server/wrangler.json",
): Promise<ProjectWorkerBundle> {
  if (!sandbox.readFile || !sandbox.listFiles) {
    throw new Error("Sandbox does not support build output reads");
  }
  const absoluteManifestPath = joinSandboxPath(workdir, manifestPath);
  const manifestBytes = await readSandboxFileBytes(sandbox, absoluteManifestPath);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as DirectWorkerMetadata & {
    assets?: { directory?: string } | string;
    durable_objects?: { bindings?: unknown };
    kv_namespaces?: unknown;
    r2_buckets?: unknown;
    main?: unknown;
    no_bundle?: unknown;
    rules?: unknown;
  };
  // Two manifest producers exist: the camelAI scaffold hand-writes
  // `main_module`, while @cloudflare/vite-plugin's generateBundle emits the
  // wrangler-native `main` (entry chunk relative to build/server). Accept both.
  const mainModule =
    typeof manifest.main_module === "string" && manifest.main_module
      ? manifest.main_module
      : typeof manifest.main === "string" && manifest.main
        ? manifest.main
        : null;
  if (!mainModule) {
    throw new Error(`Build manifest ${manifestPath} is missing main_module`);
  }
  manifest.main_module = mainModule;
  const metadata = normalizeWorkerBundleMetadata(manifest);
  const serverRoot = dirnameSandboxPath(absoluteManifestPath);
  const listed = await sandbox.listFiles(serverRoot, { recursive: true, includeHidden: true });
  const moduleFiles = listed.files.filter((file) => file.type === "file").map((file) => {
    const absolutePath = file.absolutePath || joinSandboxPath(serverRoot, file.relativePath || file.name);
    const relativePath = relativeSandboxPath(serverRoot, absolutePath);
    return { absolutePath, relativePath };
  }).filter(({ relativePath }) =>
    Boolean(relativePath) &&
    relativePath !== basenameSandboxPath(absoluteManifestPath) &&
    !shouldIgnoreBuildOutputModule(relativePath)
  );
  const modules = await mapWithConcurrency(moduleFiles, BUNDLE_READ_CONCURRENCY, async ({ absolutePath, relativePath }) => ({
      name: relativePath,
      contentType: contentTypeForModule(relativePath),
      content: await readSandboxFileBytes(sandbox, absolutePath),
    }));
  modules.sort((a, b) => a.name.localeCompare(b.name));
  return {
    metadata,
    modules,
    assets: await collectAssetsFromManifest(sandbox, serverRoot, metadata),
    manifestPath,
  };
}

// A Durable Object namespace binding names a `class_name` that Cloudflare
// requires the worker's entry module to export by that exact name; a migration
// that creates the class needs it too. When the class isn't exported (e.g. the
// agent added the binding to wrangler.jsonc but forgot `export class Foo`, or
// misspelled it), CF rejects the upload with an opaque migration error. Catch it
// pre-upload against the bundled entry module and name the offending class.
//
// Export names are a stable module contract — esbuild preserves them verbatim
// (that's how CF resolves the binding), so scanning the bundled `main_module`
// for its exported names is reliable and can't false-positive on a genuinely
// exported class. Returns the declared class names that are NOT exported.
export function findUnexportedDurableObjectClasses(bundle: ProjectWorkerBundle): string[] {
  const declaredClasses = new Set<string>();
  for (const binding of bundle.metadata.bindings ?? []) {
    if (binding.type === "durable_object_namespace" && typeof binding.class_name === "string") {
      declaredClasses.add(binding.class_name);
    }
  }
  if (declaredClasses.size === 0) return [];

  const entryName = bundle.metadata.main_module;
  const entry = bundle.modules.find((module) => module.name === entryName);
  // No entry module to inspect — don't block; the deploy path surfaces its own
  // error rather than us guessing.
  if (!entry) return [];

  const entryText = decodeModuleText(entry.content);
  // A star re-export (`export * from "./do.js"`) surfaces another module's named
  // exports that we can't resolve statically. Rather than risk a false positive
  // that blocks a valid deploy, skip the preflight entirely when one is present —
  // the guard is best-effort convenience; a missed check just falls through to
  // the normal deploy path.
  if (/\bexport\s+\*/.test(entryText)) return [];

  const exported = extractEsmExportNames(entryText);
  return [...declaredClasses].filter((className) => !exported.has(className));
}

function decodeModuleText(content: string | Uint8Array | ArrayBuffer): string {
  if (typeof content === "string") return content;
  return new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
}

// The set of names an ESM module exports, covering the forms esbuild emits:
// `export class/function/const/let/var NAME`, `export default`, and consolidated
// `export { local as PUBLIC, bare }` clauses (the PUBLIC alias is the export name).
function extractEsmExportNames(source: string): Set<string> {
  const names = new Set<string>();

  const declRe = /\bexport\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (let match = declRe.exec(source); match; match = declRe.exec(source)) {
    names.add(match[1]!);
  }
  if (/\bexport\s+default\b/.test(source)) names.add("default");

  const clauseRe = /\bexport\s*\{([^}]*)\}/g;
  for (let match = clauseRe.exec(source); match; match = clauseRe.exec(source)) {
    for (const rawEntry of match[1]!.split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      // `local as PUBLIC` exports PUBLIC; a bare `name` exports `name`.
      const asMatch = entry.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      names.add(asMatch ? asMatch[1]! : entry);
    }
  }
  return names;
}

function normalizeWorkerBundleMetadata(
  manifest: DirectWorkerMetadata & {
    durable_objects?: { bindings?: unknown };
    kv_namespaces?: unknown;
    r2_buckets?: unknown;
    main?: unknown;
    no_bundle?: unknown;
    rules?: unknown;
  },
): DirectWorkerMetadata {
  const bindings = [...(manifest.bindings ?? [])];
  const addBinding = (binding: WorkerBinding) => {
    if (bindings.some((candidate) => candidate.name === binding.name)) return;
    bindings.push(binding);
  };

  const durableObjectBindings = manifest.durable_objects?.bindings;
  if (Array.isArray(durableObjectBindings)) {
    for (const binding of durableObjectBindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      const record = binding as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.class_name !== "string") continue;
      addBinding({
        ...record,
        type: "durable_object_namespace",
        name: record.name,
        class_name: record.class_name,
      });
    }
  }

  // Wrangler's idiomatic top-level `kv_namespaces` / `r2_buckets` arrays are
  // otherwise dropped by the deploy metadata (which only reads `bindings`), so a
  // KV/R2 binding declared the normal way silently never reaches the worker and
  // env.<NAME> is undefined at runtime. Lift them into typed bindings the same
  // way durable_objects are; mapVirtualizedBindings then virtualizes them.
  // Wrangler uses `binding` for the env var name (vs `name` for DOs).
  for (const entry of asBindingArray(manifest.kv_namespaces)) {
    const name = typeof entry.binding === "string" ? entry.binding : undefined;
    if (!name) continue;
    addBinding({
      type: "kv_namespace",
      name,
      ...(typeof entry.id === "string" ? { namespace_id: entry.id } : {}),
    });
  }
  for (const entry of asBindingArray(manifest.r2_buckets)) {
    const name = typeof entry.binding === "string" ? entry.binding : undefined;
    if (!name) continue;
    addBinding({
      type: "r2_bucket",
      name,
      ...(typeof entry.bucket_name === "string" ? { bucket_name: entry.bucket_name } : {}),
    });
  }

  const {
    durable_objects: _durableObjects,
    kv_namespaces: _kvNamespaces,
    r2_buckets: _r2Buckets,
    // Build-tool-only keys from the vite-plugin manifest; they must not leak
    // into the Cloudflare script-upload metadata.
    main: _main,
    no_bundle: _noBundle,
    rules: _rules,
    ...metadata
  } = manifest;
  return {
    ...metadata,
    ...(bindings.length > 0 ? { bindings } : {}),
  };
}

function asBindingArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

async function collectAssetsFromManifest(
  sandbox: ProjectBuildSandboxLike,
  serverRoot: string,
  manifest: DirectWorkerMetadata & { assets?: { directory?: string } | string },
): Promise<Array<{ path: string; content: Uint8Array; contentType?: string }>> {
  const rawDirectory = typeof manifest.assets === "string"
    ? manifest.assets
    : typeof manifest.assets?.directory === "string"
      ? manifest.assets.directory
      : "";
  if (!rawDirectory) return [];
  if (!sandbox.readFile || !sandbox.listFiles) throw new Error("Sandbox does not support asset output reads");
  const assetsRoot = joinSandboxPath(serverRoot, rawDirectory);
  const listed = await sandbox.listFiles(assetsRoot, { recursive: true, includeHidden: true });
  const assetFiles = listed.files.filter((file) => file.type === "file").map((file) => {
    const absolutePath = file.absolutePath || joinSandboxPath(assetsRoot, file.relativePath || file.name);
    const relativePath = relativeSandboxPath(assetsRoot, absolutePath);
    return { absolutePath, relativePath };
  }).filter(({ relativePath }) => Boolean(relativePath));
  const assets = await mapWithConcurrency(assetFiles, BUNDLE_READ_CONCURRENCY, async ({ absolutePath, relativePath }) => ({
      path: relativePath,
      content: await readSandboxFileBytes(sandbox, absolutePath),
      contentType: contentTypeForAsset(relativePath),
    }));
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

async function readSandboxFileBytes(sandbox: ProjectBuildSandboxLike, path: string): Promise<Uint8Array> {
  if (!sandbox.readFile) throw new Error("Sandbox does not support file reads");
  const read = await sandbox.readFile(path, { encoding: "base64" });
  return base64ToBytes(read.content);
}

function shouldIgnoreBuildOutputModule(path: string): boolean {
  return path.endsWith(".map") || path === "wrangler.json" || path === "wrangler.jsonc";
}

function contentTypeForModule(path: string): string {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  return "application/javascript+module";
}

export function contentTypeForAsset(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return undefined;
}

function joinSandboxPath(root: string, child: string): string {
  const cleanRoot = root.replace(/\/+$/g, "") || "/";
  const cleanChild = child.replace(/^\/+/, "");
  const joined = cleanRoot === "/" ? `/${cleanChild}` : `${cleanRoot}/${cleanChild}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirnameSandboxPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function basenameSandboxPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

function relativeSandboxPath(root: string, path: string): string {
  const cleanRoot = root.replace(/\/+$/g, "") || "/";
  const cleanPath = path.replace(/\\/g, "/");
  if (cleanRoot === "/") return cleanPath.replace(/^\/+/, "");
  if (cleanPath === cleanRoot) return "";
  return cleanPath.startsWith(`${cleanRoot}/`) ? cleanPath.slice(cleanRoot.length + 1) : cleanPath.replace(/^\/+/, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}
