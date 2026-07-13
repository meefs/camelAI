import { mapWithConcurrency } from "../../../src/lib/map-with-concurrency";

import { base64ToBytes, bytesToBase64 } from "./base64-codec.js";
import { sha256Hex } from "./sha256.js";
import type { WorkspaceFileStoreLike } from "./workspace-filesystem-do.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

export const PROJECT_BUILD_ROOT = "/workspace";
const SOURCE_READ_CONCURRENCY = 16;

export interface ProjectBuildSourceTimings {
  collectSourceMs: number;
  sourceListMs: number;
  sourceReadMs: number;
  sourceHashMs: number;
  materializeMs: number;
  previousManifestReadMs: number;
  archiveCreateMs: number;
  archiveWriteMs: number;
  materializeExecMs: number;
}

export interface ProjectSourceFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface ProjectSourceCollection {
  files: ProjectSourceFile[];
  timings: Pick<
    ProjectBuildSourceTimings,
    "collectSourceMs" | "sourceListMs" | "sourceReadMs" | "sourceHashMs"
  >;
  totalBytes: number;
}

interface SourceManifest {
  schemaVersion: 1;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export async function collectProjectSourceFiles(files: WorkspaceFileStoreLike): Promise<ProjectSourceCollection> {
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

export function shouldIgnoreBuildSourcePath(path: string): boolean {
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

export function normalizeRelativeBuildPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

export async function materializeProjectSourceFiles(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  sourceFiles: ProjectSourceFile[],
): Promise<Pick<ProjectBuildSourceTimings, "materializeMs" | "previousManifestReadMs" | "archiveCreateMs" | "archiveWriteMs" | "materializeExecMs">> {
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

export function validatePackageJsonBuildScript(sourceFiles: ProjectSourceFile[]): string | null {
  const packageJson = sourceFiles.find((file) => file.path === "package.json");
  if (!packageJson) return "Project package.json is required for build_project";
  const parsed = parseProjectPackageJson(packageJson);
  if (typeof parsed === "string") return parsed;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  const buildScriptMessage = "Project package.json must define scripts.build. Create a new project to get the standard react-router scaffold, and list every CLI used by scripts.build in dependencies or devDependencies. Data-analysis projects have no build step — use run_notebook to execute the notebook, then deploy_project to publish it as a static report app.";
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
export function validateDoSqliteApiUsage(sourceFiles: ProjectSourceFile[]): string | null {
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
  const manifestPath = sourceManifestPath(workdir);
  // A missing manifest is the normal first-build cache-miss path. Avoid using a
  // rejected readFile RPC as an existence probe: the eval runtime can surface a
  // handled Sandbox RPC rejection as a Vitest unhandled error after the caller
  // has already recovered from it.
  if (sandbox.exists) {
    const existence = await sandbox.exists(manifestPath);
    if (!existence.exists) return null;
  }
  let read: { content: string };
  try {
    read = await sandbox.readFile(manifestPath, { encoding: "base64" });
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
  // oxlint-disable-next-line no-control-regex -- Tar paths must reject NUL and newline characters.
  if (/[\u0000\r\n]/.test(path)) throw new Error(`Invalid source path for archive: ${path}`);
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

export function validatePackageJson(sourceFiles: ProjectSourceFile[]): string | null {
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

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const __testing = {
  normalizeRelativeBuildPath,
  shouldIgnoreBuildSourcePath,
};
