/**
 * Migration of legacy VM-backed projects (`backend: "vm"`) to DO+R2-backed
 * projects (`backend: "do-r2"`).
 *
 * The VM filesystem is the only authoritative source: Artifacts git remotes
 * exist for legacy projects but almost none ever received a commit, so the
 * migration walks the project's VM checkout through the runtime-service
 * bridge, copies source files into the per-project WorkspaceFilesystemDO
 * store, seeds an initial source snapshot, and flips the registry backend.
 *
 * VM checkouts are never modified or deleted here — rollback for any project
 * is flipping the backend back to "vm".
 */

import type { ProjectRuntimeServiceVmBridge, ProjectVmTransferFile } from "./project-runtime-service-vm";
import type {
  ProjectSourceSnapshot,
  WorkspaceAdoptR2FileResponse,
  WorkspaceFileStoreLike,
  WorkspaceFilesystemLike,
  WorkspaceProject,
} from "./workspace-filesystem-do";

/** Default per-file size cap; larger files are skipped and recorded. */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** Default per-project cap on total copied bytes; exceeding it fails the project. */
export const DEFAULT_MAX_PROJECT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Files at or above this size cannot ride the writeBinaryFile DO RPC: it whole-
 * buffers the file and base64-inflates it 4/3, so a ~32 MiB RPC payload caps
 * the usable file around 23 MiB. Bigger files stream VM -> R2 through
 * `adoptR2File` instead, which never buffers the payload. Kept comfortably
 * under the base64 ceiling.
 */
export const RPC_SAFE_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The per-project store surface the migrator needs. This is the store-like
 * read/write subset plus the project-only snapshot + large-file adopt methods
 * that `ProjectFilesystemClient` provides (they are not on the shared
 * `WorkspaceFileStoreLike`).
 */
export type MigrationFileStore = Pick<
  WorkspaceFileStoreLike,
  "readFileStream" | "writeBinaryFile" | "deleteFile"
> & {
  adoptR2File(
    path: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    contentType?: string,
  ): Promise<WorkspaceAdoptR2FileResponse>;
  createSourceSnapshot(input?: { message?: unknown }): Promise<ProjectSourceSnapshot>;
};

/**
 * Directory names (any path segment) that never migrate: dependency caches,
 * build output, VCS state, and container-home runtime junk. The VM checkout
 * doubles as the container HOME, so dotdirs like .bun/.claude/.ssh show up
 * next to real source.
 */
const SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".bun",
  ".npm",
  ".cache",
  ".config",
  ".local",
  ".ssh",
  ".pki",
  ".gnupg",
  ".claude",
  ".codex",
  ".EasyOCR",
  ".ipython",
  ".jupyter",
  "dist",
  "build",
  ".next",
  ".vercel",
  ".nuxt",
  ".svelte-kit",
  ".wrangler",
  ".turbo",
  ".output",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
]);

/** File basenames that never migrate (container-home runtime junk). */
const SKIP_FILE_NAMES = new Set([
  ".claude.json",
  ".gitconfig",
  ".bash_history",
  ".bashrc",
  ".profile",
  ".python-version",
  ".DS_Store",
  ".viminfo",
  ".wget-hsts",
]);

export interface MigrationSkippedFile {
  path: string;
  size: number;
  reason: "excluded-dir" | "excluded-file" | "file-too-large" | "unreadable";
}

export type MigrationClassification =
  | "package-build"
  | "package-no-build"
  | "nested-package"
  | "notebook"
  | "static-html"
  | "loose-files"
  | "empty";

export type MigrationStatus =
  | "migrated"
  | "dry-run"
  | "already-do-r2"
  | "partial"
  | "failed";

export interface ProjectMigrationResult {
  projectId: string;
  projectName: string;
  status: MigrationStatus;
  classification: MigrationClassification;
  filesCopied: number;
  bytesCopied: number;
  skipped: MigrationSkippedFile[];
  /** True when the VM has no checkout directory for this project. */
  missingVmCheckout: boolean;
  /**
   * Directories containing a package.json ("" = project root). Legacy VM
   * projects could hold several deployable apps in subfolders (the agent just
   * ran wrangler in the right directory); more than one root — or a single
   * non-root one — needs review before the do-r2 root-build assumption holds.
   */
  appRoots: string[];
  /** Relative paths of wrangler config files found in the kept source. */
  wranglerConfigs: string[];
  /** Files re-read from DO storage and hash-compared against the VM bytes. */
  verifiedFiles: number;
  /** Set when a single nested app directory was lifted to the project root. */
  liftedRoot: string | null;
  snapshotId: string | null;
  /** Total files in the copy plan (all chunks), once listing succeeded. */
  plannedFiles: number;
  /**
   * Set on status "partial": pass back as `fileOffset` on the next call to
   * continue the copy. Monster projects (thousands of files) cannot finish in
   * one Worker request, so callers chunk with `maxFilesPerCall`.
   */
  nextFileOffset: number | null;
  error: string | null;
  durationMs: number;
}

