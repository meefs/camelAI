import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import { ProjectFilesystemClient, type WorkspaceFileStoreLike } from "./workspace-filesystem-do.js";
import type { ProjectBuildSandbox } from "./project-build-sandbox.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

export { collectWorkerBundleFromSandbox } from "./project-worker-bundle.js";
export type { ProjectBuildSandboxLike, ProjectWorkerBundle } from "./project-worker-bundle.js";

const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
const PROJECT_BUILD_ROOT = "/workspace";
const MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH = 63;
const MAX_COMMAND_OUTPUT_LOG_CHARS = 4000;

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

function commandOutputForLog(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_COMMAND_OUTPUT_LOG_CHARS) return trimmed;
  const omitted = trimmed.length - MAX_COMMAND_OUTPUT_LOG_CHARS;
  return `[truncated ${omitted} chars]\n${trimmed.slice(-MAX_COMMAND_OUTPUT_LOG_CHARS)}`;
}

function logProjectCommandFailure(
  operation: "build" | "dependency_install",
  details: {
    projectId: string;
    workdir: string;
    fileCount: number;
    durationMs: number;
    timeoutMs?: number;
    dependency?: string;
    dev?: boolean;
  },
  result: { stdout: string; stderr: string; exitCode: number },
): void {
  console.warn('[project-build] command failed', {
    operation,
    projectId: details.projectId,
    workdir: details.workdir,
    fileCount: details.fileCount,
    durationMs: details.durationMs,
    timeoutMs: details.timeoutMs,
    dependency: details.dependency,
    dev: details.dev,
    exitCode: result.exitCode,
    stdout: commandOutputForLog(result.stdout),
    stderr: commandOutputForLog(result.stderr),
  });
}

interface ProjectSourceFile {
  path: string;
  bytes: Uint8Array;
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
    console.warn('[project-build] validation failed', {
      operation: 'build',
      projectId,
      workdir,
      fileCount: sourceFiles.length,
      error: packageValidationError,
    });
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
  const commandDurationMs = Date.now() - startedAt;
  if (result.exitCode !== 0) {
    logProjectCommandFailure('build', {
      projectId,
      workdir,
      fileCount: sourceFiles.length,
      durationMs: commandDurationMs,
      timeoutMs,
    }, result);
  }
  const lockfilePersisted = result.exitCode === 0
    ? await persistBunLockfile(input.sandbox, input.files, workdir)
    : false;
  const durationMs = Date.now() - startedAt;

  return {
    success: result.exitCode === 0,
    projectId,
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    fileCount: sourceFiles.length,
    durationMs,
    lockfilePersisted,
    ...(result.exitCode === 0
      ? {}
      : {
        // Combine both streams: bun echoes the failing command to stderr while the
        // actual compiler/bundler diagnostics often land in stdout, so either one
        // alone can be all noise. stdout first, stderr last: concatenation loses
        // temporal interleaving and consumers keep a TAIL of this text, so the
        // stream where compilers put errors (stderr, typically short) must sit at
        // the end where noisy stdout can never truncate it away.
        error: [result.stdout, result.stderr].filter(Boolean).join("\n") ||
          `Build failed with exit code ${result.exitCode}`,
      }),
  };
}

// ---------------------------------------------------------------------------
// Build log tail
//
// Raw build output opens with bun's command echo ("$ react-router build && ...")
// and tool banners, but build tools print the actual diagnostic at the END of
// their output — so instead of pattern-matching error formats (a taxonomy that
// drifts with every toolchain release), return an ANSI-stripped tail of the
// combined output. The consuming agent reads the excerpt directly.
// ---------------------------------------------------------------------------

const BUILD_LOG_TAIL_MAX_CHARS = 2400;

export function buildLogTail(raw: string): string | null {
  const cleaned = raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= BUILD_LOG_TAIL_MAX_CHARS) return cleaned;
  return `[truncated ${cleaned.length - BUILD_LOG_TAIL_MAX_CHARS} chars]\n${cleaned.slice(-BUILD_LOG_TAIL_MAX_CHARS)}`;
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
    console.warn('[project-build] validation failed', {
      operation: 'dependency_install',
      projectId,
      workdir,
      dependency,
      dev,
      fileCount: sourceFiles.length,
      error: packageValidationError,
    });
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
  const commandDurationMs = Date.now() - startedAt;
  if (result.exitCode !== 0) {
    logProjectCommandFailure('dependency_install', {
      projectId,
      workdir,
      dependency,
      dev,
      fileCount: sourceFiles.length,
      durationMs: commandDurationMs,
      timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    }, result);
  }
  const packageJsonPersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "package.json", { required: true })
    : false;
  const lockfilePersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "bun.lock", { required: false })
    : false;
  const durationMs = Date.now() - startedAt;

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
    durationMs,
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

function dirnameSandboxPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
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
