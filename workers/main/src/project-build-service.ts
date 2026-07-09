import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import {
  ProjectFilesystemClient,
  type WorkspaceFileStoreLike,
} from "./workspace-filesystem-do.js";
import type { ProjectBuildSandbox } from "./project-build-sandbox.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

export { collectWorkerBundleFromSandbox } from "./project-worker-bundle.js";
export type { ProjectBuildSandboxLike, ProjectWorkerBundle } from "./project-worker-bundle.js";

const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
const DEFAULT_PREWARM_TIMEOUT_MS = 25_000;
const PROJECT_BUILD_ROOT = "/workspace";
const MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH = 63;
const MAX_COMMAND_OUTPUT_LOG_CHARS = 4000;
const PROJECT_TEMP_DIR = "/.camelai/tmp";
const PROJECT_BUILD_LOG_PATH = `${PROJECT_TEMP_DIR}/build.log`;
const SOURCE_READ_CONCURRENCY = 16;

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
  sourceBytes: number;
  durationMs: number;
  timings: ProjectBuildTimings;
  lockfilePersisted: boolean;
  buildLogPath?: string;
  buildLogPersisted?: boolean;
  buildLogBytes?: number;
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
  sourceBytes: number;
  durationMs: number;
  timings: ProjectBuildTimings;
  packageJsonPersisted: boolean;
  lockfilePersisted: boolean;
  error?: string;
}

export interface ProjectBuildTimings {
  collectSourceMs: number;
  sourceListMs: number;
  sourceReadMs: number;
  sourceHashMs: number;
  materializeMs: number;
  previousManifestReadMs: number;
  archiveCreateMs: number;
  archiveWriteMs: number;
  materializeExecMs: number;
  commandMs: number;
  persistMs: number;
  totalMs: number;
}

interface ProjectSourceCollection {
  files: ProjectSourceFile[];
  timings: Pick<ProjectBuildTimings, "collectSourceMs" | "sourceListMs" | "sourceReadMs" | "sourceHashMs">;
  totalBytes: number;
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
  sha256: string;
}

interface SourceManifest {
  schemaVersion: 1;
  files: Array<{ path: string; size: number; sha256: string }>;
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