export interface MigrateVmProjectOptions {
  dryRun?: boolean;
  maxFileBytes?: number;
  maxProjectBytes?: number;
  /**
   * When the project has no root package.json but exactly one nested app
   * directory, copy that directory's contents as the project root so the
   * do-r2 root-build convention holds. Default true.
   */
  liftNestedRoot?: boolean;
  /**
   * Re-migrate a project that is already backend "do-r2": clears the DO file
   * tree first (so stale layouts don't linger) and re-copies from the VM.
   */
  force?: boolean;
  /**
   * Resume a chunked copy at this index into the (deterministic) copy plan.
   * Use the `nextFileOffset` from a prior "partial" result. Default 0.
   */
  fileOffset?: number;
  /**
   * Copy at most this many files in this call. When the plan is longer, the
   * result is status "partial" with `nextFileOffset` set, and verification/
   * snapshot/backend-flip are deferred to the final chunk. Default unlimited.
   */
  maxFilesPerCall?: number;
}

export interface MigrateVmProjectDeps {
  bridge: ProjectRuntimeServiceVmBridge;
  workspaceFs: WorkspaceFilesystemLike;
  /** Per-project DO file store factory, keyed by global project id. */
  fileStoreForProject: (projectId: string) => MigrationFileStore;
  now?: () => number;
}

export function shouldSkipMigrationPath(relativePath: string, size: number, maxFileBytes: number): MigrationSkippedFile["reason"] | null {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return "excluded-file";
  const basename = segments[segments.length - 1]!;
  for (const segment of segments.slice(0, -1)) {
    if (SKIP_DIR_SEGMENTS.has(segment) || /-venv$/.test(segment)) return "excluded-dir";
  }
  // A directory-style skip name appearing as the final segment is still a
  // directory listing artifact guard; files named like skip dirs are rare and
  // intentionally kept (e.g. a source file could not collide with these).
  if (SKIP_FILE_NAMES.has(basename)) return "excluded-file";
  if (size > maxFileBytes) return "file-too-large";
  return null;
}

export function classifyMigrationFiles(
  files: Array<{ relativePath: string }>,
  rootPackageJson: string | null,
): MigrationClassification {
  if (files.length === 0) return "empty";
  const hasRootPackage = files.some((file) => file.relativePath === "package.json");
  if (hasRootPackage) {
    let hasBuildScript = false;
    if (rootPackageJson) {
      try {
        const parsed = JSON.parse(rootPackageJson) as { scripts?: Record<string, unknown> };
        hasBuildScript = typeof parsed.scripts?.build === "string";
      } catch {
        hasBuildScript = false;
      }
    }
    return hasBuildScript ? "package-build" : "package-no-build";
  }
  if (files.some((file) => /^[^/]+\/package\.json$/.test(file.relativePath))) return "nested-package";
  if (files.some((file) => file.relativePath.endsWith(".ipynb"))) return "notebook";
  if (files.some((file) => file.relativePath.endsWith(".html") && file.relativePath.split("/").length <= 2)) {
    return "static-html";
  }
  return "loose-files";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function collectAppRoots(files: Array<{ relativePath: string }>): { appRoots: string[]; wranglerConfigs: string[] } {
  const appRoots = new Set<string>();
  const wranglerConfigs: string[] = [];
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const basename = segments[segments.length - 1]!;
    if (basename === "package.json") {
      appRoots.add(segments.slice(0, -1).join("/"));
    }
    if (/^wrangler\.(toml|json|jsonc)$/.test(basename)) {
      wranglerConfigs.push(file.relativePath);
    }
  }
  return { appRoots: [...appRoots].sort(), wranglerConfigs: wranglerConfigs.sort() };
}

interface PlannedCopyFile extends ProjectVmTransferFile {
  /** Project-relative destination after any nested-root lift. */
  destination: string;
}

/**
 * Plan destinations for kept files. When the tree has no root package.json
 * but exactly one nested app root, that directory's contents are lifted to
 * the project root; sibling files keep their paths unless they collide with
 * a lifted path (collisions are dropped and reported).
 */
