import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import type { DirectWorkerMetadata, DirectWorkerModule } from "./direct-dispatch-deploy.js";
import { ProjectFilesystemClient, type WorkspaceFileStoreLike } from "./workspace-filesystem-do.js";
import type { ProjectBuildSandbox } from "./project-build-sandbox.js";

const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
const PROJECT_BUILD_ROOT = "/workspace";
const MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH = 63;

export interface ProjectBuildEnv {
  WORKSPACE_FS: DurableObjectNamespace;
  R2_BUCKET: R2Bucket;
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<ProjectBuildSandbox>;
}

export interface ProjectBuildProps {
  orgId: string;
}

export interface ProjectBuildRequest {
  projectId: string;
  timeoutMs?: number;
}

export interface ProjectDependencyRequest {
  projectId: string;
  dependency: string;
  dev?: boolean;
}

export interface ProjectBuildResult {
  success: boolean;
  projectId: string;
  workdir: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  fileCount: number;
  durationMs: number;
  lockfilePersisted: boolean;
  error?: string;
}

export interface ProjectDependencyResult {
  success: boolean;
  projectId: string;
  workdir: string;
  dependency: string;
  dev: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  fileCount: number;
  durationMs: number;
  packageJsonPersisted: boolean;
  lockfilePersisted: boolean;
  error?: string;
}

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

interface ProjectSourceFile {
  path: string;
  bytes: Uint8Array;
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

export async function runProjectBuild(input: {
  projectId: string;
  files: WorkspaceFileStoreLike;
  sandbox: ProjectBuildSandboxLike;
  timeoutMs?: number;
}): Promise<ProjectBuildResult> {
  const startedAt = Date.now();
  const projectId = normalizeProjectBuildId(input.projectId);
  const workdir = `${PROJECT_BUILD_ROOT}/${projectId}`;
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS));

  const sourceFiles = await collectProjectSourceFiles(input.files);
  const packageValidationError = validatePackageJsonBuildScript(sourceFiles);
  if (packageValidationError) {
    return {
      success: false,
      projectId,
      workdir,
      stdout: "",
      stderr: packageValidationError,
      exitCode: 1,
      fileCount: sourceFiles.length,
      durationMs: Date.now() - startedAt,
      lockfilePersisted: false,
      error: packageValidationError,
    };
  }
  await materializeProjectSourceFiles(input.sandbox, workdir, sourceFiles);

  const result = normalizeSandboxExecResult(await input.sandbox.exec("bun install && bun run build", {
    cwd: workdir,
    timeoutMs,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      CAMELAI_PROJECT_ID: projectId,
      CAMELAI_BUILD_TIMEOUT_MS: String(timeoutMs),
    },
  }));
  const lockfilePersisted = result.exitCode === 0
    ? await persistBunLockfile(input.sandbox, input.files, workdir)
    : false;

  return {
    success: result.exitCode === 0,
    projectId,
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    fileCount: sourceFiles.length,
    durationMs: Date.now() - startedAt,
    lockfilePersisted,
    ...(result.exitCode === 0 ? {} : { error: result.stderr || result.stdout || `Build failed with exit code ${result.exitCode}` }),
  };
}

export async function runProjectAddDependency(input: {
  projectId: string;
  dependency: string;
  dev?: boolean;
  files: WorkspaceFileStoreLike;
  sandbox: ProjectBuildSandboxLike;
}): Promise<ProjectDependencyResult> {
  const startedAt = Date.now();
  const projectId = normalizeProjectBuildId(input.projectId);
  const workdir = `${PROJECT_BUILD_ROOT}/${projectId}`;
  const dependency = normalizeDependencySpec(input.dependency);
  const dev = input.dev === true;

  const sourceFiles = await collectProjectSourceFiles(input.files);
  const packageValidationError = validatePackageJson(sourceFiles);
  if (packageValidationError) {
    return {
      success: false,
      projectId,
      workdir,
      dependency,
      dev,
      stdout: "",
      stderr: packageValidationError,
      exitCode: 1,
      fileCount: sourceFiles.length,
      durationMs: Date.now() - startedAt,
      packageJsonPersisted: false,
      lockfilePersisted: false,
      error: packageValidationError,
    };
  }

  await materializeProjectSourceFiles(input.sandbox, workdir, sourceFiles);
  const command = `bun add ${dev ? "-d " : ""}${shellQuote(dependency)}`;
  const result = normalizeSandboxExecResult(await input.sandbox.exec(command, {
    cwd: workdir,
    timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      CAMELAI_PROJECT_ID: projectId,
    },
  }));
  const packageJsonPersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "package.json", { required: true })
    : false;
  const lockfilePersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "bun.lock", { required: false })
    : false;

  return {
    success: result.exitCode === 0,
    projectId,
    workdir,
    dependency,
    dev,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    fileCount: sourceFiles.length,
    durationMs: Date.now() - startedAt,
    packageJsonPersisted,
    lockfilePersisted,
    ...(result.exitCode === 0 ? {} : { error: result.stderr || result.stdout || `Dependency install failed with exit code ${result.exitCode}` }),
  };
}