  const sourceCollection = await collectProjectSourceFiles(input.files);
  const sourceFiles = sourceCollection.files;
  const packageValidationError = validatePackageJsonBuildScript(sourceFiles)
    ?? validateDoSqliteApiUsage(sourceFiles);
  if (packageValidationError) {
    const durationMs = Date.now() - startedAt;
    const buildLog = cleanBuildLog(packageValidationError) || packageValidationError;
    const buildLogPersist = await persistProjectBuildLog(input.files, projectId, buildLog);
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
      sourceBytes: sourceCollection.totalBytes,
      durationMs,
      timings: zeroProjectBuildTimings({
        ...sourceCollection.timings,
        totalMs: durationMs,
      }),
      lockfilePersisted: false,
      buildLogPath: PROJECT_BUILD_LOG_PATH,
      buildLogPersisted: buildLogPersist.persisted,
      buildLogBytes: buildLogPersist.bytes,
      error: packageValidationError,
    };
  }
  const materializeTiming = await materializeProjectSourceFiles(input.sandbox, workdir, sourceFiles);

  const commandStartedAt = Date.now();
  const result = normalizeSandboxExecResult(await input.sandbox.exec("bun install && bun run build", {
    cwd: workdir,
    // @cloudflare/sandbox ExecOptions bounds execution via `timeout` (ms), not
    // `timeoutMs` — the wrong name is silently ignored and the session default
    // (as low as the 25s prewarm timeout) applies instead.
    timeout: timeoutMs,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      CAMELAI_PROJECT_ID: projectId,
      CAMELAI_BUILD_TIMEOUT_MS: String(timeoutMs),
    },
  }));
  const commandMs = Date.now() - commandStartedAt;
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
  const buildLogRaw = [result.stdout, result.stderr].filter(Boolean).join("\n") ||
    (result.exitCode === 0 ? "Build completed with no command output" : `Build failed with exit code ${result.exitCode}`);
  const buildLog = cleanBuildLog(buildLogRaw) || buildLogRaw;
  const buildLogPersist = await persistProjectBuildLog(input.files, projectId, buildLog);
  const persistStartedAt = Date.now();
  // Persist bun.lock even when the build fails: `bun install` typically succeeds and
  // resolves the lockfile before `bun run build` breaks, and discarding it forces the
  // next build to pay full dependency resolution again.
  let lockfilePersisted = false;
  try {
    lockfilePersisted = await persistBunLockfile(input.sandbox, input.files, workdir);
  } catch (error) {
    if (result.exitCode === 0) throw error;
    console.warn("[project-build] lockfile persist failed after build failure", {
      operation: "build",
      projectId,
      error: String(error),
    });
  }
  const persistMs = Date.now() - persistStartedAt;
  const durationMs = Date.now() - startedAt;
  const timings = zeroProjectBuildTimings({
    ...sourceCollection.timings,
    ...materializeTiming,
    commandMs,
    persistMs,
    totalMs: durationMs,
  });

  return {
    success: result.exitCode === 0,
    projectId,
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    fileCount: sourceFiles.length,
    sourceBytes: sourceCollection.totalBytes,
    durationMs,
    timings,
    lockfilePersisted,
    buildLogPath: PROJECT_BUILD_LOG_PATH,
    buildLogPersisted: buildLogPersist.persisted,
    buildLogBytes: buildLogPersist.bytes,
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
// Build log excerpt
//
// Return complete ANSI-stripped output for ordinary failures. Very large logs
// still use a capped tail so tool results do not drown the turn; the uncapped
// latest build output is persisted separately at PROJECT_BUILD_LOG_PATH.
// ---------------------------------------------------------------------------

const BUILD_LOG_EXCERPT_MAX_CHARS = 10_000;

export function cleanBuildLog(raw: string): string | null {
  const cleaned = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || null;
}

export function buildLogTail(raw: string): string | null {
  const cleaned = cleanBuildLog(raw);
  if (!cleaned) return null;
  if (cleaned.length <= BUILD_LOG_EXCERPT_MAX_CHARS) return cleaned;
  return `[truncated ${cleaned.length - BUILD_LOG_EXCERPT_MAX_CHARS} chars]\n${cleaned.slice(-BUILD_LOG_EXCERPT_MAX_CHARS)}`;
}

async function persistProjectBuildLog(
  files: WorkspaceFileStoreLike,
  projectId: string,
  content: string,
): Promise<{ persisted: boolean; bytes: number }> {
  const bytes = new TextEncoder().encode(content).byteLength;
  const result = await files.writeFile(PROJECT_BUILD_LOG_PATH, content);
  if (!result.success) {
    console.warn('[project-build] build log persist failed', {
      operation: 'build_log_persist',
      projectId,
      path: PROJECT_BUILD_LOG_PATH,
      bytes,
      error: result.error,
    });
    return { persisted: false, bytes };
  }
  return { persisted: true, bytes };
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

  const sourceCollection = await collectProjectSourceFiles(input.files);
  const sourceFiles = sourceCollection.files;
  const packageValidationError = validatePackageJson(sourceFiles);
  if (packageValidationError) {
    const durationMs = Date.now() - startedAt;
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
      sourceBytes: sourceCollection.totalBytes,
      durationMs,
      timings: zeroProjectBuildTimings({
        ...sourceCollection.timings,
        totalMs: durationMs,
      }),
      packageJsonPersisted: false,
      lockfilePersisted: false,
      error: packageValidationError,
    };
  }

  const materializeTiming = await materializeProjectSourceFiles(input.sandbox, workdir, sourceFiles);
  const command = `bun add ${dev ? "-d " : ""}${shellQuote(dependency)}`;
  const commandStartedAt = Date.now();
  const result = normalizeSandboxExecResult(await input.sandbox.exec(command, {
    cwd: workdir,
    timeout: DEFAULT_BUILD_TIMEOUT_MS,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      CAMELAI_PROJECT_ID: projectId,
    },
  }));
  const commandMs = Date.now() - commandStartedAt;
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
  const persistStartedAt = Date.now();
  const packageJsonPersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "package.json", { required: true })
    : false;
  const lockfilePersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "bun.lock", { required: false })
    : false;
  const persistMs = Date.now() - persistStartedAt;
  const durationMs = Date.now() - startedAt;
  const timings = zeroProjectBuildTimings({
    ...sourceCollection.timings,
    ...materializeTiming,
    commandMs,
    persistMs,
    totalMs: durationMs,
  });

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
    sourceBytes: sourceCollection.totalBytes,
    durationMs,
    timings,
    packageJsonPersisted,
    lockfilePersisted,
    ...(result.exitCode === 0 ? {} : { error: result.stderr || result.stdout || `Dependency install failed with exit code ${result.exitCode}` }),
  };
}