export function planCopyDestinations(
  files: ProjectVmTransferFile[],
  liftNestedRoot: boolean,
): { planned: PlannedCopyFile[]; liftedRoot: string | null; collisions: MigrationSkippedFile[] } {
  const { appRoots } = collectAppRoots(files);
  const liftedRoot =
    liftNestedRoot && appRoots.length === 1 && appRoots[0] !== "" && appRoots[0] !== undefined
      ? appRoots[0]
      : null;
  if (!liftedRoot) {
    return { planned: files.map((file) => ({ ...file, destination: file.relativePath })), liftedRoot: null, collisions: [] };
  }
  const prefix = `${liftedRoot}/`;
  const lifted = new Set<string>();
  const planned: PlannedCopyFile[] = [];
  const collisions: MigrationSkippedFile[] = [];
  for (const file of files) {
    if (file.relativePath.startsWith(prefix)) {
      const destination = file.relativePath.slice(prefix.length);
      lifted.add(destination);
      planned.push({ ...file, destination });
    }
  }
  for (const file of files) {
    if (file.relativePath.startsWith(prefix)) continue;
    if (lifted.has(file.relativePath)) {
      collisions.push({
        path: file.relativePath,
        size: typeof file.size === "number" ? file.size : 0,
        reason: "excluded-file",
      });
      continue;
    }
    planned.push({ ...file, destination: file.relativePath });
  }
  return { planned, liftedRoot, collisions };
}

/**
 * Sample paths for post-copy verification: package.json, largest, first, last.
 * Only small files are eligible — big files stream through the R2 adopt path
 * and are verified by size during the copy, never read back through RPC (which
 * would whole-buffer a GB file).
 */
function pickVerificationSample(files: PlannedCopyFile[], limit = 5): Set<string> {
  const sample = new Set<string>();
  const small = files.filter((file) => (file.size ?? 0) < RPC_SAFE_FILE_BYTES);
  const rootPackage = small.find((file) => file.destination === "package.json");
  if (rootPackage) sample.add(rootPackage.destination);
  const bySize = [...small].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  for (const file of [bySize[0], small[0], small[small.length - 1], bySize[1]]) {
    if (file) sample.add(file.destination);
    if (sample.size >= limit) break;
  }
  return sample;
}

function isMissingCheckoutError(error: unknown): boolean {
  return error instanceof Error && /^Path not found:/.test(error.message);
}

/**
 * Migrate a single project from its VM checkout to DO+R2 storage.
 *
 * Never mutates the VM. Only flips the registry backend after every kept file
 * has been copied successfully; a thrown copy error leaves the project on
 * `backend: "vm"` and the run is safe to retry (writes are idempotent
 * overwrites).
 */
