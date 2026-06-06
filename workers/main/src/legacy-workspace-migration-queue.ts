import { CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION } from "../../../src/lib/legacy-workspace-migration-version";
import {
  WorkspaceFilesystemClient,
  type LegacyWorkspaceMigrationState,
  type LegacyWorkspaceMigrationStatus,
} from "./workspace-filesystem-do";
import { startLegacyWorkspaceMigrationWorkflow } from "./legacy-workspace-migration-workflow";
import type { Env } from "./types";

const ACTIVE_LEGACY_MIGRATION_STATUSES = new Set<LegacyWorkspaceMigrationStatus>([
  "queued",
  "scanning_legacy",
  "planning",
  "copying",
  "verifying",
]);

const ACTIVE_WORKFLOW_INSTANCE_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);
const ACTIVE_MIGRATION_REQUEUE_GRACE_MS = 5 * 60 * 1000;

export class LegacyWorkspaceMigrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyWorkspaceMigrationConflictError";
  }
}

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
  if (!env.WORKSPACE_FS || !env.LEGACY_WORKSPACE_MIGRATIONS || !env.MIGRATION_PLANNING_AGENT) {
    throw new Error("Legacy workspace migration is not configured");
  }

  const workspaceFs = new WorkspaceFilesystemClient(env as never, workspaceId);
  const state = await workspaceFs.getLegacyWorkspaceMigrationState();

  if (state.workflowId) {
    const activeWorkflow = await getActiveMigrationWorkflowStatus(env, state.workflowId);
    if (activeWorkflow) {
      if (!input.force) {
        return { state, queued: false, workflowId: state.workflowId };
      }
      throw new LegacyWorkspaceMigrationConflictError(
        `Migration workflow ${state.workflowId} is still ${activeWorkflow}`,
      );
    }
  }

  if (ACTIVE_LEGACY_MIGRATION_STATUSES.has(state.status)) {
    if (!input.force && migrationStateWasRecentlyUpdated(state)) {
      return { state, queued: false, workflowId: state.workflowId };
    }
    if (state.workflowId) {
      const instance = await env.LEGACY_WORKSPACE_MIGRATIONS.get(state.workflowId);
      const workflowStatus = await instance.status();
      if (ACTIVE_WORKFLOW_INSTANCE_STATUSES.has(workflowStatus.status)) {
        if (!input.force) {
          return { state, queued: false, workflowId: state.workflowId };
        }
        throw new LegacyWorkspaceMigrationConflictError(
          `Migration is already ${state.status} and workflow ${state.workflowId} is ${workflowStatus.status}`,
        );
      }
    } else if (!input.force) {
      return { state, queued: false, workflowId: state.workflowId };
    }
  } else if (!input.force && isCurrentCompletedMigration(state)) {
    return { state, queued: false, workflowId: state.workflowId };
  }

  const attempt = state.attempts + 1;
  const suffix = input.force ? `-${Date.now().toString(36)}` : "";
  const workflowId = `legacy-migration-${workspaceId}-${attempt}${suffix}`;
  const queuedState = await workspaceFs.setLegacyWorkspaceMigrationState({
    status: "queued",
    orgId,
    workflowId,
  });

  try {
    await startLegacyWorkspaceMigrationWorkflow(env, {
      workflowId,
      workspaceId,
      orgId,
      requestedBy: input.requestedBy,
      dryRun: input.dryRun === true,
    });
  } catch (error) {
    await workspaceFs.setLegacyWorkspaceMigrationState({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    throw error;
  }

  return { state: queuedState, queued: true, workflowId };
}

function isCurrentCompletedMigration(state: LegacyWorkspaceMigrationState): boolean {
  return state.status === "complete" &&
    state.migrationVersion >= CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION;
}

function migrationStateWasRecentlyUpdated(state: LegacyWorkspaceMigrationState): boolean {
  const updatedAt = Date.parse(state.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < ACTIVE_MIGRATION_REQUEUE_GRACE_MS;
}

async function getActiveMigrationWorkflowStatus(env: Env, workflowId: string): Promise<string | null> {
  if (!env.LEGACY_WORKSPACE_MIGRATIONS) return null;
  try {
    const instance = await env.LEGACY_WORKSPACE_MIGRATIONS.get(workflowId);
    const workflowStatus = await instance.status();
    return ACTIVE_WORKFLOW_INSTANCE_STATUSES.has(workflowStatus.status) ? workflowStatus.status : null;
  } catch {
    return null;
  }
}