async function materializeProjectSourceFiles(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  sourceFiles: ProjectSourceFile[],
): Promise<Pick<ProjectBuildTimings, "materializeMs" | "previousManifestReadMs" | "archiveCreateMs" | "archiveWriteMs" | "materializeExecMs">> {
  const startedAt = Date.now();
  await sandbox.mkdir(workdir, { recursive: true });
  const manifest = sourceManifestForFiles(sourceFiles);
  const manifestPath = `${workdir}.next-source-manifest.json`;
  const currentManifestPath = sourceManifestPath(workdir);
  const archivePath = `${workdir}.source.tar`;

  const previousManifestStartedAt = Date.now();
  const previousManifest = await readSourceManifestFromSandbox(sandbox, workdir);
  const previousManifestReadMs = Date.now() - previousManifestStartedAt;
  const previousFiles = previousManifest
    ? new Map(previousManifest.files.map((file) => [file.path, file]))
    : null;
  const changedFiles = previousFiles
    ? sourceFiles.filter((file) => {
      const previous = previousFiles.get(file.path);
      return !previous || previous.size !== file.bytes.byteLength || previous.sha256 !== file.sha256;
    })
    : sourceFiles;

  const archiveCreateStartedAt = Date.now();
  const archive = changedFiles.length > 0 ? createTarArchive(changedFiles) : null;
  const archiveCreateMs = Date.now() - archiveCreateStartedAt;

  const archiveWriteStartedAt = Date.now();
  if (archive) {
    await sandbox.writeFile(archivePath, bytesToBase64(archive), { encoding: "base64" });
  }
  await sandbox.writeFile(
    manifestPath,
    bytesToBase64(new TextEncoder().encode(JSON.stringify(manifest))),
    { encoding: "base64" },
  );
  const archiveWriteMs = Date.now() - archiveWriteStartedAt;

  const materializeExecStartedAt = Date.now();
  await sandbox.exec(materializeCommand({
    workdir,
    currentManifestPath,
    manifestPath,
    archivePath,
    extractArchive: archive !== null,
    forceClean: previousManifest === null,
  }), { cwd: PROJECT_BUILD_ROOT });
  const materializeExecMs = Date.now() - materializeExecStartedAt;

  return {
    materializeMs: Date.now() - startedAt,
    previousManifestReadMs,
    archiveCreateMs,
    archiveWriteMs,
    materializeExecMs,
  };
}

function validatePackageJsonBuildScript(sourceFiles: ProjectSourceFile[]): string | null {
  const packageJson = sourceFiles.find((file) => file.path === "package.json");
  if (!packageJson) return "Project package.json is required for build_project";
  const parsed = parseProjectPackageJson(packageJson);
  if (typeof parsed === "string") return parsed;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  const buildScriptMessage = "Project package.json must define scripts.build. Use scaffold_project to seed the react-router scaffold, and list every CLI used by scripts.build in dependencies or devDependencies. Data-analysis projects have no build step — use run_notebook to execute the notebook, then deploy_project to publish it as a static report app.";
  if (!scripts || typeof scripts !== "object") return buildScriptMessage;
  const build = (scripts as { build?: unknown }).build;
  return typeof build === "string" && build.trim() ? null : buildScriptMessage;
}

