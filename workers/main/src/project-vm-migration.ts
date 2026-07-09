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
import type { WorkspaceFilesystemLike, WorkspaceFileStoreLike, WorkspaceProject } from "./workspace-filesystem-do";

/** Default per-file size cap; larger files are skipped and recorded. */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Default per-project cap on total copied bytes; exceeding it fails the project. */
export const DEFAULT_MAX_PROJECT_BYTES = 512 * 1024 * 1024;

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
  reason: "excluded-dir" | "excluded-file" | "file-too-large";
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
  snapshotId: string | null;
  error: string | null;
  durationMs: number;
}

export interface MigrateVmProjectOptions {
  dryRun?: boolean;
  maxFileBytes?: number;
  maxProjectBytes?: number;
}

export interface MigrateVmProjectDeps {
  bridge: ProjectRuntimeServiceVmBridge;
  workspaceFs: WorkspaceFilesystemLike;
  /** Per-project DO file store factory, keyed by global project id. */
  fileStoreForProject: (projectId: string) => WorkspaceFileStoreLike;
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
    snapshotId: null,
    durationMs: 0,
  };

  const finish = (
    result: Omit<ProjectMigrationResult, "durationMs">,
  ): ProjectMigrationResult => ({ ...result, durationMs: now() - startedAt });

  if ((project.backend ?? "vm") === "do-r2") {
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

  let rootPackageJson: string | null = null;
  let bytesCopied = 0;
  let filesCopied = 0;
  const fileStore = deps.fileStoreForProject(project.id);

  if (!dryRun) {
    for (const file of kept) {
      const read = await deps.bridge.readFileBytesForTransfer({ projectId: project.id, path: file.path });
      if (file.relativePath === "package.json") {
        rootPackageJson = new TextDecoder().decode(read.bytes);
      }
      const destination = `/${file.relativePath}`;
      const write = await fileStore.writeBinaryFile(destination, bytesToBase64(read.bytes));
      if (!write.success) {
        return finish({
          ...base,
          skipped,
          missingVmCheckout,
          filesCopied,
          bytesCopied,
          status: "failed",
          error: `Failed to write ${destination}: ${write.error ?? "unknown error"}`,
        });
      }
      bytesCopied += read.bytes.byteLength;
      filesCopied += 1;
    }
  } else if (kept.some((file) => file.relativePath === "package.json")) {
    const read = await deps.bridge.readFileBytesForTransfer({
      projectId: project.id,
      path: kept.find((file) => file.relativePath === "package.json")!.path,
    });
    rootPackageJson = new TextDecoder().decode(read.bytes);
  }

  const classification = classifyMigrationFiles(kept, rootPackageJson);

  if (dryRun) {
    return finish({
      ...base,
      classification,
      skipped,
      missingVmCheckout,
      filesCopied: kept.length,
      bytesCopied: plannedBytes,
      status: "dry-run",
      error: null,
    });
  }

  let snapshotId: string | null = null;
  if (kept.length > 0) {
    const snapshot = await fileStore.createSourceSnapshot({ message: "Imported from legacy project VM" });
    snapshotId = snapshot.id;
  }

  await deps.workspaceFs.setProjectBackend({ projectId: project.id, backend: "do-r2" });

  return finish({
    ...base,
    classification,
    skipped,
    missingVmCheckout,
    filesCopied,
    bytesCopied,
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