export async function migrateVmProject(
  deps: MigrateVmProjectDeps,
  project: WorkspaceProject,
  options: MigrateVmProjectOptions = {},
): Promise<ProjectMigrationResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxProjectBytes = options.maxProjectBytes ?? DEFAULT_MAX_PROJECT_BYTES;
  const dryRun = options.dryRun === true;

  const base: Omit<ProjectMigrationResult, "status" | "error"> = {
    projectId: project.id,
    projectName: project.name,
    classification: "empty",
    filesCopied: 0,
    bytesCopied: 0,
    skipped: [],
    missingVmCheckout: false,
    appRoots: [],
    wranglerConfigs: [],
    verifiedFiles: 0,
    liftedRoot: null,
    snapshotId: null,
    plannedFiles: 0,
    nextFileOffset: null,
    durationMs: 0,
  };

  const finish = (
    result: Omit<ProjectMigrationResult, "durationMs">,
  ): ProjectMigrationResult => ({ ...result, durationMs: now() - startedAt });

  if ((project.backend ?? "vm") === "do-r2" && options.force !== true) {
    return finish({ ...base, status: "already-do-r2", error: null });
  }

  let listed: ProjectVmTransferFile[] = [];
  let missingVmCheckout = false;
  try {
    listed = await deps.bridge.collectFilesForTransfer({ projectId: project.id });
  } catch (error) {
    if (isMissingCheckoutError(error)) {
      missingVmCheckout = true;
    } else {
      return finish({
        ...base,
        status: "failed",
        error: `Failed to list VM files: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const skipped: MigrationSkippedFile[] = [];
  const kept: ProjectVmTransferFile[] = [];
  for (const file of listed) {
    const size = typeof file.size === "number" ? file.size : 0;
    const reason = shouldSkipMigrationPath(file.relativePath, size, maxFileBytes);
    if (reason) {
      skipped.push({ path: file.relativePath, size, reason });
    } else {
      kept.push(file);
    }
  }

  const plannedBytes = kept.reduce((sum, file) => sum + (typeof file.size === "number" ? file.size : 0), 0);
  if (plannedBytes > maxProjectBytes) {
    return finish({
      ...base,
      skipped,
      missingVmCheckout,
      status: "failed",
      error: `Project source is ${plannedBytes} bytes, above the ${maxProjectBytes}-byte cap; raise max_project_bytes or handle manually`,
    });
  }

  const { planned, liftedRoot, collisions } = planCopyDestinations(
    kept,
    options.liftNestedRoot !== false,
  );
  skipped.push(...collisions);
  base.plannedFiles = planned.length;
  // Chunk bounds: the plan order is deterministic (listing order), so callers
  // resume with the offset from a prior "partial" result.
  const chunkStart = Math.min(Math.max(options.fileOffset ?? 0, 0), planned.length);
  const chunkEnd = options.maxFilesPerCall
    ? Math.min(chunkStart + options.maxFilesPerCall, planned.length)
    : planned.length;
  const { appRoots, wranglerConfigs } = collectAppRoots(
    planned.map((file) => ({ relativePath: file.destination })),
  );
  let rootPackageJson: string | null = null;
  let bytesCopied = 0;
  let filesCopied = 0;
  let verifiedFiles = 0;
  const fileStore = deps.fileStoreForProject(project.id);

  if (!dryRun) {
    if (options.force === true && chunkStart === 0) {
      // Re-migration: clear the DO tree first so a previous layout (e.g. an
      // unlifted nested copy) leaves no stale files behind. The store refuses
      // deleting "/" itself (EPERM), so delete each root entry and fail loudly
      // if any deletion fails — silently keeping stale files would corrupt the
      // re-migrated layout.
      const rootListing = await fileStore.listFiles("/", { includeHidden: true });
      for (const entry of rootListing.files ?? []) {
        const name = (entry.relativePath || entry.name || "").replace(/^\/+/, "");
        if (!name) continue;
        const deletion = await fileStore.deleteFile(`/${name}`, { recursive: true, force: true });
        if (!deletion.success) {
          return finish({
            ...base,
            skipped,
            missingVmCheckout,
            appRoots,
            wranglerConfigs,
            status: "failed",
            error: `Force re-migration failed to clear /${name}: ${deletion.error ?? "unknown error"}`,
          });
        }
      }
    }
    // Sample only files copied in THIS chunk: their VM hashes are in memory
    // for this request. Each chunk verifies its own sample before returning.
    const samplePaths = pickVerificationSample(planned.slice(chunkStart, chunkEnd));
    const sampleHashes = new Map<string, string>();
    // Copy with bounded concurrency: VM reads dominate wall-clock (one HTTP
    // round-trip each), so overlapping them matters; DO writes serialize
    // inside the Durable Object regardless.
    const copyConcurrency = 10;
    // Bound BYTES in flight, not just file count: ten near-20MB buffered files
    // at once (with base64 inflation) exceeded the isolate limit on archive-
    // shaped projects. Streaming adopt-path files cost zero budget; a file
    // costing more than the whole budget proceeds alone.
    const COPY_BYTES_BUDGET = 64 * 1024 * 1024;
    let bytesInFlight = 0;
    const budgetWaiters: Array<() => void> = [];
    const acquireCopyBudget = async (cost: number): Promise<void> => {
      while (bytesInFlight > 0 && bytesInFlight + cost > COPY_BYTES_BUDGET) {
        await new Promise<void>((resolve) => budgetWaiters.push(resolve));
      }
      bytesInFlight += cost;
    };
    const releaseCopyBudget = (cost: number): void => {
      bytesInFlight -= cost;
      for (const wake of budgetWaiters.splice(0)) wake();
    };
    let nextIndex = chunkStart;
    let copyError: string | null = null;
    const isMissingFileError = (error: unknown): boolean =>
      // "is a directory": the VM walk lists symlinks-to-directories as files
      // (size = link-text length); reading one errors service-side. Treat like
      // a ghost file — it has no copyable content.
      error instanceof Error && /(File|Path) not found|is a directory/i.test(error.message);
    const copyOne = async (file: PlannedCopyFile): Promise<void> => {
      const size = typeof file.size === "number" ? file.size : 0;
      // Buffered small-file reads hold raw bytes + a base64 copy (~2.4x);
      // streaming adopt-path files hold nothing, so they cost zero budget.
      const cost = size >= RPC_SAFE_FILE_BYTES ? 0 : Math.ceil(size * 2.4);
      await acquireCopyBudget(cost);
      try {
        await copyOneInner(file, size);
      } catch (error) {
        if (isMissingFileError(error)) {
          // Listed but unreadable: dangling symlink or a file that vanished
          // between listing and read (VM-as-computer churn). Record and move
          // on — failing the whole project over a ghost file strands the rest.
          skipped.push({ path: file.destination, size, reason: "unreadable" });
          return;
        }
        throw error;
      } finally {
        releaseCopyBudget(cost);
      }
    };
    const copyOneInner = async (file: PlannedCopyFile, size: number): Promise<void> => {
      const destination = `/${file.destination}`;

      if (size >= RPC_SAFE_FILE_BYTES) {
        // Big file: stream VM -> R2 and register the spilled-file row without
        // ever buffering the payload. Never hashed/read back through RPC; the
        // adopt path fails loudly if R2's stored size disagrees with the VM's.
        const { response } = await deps.bridge.readFileStream({ projectId: project.id, path: file.path });
        const body = response.body;
        if (!body) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`Failed to stream ${file.path}: response body is not streamable`);
        }
        const contentType = response.headers.get("content-type") ?? undefined;
        const adopt = await fileStore.adoptR2File(destination, body, size, contentType);
        if (!adopt.success) {
          throw new Error(`Failed to adopt ${destination}: ${adopt.error ?? "unknown error"}`);
        }
        bytesCopied += typeof adopt.size === "number" ? adopt.size : size;
        filesCopied += 1;
        return;
      }

      const read = await deps.bridge.readFileBytesForTransfer({ projectId: project.id, path: file.path });
      if (file.destination === "package.json") {
        rootPackageJson = new TextDecoder().decode(read.bytes);
      }
      if (samplePaths.has(file.destination)) {
        sampleHashes.set(file.destination, await sha256Hex(read.bytes));
      }
      if (read.bytes.byteLength >= RPC_SAFE_FILE_BYTES) {
        // Active checkouts drift between listing and read: a file that listed
        // small may have grown past the RPC-safe payload, and its base64 form
        // would blow workerd's 32MiB RPC value limit. Reroute the buffered
        // bytes through the streaming adopt path instead.
        const body = new Response(read.bytes).body;
        if (!body) {
          throw new Error(`Failed to stream grown file ${file.path}`);
        }
        const adopt = await fileStore.adoptR2File(destination, body, read.bytes.byteLength);
        if (!adopt.success) {
          throw new Error(`Failed to adopt ${destination}: ${adopt.error ?? "unknown error"}`);
        }
        bytesCopied += read.bytes.byteLength;
        filesCopied += 1;
        return;
      }
      const write = await fileStore.writeBinaryFile(destination, bytesToBase64(read.bytes));
      if (!write.success) {
        throw new Error(`Failed to write ${destination}: ${write.error ?? "unknown error"}`);
      }
      bytesCopied += read.bytes.byteLength;
      filesCopied += 1;
    };
    const copyWorker = async (): Promise<void> => {
      while (copyError === null) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= chunkEnd) return;
        const file = planned[index];
        if (!file) return;
        // Dropped connections under concurrency ("Network connection lost")
        // are transient; retry each file a couple of times before failing
        // the whole project.
        let attempt = 0;
        for (;;) {
          try {
            await copyOne(file);
            break;
          } catch (error) {
            attempt += 1;
            if (attempt >= 3) {
              copyError = error instanceof Error ? error.message : String(error);
              return;
            }
          }
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(copyConcurrency, chunkEnd - chunkStart) }, copyWorker));
    } catch (error) {
      copyError = error instanceof Error ? error.message : String(error);
    }
    if (copyError !== null) {
      return finish({
        ...base,
        skipped,
        missingVmCheckout,
        appRoots,
        wranglerConfigs,
        filesCopied,
        bytesCopied,
        status: "failed",
        error: copyError,
      });
    }

    // Re-read the sample from DO storage and hash-compare against the VM
    // bytes before flipping the backend: catches encoding/store corruption.
    // Must read raw bytes via the stream path — `readFile` text-decodes
    // mostly-text content, and non-UTF-8 bytes (Latin-1 CSVs) don't survive
    // the decode/re-encode round trip, producing false hash mismatches.
    for (const [relativePath, expectedHash] of sampleHashes) {
      const stored = await fileStore.readFileStream(`/${relativePath}`);
      if (!stored.success || !stored.stream) {
        return finish({
          ...base,
          skipped,
          missingVmCheckout,
          appRoots,
          wranglerConfigs,
          filesCopied,
          bytesCopied,
          status: "failed",
          error: `Post-copy verification failed to read back /${relativePath}: ${stored.error ?? "unknown error"}`,
        });
      }
      const storedBytes = new Uint8Array(await new Response(stored.stream).arrayBuffer());
      const storedHash = await sha256Hex(storedBytes);
      if (storedHash !== expectedHash) {
        return finish({
          ...base,
          skipped,
          missingVmCheckout,
          appRoots,
          wranglerConfigs,
          filesCopied,
          bytesCopied,
          verifiedFiles,
          status: "failed",
          error: `Post-copy verification hash mismatch for /${relativePath}`,
        });
      }
      verifiedFiles += 1;
    }

    if (chunkEnd < planned.length) {
      // More chunks to go: report progress and defer snapshot/flip/final
      // classification to the last chunk. The chunk's own sample verified.
      return finish({
        ...base,
        skipped,
        missingVmCheckout,
        appRoots,
        wranglerConfigs,
        filesCopied,
        bytesCopied,
        verifiedFiles,
        liftedRoot,
        status: "partial",
        nextFileOffset: chunkEnd,
        error: null,
      });
    }
  }

  if (rootPackageJson === null && planned.some((file) => file.destination === "package.json")) {
    // package.json wasn't read in this call (dry run, or it was copied in an
    // earlier chunk); fetch it so classification stays accurate.
    const read = await deps.bridge.readFileBytesForTransfer({
      projectId: project.id,
      path: planned.find((file) => file.destination === "package.json")!.path,
    });
    rootPackageJson = new TextDecoder().decode(read.bytes);
  }

  const classification = classifyMigrationFiles(
    planned.map((file) => ({ relativePath: file.destination })),
    rootPackageJson,
  );

  if (dryRun) {
    return finish({
      ...base,
      classification,
      skipped,
      missingVmCheckout,
      appRoots,
      wranglerConfigs,
      liftedRoot,
      filesCopied: planned.length,
      bytesCopied: plannedBytes,
      status: "dry-run",
      error: null,
    });
  }

  let snapshotId: string | null = null;
  if (planned.length > 0) {
    const snapshot = await fileStore.createSourceSnapshot({ message: "Imported from legacy project VM" });
    snapshotId = snapshot.id;
  }

  await deps.workspaceFs.setProjectBackend({ projectId: project.id, backend: "do-r2" });

  return finish({
    ...base,
    classification,
    skipped,
    missingVmCheckout,
    appRoots,
    wranglerConfigs,
    filesCopied,
    bytesCopied,
    verifiedFiles,
    liftedRoot,
    snapshotId,
    status: "migrated",
    error: null,
  });
}

export interface WorkspaceMigrationSummary {
  workspaceId: string;
  processed: number;
  migrated: number;
  alreadyDoR2: number;
  failed: number;
  dryRun: boolean;
  results: ProjectMigrationResult[];
}

/**
 * Migrate every legacy project in a workspace (or a single named project).
 * Projects are migrated sequentially: the runtime service walk and the DO
 * writes are both per-project bottlenecks, and sequential progress keeps
 * partial failures easy to reason about.
 */
export async function migrateWorkspaceVmProjects(
  deps: MigrateVmProjectDeps,
  workspaceId: string,
  options: MigrateVmProjectOptions & { projectName?: string } = {},
): Promise<WorkspaceMigrationSummary> {
  const projects = await deps.workspaceFs.listProjectsForMigrationReset();
  const targets = options.projectName
    ? projects.filter((project) => project.name === options.projectName)
    : projects;
  if (options.projectName && targets.length === 0) {
    throw new Error(`Project not found: ${options.projectName}`);
  }

  const results: ProjectMigrationResult[] = [];
  for (const project of targets) {
    results.push(await migrateVmProject(deps, project, options));
  }

  return {
    workspaceId,
    processed: results.length,
    migrated: results.filter((result) => result.status === "migrated").length,
    alreadyDoR2: results.filter((result) => result.status === "already-do-r2").length,
    failed: results.filter((result) => result.status === "failed").length,
    dryRun: options.dryRun === true,
    results,
  };
}
