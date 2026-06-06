import { CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION } from "../../../src/lib/legacy-workspace-migration-version";
import {
  WorkspaceFilesystemClient,
  type LegacyWorkspaceMigrationState,
} from "./workspace-filesystem-do";
import type { Env } from "./types";

export interface QueueLegacyWorkspaceMigrationInput {
  env: Env;
  orgId: string;
  workspaceId: string;
  requestedBy: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface QueueLegacyWorkspaceMigrationResult {
  state: LegacyWorkspaceMigrationState;
  queued: boolean;
  workflowId?: string;
}

export async function queueLegacyWorkspaceMigrationIfNeeded(
  input: QueueLegacyWorkspaceMigrationInput,
): Promise<QueueLegacyWorkspaceMigrationResult> {
  const { env, orgId, workspaceId } = input;
  if (!env.WORKSPACE_FS || !env.LEGACY_WORKSPACE_MIGRATIONS) {
    throw new Error("Legacy workspace migration is not configured");
  }

  const workspaceFs = new WorkspaceFilesystemClient(env as never, workspaceId);
  const workflowId = legacyWorkspaceMigrationWorkflowId(workspaceId, { force: input.force === true });
  const current = await workspaceFs.getLegacyWorkspaceMigrationState();

  try {
    const instances = await env.LEGACY_WORKSPACE_MIGRATIONS.createBatch([{
      id: workflowId,
      params: {
        workspaceId,
        orgId,
        requestedBy: input.requestedBy,
        dryRun: input.dryRun === true,
        force: input.force === true,
      },
    }]);
    const created = instances.length > 0;
    const alreadyCurrent = isCurrentCompletedMigration(current);
    const state: LegacyWorkspaceMigrationState = created || !alreadyCurrent
      ? {
          ...current,
          status: "queued",
          orgId,
          workflowId,
          updatedAt: new Date().toISOString(),
        }
      : current;
    return { state, queued: created || !alreadyCurrent, workflowId };
  } catch (error) {
    await workspaceFs.setLegacyWorkspaceMigrationState({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

function legacyWorkspaceMigrationWorkflowId(workspaceId: string, options: { force: boolean }): string {
  const base = `legacy-migration-v${CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION}-${workspaceId}`;
  return options.force ? `${base}-force-${Date.now().toString(36)}` : base;
}

function isCurrentCompletedMigration(state: LegacyWorkspaceMigrationState): boolean {
  return state.status === "complete" &&
    state.migrationVersion >= CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION;
}
