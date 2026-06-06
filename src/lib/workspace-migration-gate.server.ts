import type { CloudflareEnv } from "@/lib/cloudflare.server";
import type {
  LegacyWorkspaceMigrationState,
  LegacyWorkspaceMigrationStatus,
  WorkspaceFilesystemClient,
} from "../../workers/main/src/workspace-filesystem-do";
import { queueLegacyWorkspaceMigrationIfNeeded } from "../../workers/main/src/legacy-workspace-migration-queue";
import { CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION } from "./legacy-workspace-migration-version";

const ACTIVE_MIGRATION_STATUSES = new Set<LegacyWorkspaceMigrationStatus>([
  "queued",
  "scanning_legacy",
  "planning",
  "copying",
  "verifying",
  "failed",
  "canceled",
]);

export interface WorkspaceMigrationGate {
  workspaceId: string;
  status: LegacyWorkspaceMigrationStatus;
  reason: "active" | "needed";
}

export async function getWorkspaceMigrationGate(
  env: CloudflareEnv,
  workspace: { id: string; org_id: string; archived?: boolean } | null,
): Promise<WorkspaceMigrationGate | null> {
  const workspaceId = workspace?.id ?? null;
  if (
    !workspaceId ||
    !workspace?.org_id ||
    workspace.archived ||
    env.ENABLE_LEGACY_WORKSPACE_MIGRATION !== "1" ||
    !env.WORKSPACE_FS ||
    !env.LEGACY_WORKSPACE_MIGRATIONS ||
    !isLegacyMigrationRuntimeConfigured(env)
  ) {
    return null;
  }

  try {
    const workspaceFs = await createWorkspaceFilesystemClient(env, workspaceId);
    const migrationState = await workspaceFs.getLegacyWorkspaceMigrationState();

    if (ACTIVE_MIGRATION_STATUSES.has(migrationState.status)) {
      return {
        workspaceId,
        status: migrationState.status,
        reason: "active",
      };
    }

    if (!isCurrentCompletedMigration(migrationState)) {
      const queuedState = await enqueueWorkspaceMigration(env, workspace);
      return {
        workspaceId,
        status: queuedState?.status ?? "not_started",
        reason: queuedState && ACTIVE_MIGRATION_STATUSES.has(queuedState.status) ? "active" : "needed",
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

async function enqueueWorkspaceMigration(
  env: CloudflareEnv,
  workspace: { id: string; org_id: string },
): Promise<LegacyWorkspaceMigrationState | null> {
  try {
    const result = await queueLegacyWorkspaceMigrationIfNeeded({
      env: env as never,
      workspaceId: workspace.id,
      orgId: workspace.org_id,
      requestedBy: "workspace-page-gate",
      dryRun: false,
    });
    return result.state;
  } catch (error) {
    console.error("Failed to enqueue workspace migration:", error);
    return null;
  }
}

function isLegacyMigrationRuntimeConfigured(env: CloudflareEnv): boolean {
  return Boolean(
    env.LEGACY_WORKSPACE_HOST ||
      (typeof env.LEGACY_WORKSPACE_SERVICE_URL === "string" &&
        env.LEGACY_WORKSPACE_SERVICE_URL.trim()),
  );
}

function isCurrentCompletedMigration(state: LegacyWorkspaceMigrationState): boolean {
  return (
    state.status === "complete" &&
    state.migrationVersion >= CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION
  );
}