const DO_SQLITE_CHECK_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
// Matches D1-style `sql.prepare(...)` calls on Durable Object SQLite storage
// (`this.sql.prepare(`, `ctx.storage.sql.prepare(`). `\b` keeps identifiers like
// `mysql`/`libsql` from matching.
const D1_STYLE_PREPARE_PATTERN = /\bsql\s*\.\s*prepare\s*\(/;

// Current scaffolds typecheck during the build, but older projects' build scripts
// (react-router build via esbuild) strip types without checking them, so D1-style
// calls on SqlStorage build cleanly and only crash at runtime after deploy. Catch the
// known footgun here for every project, with a corrective message that names the fix
// (tsc only says the property doesn't exist).
function validateDoSqliteApiUsage(sourceFiles: ProjectSourceFile[]): string | null {
  const decoder = new TextDecoder();
  for (const file of sourceFiles) {
    if (!DO_SQLITE_CHECK_EXTENSIONS.test(file.path)) continue;
    const content = decoder.decode(file.bytes);
    const match = D1_STYLE_PREPARE_PATTERN.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    return [
      `${file.path}:${line} calls .prepare() on Durable Object SQLite storage, which does not exist and will crash at runtime after deploy.`,
      `Durable Object SqlStorage is not the D1 API: there is no .prepare(), .bind(), .all(), .first(), .run(), or .batch().`,
      `Pass parameters directly to exec and read the cursor, e.g. this.ctx.storage.sql.exec("SELECT * FROM items WHERE id = ?", id).toArray() — or .one() for a single row, .raw() for column arrays.`,
    ].join(" ");
  }
  return null;
}

function sourceManifestForFiles(sourceFiles: ProjectSourceFile[]): SourceManifest {
  return {
    schemaVersion: 1,
    files: sourceFiles.map((file) => ({
      path: file.path,
      size: file.bytes.byteLength,
      sha256: file.sha256,
    })),
  };
}

async function readSourceManifestFromSandbox(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
): Promise<SourceManifest | null> {
  if (!sandbox.readFile) return null;
  let read: { content: string };
  try {
    read = await sandbox.readFile(sourceManifestPath(workdir), { encoding: "base64" });
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("missing") || message.includes("not found") || message.includes("enoent")) return null;
    throw error;
  }
  try {
    return validateSourceManifest(JSON.parse(new TextDecoder().decode(base64ToBytes(read.content))));
  } catch {
    // Treat malformed old state as a cache miss. The materializer will wipe the
    // workdir before extracting the full source archive.
    return null;
  }
}

function validateSourceManifest(value: unknown): SourceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid source manifest");
  const record = value as SourceManifest;
  if (record.schemaVersion !== 1 || !Array.isArray(record.files)) throw new Error("invalid source manifest");
  const files = record.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("invalid source manifest");
    const entry = file as { path?: unknown; size?: unknown; sha256?: unknown };
    if (typeof entry.path !== "string" || !entry.path || entry.path.includes("\0") || entry.path.startsWith("/")) {
      throw new Error("invalid source manifest");
    }
    if (typeof entry.size !== "number" || entry.size < 0 || !Number.isFinite(entry.size)) throw new Error("invalid source manifest");
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error("invalid source manifest");
    return { path: normalizeRelativeBuildPath(entry.path), size: entry.size, sha256: entry.sha256.toLowerCase() };
  }).filter((file) => file.path);
  return { schemaVersion: 1, files };
}

function sourceManifestPath(workdir: string): string {
  return `${workdir}.source-manifest.json`;
}

function materializeCommand(input: { workdir: string; currentManifestPath: string; manifestPath: string; archivePath: string; extractArchive: boolean; forceClean?: boolean }): string {
  const commands = [
    `CAMELAI_WORKDIR=${shellQuote(input.workdir)} CAMELAI_CURRENT_MANIFEST=${shellQuote(input.currentManifestPath)} CAMELAI_NEXT_MANIFEST=${shellQuote(input.manifestPath)} CAMELAI_FORCE_CLEAN=${input.forceClean ? "1" : "0"} bun -e ${shellQuote(SOURCE_MATERIALIZE_SCRIPT)}`,
  ];
  if (input.extractArchive) {
    commands.push(`tar -xf ${shellQuote(input.archivePath)} -C ${shellQuote(input.workdir)}`);
    commands.push(`rm -f ${shellQuote(input.archivePath)}`);
  } else {
    commands.push(`rm -f ${shellQuote(input.archivePath)}`);
  }
  commands.push(`mv ${shellQuote(input.manifestPath)} ${shellQuote(input.currentManifestPath)}`);
  commands.push(`find ${shellQuote(input.workdir)} -type d -empty -delete 2>/dev/null || true`);
  return commands.join(" && ");
}

