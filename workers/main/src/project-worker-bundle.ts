import type { DirectWorkerMetadata, DirectWorkerModule } from "./direct-dispatch-deploy.js";

export interface ProjectBuildSandboxLike {
  exec(command: string, options?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<{
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
  };
  if (!manifest.main_module || typeof manifest.main_module !== "string") {
    throw new Error(`Build manifest ${manifestPath} is missing main_module`);
  }
  const metadata = normalizeWorkerBundleMetadata(manifest);
  const serverRoot = dirnameSandboxPath(absoluteManifestPath);
  const listed = await sandbox.listFiles(serverRoot, { recursive: true, includeHidden: true });
  const modules: DirectWorkerModule[] = [];
  for (const file of listed.files) {
    if (file.type !== "file") continue;
    const absolutePath = file.absolutePath || joinSandboxPath(serverRoot, file.relativePath || file.name);
    const relativePath = relativeSandboxPath(serverRoot, absolutePath);
    if (!relativePath || relativePath === basenameSandboxPath(absoluteManifestPath)) continue;
    if (shouldIgnoreBuildOutputModule(relativePath)) continue;
    modules.push({
      name: relativePath,
      contentType: contentTypeForModule(relativePath),
      content: await readSandboxFileBytes(sandbox, absolutePath),
    });
  }
  modules.sort((a, b) => a.name.localeCompare(b.name));
  return {
    metadata,
    modules,
    assets: await collectAssetsFromManifest(sandbox, serverRoot, metadata),
    manifestPath,
  };
}

function normalizeWorkerBundleMetadata(
  manifest: DirectWorkerMetadata & {
    durable_objects?: { bindings?: unknown };
  },
): DirectWorkerMetadata {
  const bindings = [...(manifest.bindings ?? [])];
  const durableObjectBindings = manifest.durable_objects?.bindings;
  if (Array.isArray(durableObjectBindings)) {
    for (const binding of durableObjectBindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      const record = binding as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.class_name !== "string") continue;
      if (bindings.some((candidate) => candidate.name === record.name)) continue;
      bindings.push({
        ...record,
        type: "durable_object_namespace",
        name: record.name,
        class_name: record.class_name,
      });
    }
  }

  const { durable_objects: _durableObjects, ...metadata } = manifest;
  return {
    ...metadata,
    ...(bindings.length > 0 ? { bindings } : {}),
  };
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
  const assets = [];
  for (const file of listed.files) {
    if (file.type !== "file") continue;
    const absolutePath = file.absolutePath || joinSandboxPath(assetsRoot, file.relativePath || file.name);
    const relativePath = relativeSandboxPath(assetsRoot, absolutePath);
    if (!relativePath) continue;
    assets.push({
      path: relativePath,
      content: await readSandboxFileBytes(sandbox, absolutePath),
      contentType: contentTypeForAsset(relativePath),
    });
  }
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

function contentTypeForAsset(path: string): string | undefined {
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
