import type { CloudflareEnv } from "@/lib/cloudflare.server";
import type {
  LegacyWorkspaceMigrationStatus,
  WorkspaceFilesystemClient,
} from "../../workers/main/src/workspace-filesystem-do";

const ACTIVE_MIGRATION_STATUSES = new Set<LegacyWorkspaceMigrationStatus>([
  "queued",
  "scanning_legacy",
  "planning",
  "copying",
  "verifying",
]);
const ACTIVE_MIGRATION_STALE_MS = 20 * 60 * 1000;

export interface WorkspaceMigrationGate {
  workspaceId: string;
  status: LegacyWorkspaceMigrationStatus;
  reason: "active" | "needed";
}

export async function getWorkspaceMigrationGate(
  env: CloudflareEnv,
  workspaceId: string | null,
): Promise<WorkspaceMigrationGate | null> {
  if (
    !workspaceId ||
    env.ENABLE_LEGACY_WORKSPACE_MIGRATION !== "1" ||
    !env.WORKSPACE_FS ||
    !isLegacyMigrationRuntimeConfigured(env)
  ) {
    return null;
  }

  try {
    const workspaceFs = await createWorkspaceFilesystemClient(env, workspaceId);
    const [migrationState, projects] = await Promise.all([
      workspaceFs.getLegacyWorkspaceMigrationState(),
      workspaceFs.listProjects(),
    ]);

    if (
      ACTIVE_MIGRATION_STATUSES.has(migrationState.status) &&
      !isStaleMigrationState(migrationState.updatedAt)
    ) {
      return {
        workspaceId,
        status: migrationState.status,
        reason: "active",
      };
    }

    if (migrationState.status === "not_started" && projects.length === 0) {
      return {
        workspaceId,
        status: migrationState.status,
        reason: "needed",
      };
    }
  } catch (error) {
    console.error("Failed to read workspace migration status:", error);
  }

  return null;
}

async function createWorkspaceFilesystemClient(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<WorkspaceFilesystemClient> {
  const { WorkspaceFilesystemClient } = await import("../../workers/main/src/workspace-filesystem-do");
  return new WorkspaceFilesystemClient(env as never, workspaceId);
}

function isLegacyMigrationRuntimeConfigured(env: CloudflareEnv): boolean {
  return Boolean(
    env.LEGACY_WORKSPACE_HOST ||
      (typeof env.LEGACY_WORKSPACE_SERVICE_URL === "string" &&
        env.LEGACY_WORKSPACE_SERVICE_URL.trim()),
  );
}

function isStaleMigrationState(updatedAt: string): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  return !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > ACTIVE_MIGRATION_STALE_MS;
}