const SOURCE_MATERIALIZE_SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const workdir = process.env.CAMELAI_WORKDIR;
const currentManifestPath = process.env.CAMELAI_CURRENT_MANIFEST;
const nextManifestPath = process.env.CAMELAI_NEXT_MANIFEST;
if (!workdir || !currentManifestPath || !nextManifestPath) throw new Error("missing materialize inputs");
fs.mkdirSync(workdir, { recursive: true });
const next = JSON.parse(fs.readFileSync(nextManifestPath, "utf8"));
const nextFiles = Array.isArray(next.files) ? next.files : [];
const forceClean = process.env.CAMELAI_FORCE_CLEAN === "1";
const safeResolve = (relativePath) => {
  const target = path.resolve(workdir, relativePath);
  const root = path.resolve(workdir);
  if (target !== root && target.startsWith(root + path.sep)) return target;
  throw new Error("unsafe source path: " + relativePath);
};
if (forceClean || !fs.existsSync(currentManifestPath)) {
  for (const name of fs.readdirSync(workdir)) {
    fs.rmSync(path.join(workdir, name), { recursive: true, force: true });
  }
} else {
  const current = JSON.parse(fs.readFileSync(currentManifestPath, "utf8"));
  const keep = new Set(nextFiles.map((file) => file.path));
  for (const file of Array.isArray(current.files) ? current.files : []) {
    if (!file || typeof file.path !== "string" || keep.has(file.path)) continue;
    fs.rmSync(safeResolve(file.path), { force: true });
  }
}
`;

function createTarArchive(sourceFiles: ProjectSourceFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const file of sourceFiles) {
    chunks.push(tarHeader(file.path, file.bytes.byteLength));
    chunks.push(file.bytes);
    const padding = tarPadding(file.bytes.byteLength);
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarPath(path);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, "0000644");
  writeTarString(header, 108, 8, "0000000");
  writeTarString(header, 116, 8, "0000000");
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  header[156] = 0x30;
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  if (prefix) writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function splitTarPath(path: string): { name: string; prefix?: string } {
  if (/[\0\r\n]/.test(path)) throw new Error(`Invalid source path for archive: ${path}`);
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength <= 100) return { name: path };
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (new TextEncoder().encode(prefix).byteLength <= 155 && new TextEncoder().encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Source path is too long for archive: ${path}`);
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > length) throw new Error(`Tar field is too long: ${value}`);
  header.set(encoded, offset);
}

function writeTarOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeTarString(header, offset, length - 1, text);
  header[offset + length - 1] = 0;
}

function writeTarChecksum(header: Uint8Array, value: number): void {
  const text = value.toString(8).padStart(6, "0").slice(-6);
  writeTarString(header, 148, 6, text);
  header[154] = 0;
  header[155] = 0x20;
}

function tarPadding(size: number): number {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
    const sandbox = getSandbox(this.env.PROJECT_BUILD_SANDBOX, projectBuildSandboxKey(this.ctx.props.orgId), {
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
    const sandbox = getSandbox(this.env.PROJECT_BUILD_SANDBOX, projectBuildSandboxKey(this.ctx.props.orgId), {
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

async function collectProjectSourceFiles(files: WorkspaceFileStoreLike): Promise<ProjectSourceCollection> {
  const startedAt = Date.now();
  const listStartedAt = Date.now();
  const listing = await files.listFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
  const sourceListMs = Date.now() - listStartedAt;
  if (!listing.success) throw new Error(listing.error || "Failed to list project files");
  const entries = listing.files
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ entry, relativePath: normalizeRelativeBuildPath(entry.absolutePath) }))
    .filter(({ relativePath }) => Boolean(relativePath) && !shouldIgnoreBuildSourcePath(relativePath));

  const readStartedAt = Date.now();
  const readFiles = await mapWithConcurrency(entries, SOURCE_READ_CONCURRENCY, async ({ entry, relativePath }) => {
    const read = await files.readFile(entry.absolutePath);
    if (!read.success || typeof read.content !== "string") {
      throw new Error(read.error || `Failed to read ${entry.absolutePath}`);
    }
    const bytes = read.encoding === "base64"
      ? base64ToBytes(read.content)
      : new TextEncoder().encode(read.content);
    return { path: relativePath, bytes };
  });
  const sourceReadMs = Date.now() - readStartedAt;

  const hashStartedAt = Date.now();
  const out = await mapWithConcurrency(readFiles, SOURCE_READ_CONCURRENCY, async (file) => {
    const sha256 = await sha256Hex(file.bytes);
    return {
      ...file,
      sha256,
    };
  });
  const sourceHashMs = Date.now() - hashStartedAt;
  const totalBytes = out.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  return {
    files: out.sort((a, b) => a.path.localeCompare(b.path)),
    totalBytes,
    timings: {
      collectSourceMs: Date.now() - startedAt,
      sourceListMs,
      sourceReadMs,
      sourceHashMs,
    },
  };
}

function shouldIgnoreBuildSourcePath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) =>
    part === "node_modules" ||
    part === ".camelai" ||
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

export function projectBuildSandboxKey(orgId: string): string {
  const org = orgId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!org) throw new Error("orgId is required");
  const readable = `org-${org}`;
  if (readable.length <= MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH) return readable;
  const hash = stableHexHash(org);
  const prefixLength = MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH - hash.length - 1;
  const prefix = readable.slice(0, prefixLength).replace(/-+$/g, "");
  return `${prefix}-${hash}`;
}