async function materializeProjectSourceFiles(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  sourceFiles: ProjectSourceFile[],
): Promise<void> {
  await sandbox.mkdir(workdir, { recursive: true });
  await sandbox.exec(`rm -rf ${shellQuote(workdir)}/* ${shellQuote(workdir)}/.[!.]* ${shellQuote(workdir)}/..?*`, {
    cwd: PROJECT_BUILD_ROOT,
  });

  for (const file of sourceFiles) {
    const targetPath = `${workdir}/${file.path}`;
    const parent = dirnameSandboxPath(targetPath);
    if (parent !== workdir) {
      await sandbox.mkdir(parent, { recursive: true });
    }
    await sandbox.writeFile(targetPath, bytesToBase64(file.bytes), { encoding: "base64" });
  }
}

function validatePackageJsonBuildScript(sourceFiles: ProjectSourceFile[]): string | null {
  const packageJson = sourceFiles.find((file) => file.path === "package.json");
  if (!packageJson) return "Project package.json is required for build_project";
  const parsed = parseProjectPackageJson(packageJson);
  if (typeof parsed === "string") return parsed;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  const buildScriptMessage = "Project package.json must define scripts.build. Use scaffold_project to seed a DO-backed worker or react-router scaffold, and list every CLI used by scripts.build in dependencies or devDependencies.";
  if (!scripts || typeof scripts !== "object") return buildScriptMessage;
  const build = (scripts as { build?: unknown }).build;
  return typeof build === "string" && build.trim() ? null : buildScriptMessage;
}

function validatePackageJson(sourceFiles: ProjectSourceFile[]): string | null {
  const packageJson = sourceFiles.find((file) => file.path === "package.json");
  if (!packageJson) return "Project package.json is required";
  const parsed = parseProjectPackageJson(packageJson);
  return typeof parsed === "string" ? parsed : null;
}

function parseProjectPackageJson(packageJson: ProjectSourceFile): unknown | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(packageJson.bytes));
  } catch {
    return "Project package.json is not valid JSON";
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : "Project package.json must be an object";
}

async function persistBunLockfile(
  sandbox: ProjectBuildSandboxLike,
  files: WorkspaceFileStoreLike,
  workdir: string,
): Promise<boolean> {
  return persistSandboxTextFile(sandbox, files, workdir, "bun.lock", { required: false });
}

async function persistSandboxTextFile(
  sandbox: ProjectBuildSandboxLike,
  files: WorkspaceFileStoreLike,
  workdir: string,
  path: string,
  options: { required: boolean },
): Promise<boolean> {
  if (!sandbox.readFile) {
    if (options.required) throw new Error("Sandbox does not support dependency output reads");
    return false;
  }
  let read: { content: string };
  try {
    read = await sandbox.readFile(`${workdir}/${path}`, { encoding: "base64" });
  } catch (error) {
    if (!options.required && (String(error).toLowerCase().includes("missing") || String(error).toLowerCase().includes("not found"))) return false;
    throw error;
  }
  const content = new TextDecoder().decode(base64ToBytes(read.content));
  const result = await files.writeFile(`/${path}`, content);
  if (!result.success) throw new Error(result.error || `Failed to persist ${path}`);
  return true;
}

