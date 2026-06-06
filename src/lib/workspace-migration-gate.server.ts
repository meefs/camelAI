import type { CloudflareEnv } from "@/lib/cloudflare.server";
import type {
  LegacyWorkspaceMigrationState,
  LegacyWorkspaceMigrationStatus,
  WorkspaceFilesystemClient,
} from "../../workers/main/src/workspace-filesystem-do";
import { CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION } from "./legacy-workspace-migration-version";

const ACTIVE_MIGRATION_STATUSES = new Set<LegacyWorkspaceMigrationStatus>([
  "queued",
  "scanning_legacy",
  "planning",
  "copying",
  "verifying",
]);

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

    if (ACTIVE_MIGRATION_STATUSES.has(migrationState.status)) {
      return {
        workspaceId,
        status: migrationState.status,
        reason: "active",
      };
    }

    if (migrationState.status === "not_started" && projects.length === 0) {
      const queuedState = await enqueueWorkspaceMigration(env, workspaceId);
      return {
        workspaceId,
        status: queuedState?.status ?? migrationState.status,
        reason: queuedState && ACTIVE_MIGRATION_STATUSES.has(queuedState.status) ? "active" : "needed",
      };
    }

    if (isStaleTerminalMigration(migrationState)) {
      const queuedState = await enqueueWorkspaceMigration(env, workspaceId);
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
  workspaceId: string,
): Promise<LegacyWorkspaceMigrationState | null> {
  try {
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    return await workspace.ensureLegacyWorkspaceMigrationQueued();
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

function isStaleTerminalMigration(state: LegacyWorkspaceMigrationState): boolean {
  return (
    (state.status === "complete" || state.status === "failed" || state.status === "dry_run_complete") &&
    state.migrationVersion < CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION
  );
}