export interface ProjectBuildSandboxNamespaceEnv {
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<ProjectBuildSandbox>;
}

/**
 * Best-effort prewarm of the per-org build container so its cold
 * boot (10s+, see src/entry.server.tsx) is paid ahead of an interactive or
 * scheduled deploy instead of synchronously at deploy time. Runs a trivial
 * no-op command to trigger the boot, reusing the exact sandbox key that
 * runProjectBuild/deploy use so the warm instance is the one they acquire.
 *
 * Never throws: callers fire this from waitUntil and a warm failure (binding
 * absent, container busy, transient error) must not affect the turn. Returns
 * true only when the no-op command actually completed against the container.
 */
export async function prewarmProjectBuildSandbox(input: {
  env: ProjectBuildSandboxNamespaceEnv;
  orgId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const namespace = input.env.PROJECT_BUILD_SANDBOX;
  if (!namespace) return false;
  const orgId = input.orgId?.trim();
  if (!orgId) return false;

  let key: string;
  try {
    key = projectBuildSandboxKey(orgId);
  } catch {
    // Invalid ids should never blow up a prewarm; the real build will surface
    // the error loudly at deploy time.
    return false;
  }

  const timeoutMs = Math.max(
    1_000,
    Math.floor(input.timeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS),
  );
  const startedAt = Date.now();
  try {
    const sandbox = getSandbox(namespace, key, {
      normalizeId: true,
      transport: "rpc",
    }) as unknown as ProjectBuildSandboxLike;
    // @cloudflare/sandbox's ExecOptions bounds execution via `timeout` (ms), not
    // `timeoutMs`; pass `timeout` so the prewarm actually fails fast instead of
    // hanging in waitUntil on a cold-start/control-plane stall.
    await sandbox.exec("true", { timeout: timeoutMs });
    return true;
  } catch (error) {
    console.warn("[project-build] prewarm failed", {
      operation: "prewarm",
      orgId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Prewarm the shared per-org build container for a workspace.
 * Used by both the interactive turn-start path (ChatThreadDO) and the scheduled
 * automation path (WorkspaceCronDO): at those moments a deploy is likely, and
 * The build sandbox is keyed by org, not by project, so this works even before a
 * new project exists in the workspace. That is the important interactive case:
 * turn-start prewarm should hide cold boot before the agent creates and deploys
 * a new app.
 *
 * Best-effort: never throws. Returns 1 when the org sandbox was warmed, 0 when
 * unavailable or failed.
 */
export async function prewarmWorkspaceBuildSandboxes(
  env: ProjectBuildSandboxNamespaceEnv,
  orgId: string,
  _workspaceId: string,
  options: { timeoutMs?: number; maxTargets?: number } = {},
): Promise<number> {
  if (!env.PROJECT_BUILD_SANDBOX) return 0;
  if (!orgId?.trim()) return 0;
  const warmed = await prewarmProjectBuildSandbox({ env, orgId, timeoutMs: options.timeoutMs });
  return warmed ? 1 : 0;
}

function stableHexHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

function zeroProjectBuildTimings(partial: Partial<ProjectBuildTimings> = {}): ProjectBuildTimings {
  return {
    collectSourceMs: 0,
    sourceListMs: 0,
    sourceReadMs: 0,
    sourceHashMs: 0,
    materializeMs: 0,
    previousManifestReadMs: 0,
    archiveCreateMs: 0,
    archiveWriteMs: 0,
    materializeExecMs: 0,
    commandMs: 0,
    persistMs: 0,
    totalMs: 0,
    ...partial,
  };
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