export class ProjectBuildService extends WorkerEntrypoint<ProjectBuildEnv, ProjectBuildProps> {
  async buildProject(request: ProjectBuildRequest): Promise<ProjectBuildResult> {
    if (!this.env.PROJECT_BUILD_SANDBOX) {
      throw new Error("PROJECT_BUILD_SANDBOX container binding is not configured");
    }
    if (!this.ctx.props.orgId) {
      throw new Error("Project build service requires org scope");
    }
    const projectId = normalizeProjectBuildId(request.projectId);
    const sandbox = getSandbox(this.env.PROJECT_BUILD_SANDBOX, projectBuildSandboxKey(this.ctx.props.orgId, projectId), {
      normalizeId: true,
      transport: "rpc",
    }) as unknown as ProjectBuildSandboxLike;
    return runProjectBuild({
      projectId,
      files: new ProjectFilesystemClient(this.env as never, projectId),
      sandbox,
      timeoutMs: request.timeoutMs,
    });
  }

  async addDependency(request: ProjectDependencyRequest): Promise<ProjectDependencyResult> {
    if (!this.env.PROJECT_BUILD_SANDBOX) {
      throw new Error("PROJECT_BUILD_SANDBOX container binding is not configured");
    }
    if (!this.ctx.props.orgId) {
      throw new Error("Project build service requires org scope");
    }
    const projectId = normalizeProjectBuildId(request.projectId);
    const sandbox = getSandbox(this.env.PROJECT_BUILD_SANDBOX, projectBuildSandboxKey(this.ctx.props.orgId, projectId), {
      normalizeId: true,
      transport: "rpc",
    }) as unknown as ProjectBuildSandboxLike;
    return runProjectAddDependency({
      projectId,
      dependency: request.dependency,
      dev: request.dev,
      files: new ProjectFilesystemClient(this.env as never, projectId),
      sandbox,
    });
  }
}

function normalizeDependencySpec(value: unknown): string {
  if (typeof value !== "string") throw new Error("dependency is required");
  const spec = value.trim();
  if (!spec) throw new Error("dependency is required");
  if (spec.length > 214) throw new Error("dependency is too long");
  if (/\s|[\x00-\x1f\x7f]/.test(spec)) throw new Error("dependency must be a single npm package spec");
  if (spec.startsWith("-")) throw new Error("dependency must not be a CLI flag");
  if (/(^|@)(?:file|link|workspace|portal|git|github|http|https):/i.test(spec) || spec.includes("://")) {
    throw new Error("dependency must be an npm registry package spec");
  }
  const packageSpecPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*+=:<>{}-]+)?$/i;
  if (!packageSpecPattern.test(spec)) throw new Error("dependency must be an npm package spec");
  return spec;
}

async function collectProjectSourceFiles(files: WorkspaceFileStoreLike): Promise<ProjectSourceFile[]> {
  const listing = await files.listFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
  if (!listing.success) throw new Error(listing.error || "Failed to list project files");
  const out: ProjectSourceFile[] = [];
  for (const entry of listing.files) {
    if (entry.type !== "file") continue;
    const relativePath = normalizeRelativeBuildPath(entry.absolutePath);
    if (!relativePath || shouldIgnoreBuildSourcePath(relativePath)) continue;
    const read = await files.readFile(entry.absolutePath);
    if (!read.success || typeof read.content !== "string") {
      throw new Error(read.error || `Failed to read ${entry.absolutePath}`);
    }
    out.push({
      path: relativePath,
      bytes: read.encoding === "base64"
        ? base64ToBytes(read.content)
        : new TextEncoder().encode(read.content),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function shouldIgnoreBuildSourcePath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) =>
    part === "node_modules" ||
    part === ".git" ||
    part === ".wrangler" ||
    part === ".cache" ||
    part === "dist" ||
    part === "build"
  );
}

function normalizeRelativeBuildPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

function normalizeProjectBuildId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!normalized) throw new Error("projectId is required");
  return normalized;
}

export function projectBuildSandboxKey(orgId: string, projectId: string): string {
  const org = orgId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const project = normalizeProjectBuildId(projectId);
  if (!org) throw new Error("orgId is required");
  const readable = `${org}-${project}`;
  if (readable.length <= MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH) return readable;
  const hash = stableHexHash(`${org}:${project}`);
  const prefixLength = MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH - hash.length - 1;
  const prefix = readable.slice(0, prefixLength).replace(/-+$/g, "");
  return `${prefix}-${hash}`;
}

function stableHexHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

function normalizeSandboxExecResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): { stdout: string; stderr: string; exitCode: number } {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : result.success === false ? 1 : 0;
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export const __testing = {
  collectProjectSourceFiles,
  normalizeRelativeBuildPath,
  shouldIgnoreBuildSourcePath,
};
