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

export interface CancelLegacyWorkspaceMigrationInput {
  env: Env;
  workspaceId: string;
  requestedBy: string;
}

export interface CancelLegacyWorkspaceMigrationResult {
  state: LegacyWorkspaceMigrationState;
  canceled: boolean;
  workflowId?: string;
}

const ACTIVE_MIGRATION_STATUSES = new Set<LegacyWorkspaceMigrationState["status"]>([
  "queued",
  "scanning_legacy",
  "planning",
  "copying",
  "verifying",
] satisfies LegacyWorkspaceMigrationState["status"][]);

const ACTIVE_WORKFLOW_INSTANCE_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
  "unknown",
]);

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
    if (input.force === true) {
      await cancelActiveLegacyWorkspaceMigration({
        env,
        workspaceId,
        state: current,
        requestedBy: input.requestedBy,
        persistCanceledState: false,
      });
    }

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

export async function cancelLegacyWorkspaceMigration(
  input: CancelLegacyWorkspaceMigrationInput,
): Promise<CancelLegacyWorkspaceMigrationResult> {
  const { env, workspaceId } = input;
  if (!env.WORKSPACE_FS || !env.LEGACY_WORKSPACE_MIGRATIONS) {
    throw new Error("Legacy workspace migration is not configured");
  }

  const workspaceFs = new WorkspaceFilesystemClient(env as never, workspaceId);
  const current = await workspaceFs.getLegacyWorkspaceMigrationState();
  const canceled = await cancelActiveLegacyWorkspaceMigration({
    env,
    workspaceId,
    state: current,
    requestedBy: input.requestedBy,
    persistCanceledState: true,
  });
  const state = canceled
    ? await workspaceFs.getLegacyWorkspaceMigrationState()
    : current;
  return { state, canceled, workflowId: current.workflowId };
}

function legacyWorkspaceMigrationWorkflowId(workspaceId: string, options: { force: boolean }): string {
  const base = `legacy-migration-v${CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION}-${workspaceId}`;
  return options.force ? `${base}-force-${Date.now().toString(36)}` : base;
}

function isCurrentCompletedMigration(state: LegacyWorkspaceMigrationState): boolean {
  return state.status === "complete" &&
    state.migrationVersion >= CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION;
}

async function cancelActiveLegacyWorkspaceMigration(input: {
  env: Env;
  workspaceId: string;
  state: LegacyWorkspaceMigrationState;
  requestedBy: string;
  persistCanceledState: boolean;
}): Promise<boolean> {
  const { env, workspaceId, state } = input;
  if (!ACTIVE_MIGRATION_STATUSES.has(state.status)) return false;

  const workflowId = state.workflowId;
  let terminated = false;
  if (workflowId) {
    terminated = await terminateWorkflowIfActive(env, workflowId);
  }

  if (state.orgId && state.leaseId) {
    await unlockLegacyWorkspaceBestEffort(env, state.orgId, workspaceId, state.leaseId);
  }

  if (input.persistCanceledState) {
    const workspaceFs = new WorkspaceFilesystemClient(env as never, workspaceId);
    await workspaceFs.setLegacyWorkspaceMigrationState({
      status: "canceled",
      workflowId,
      error: `Migration canceled by ${input.requestedBy}`,
      leaseId: undefined,
      completedAt: new Date().toISOString(),
    });
  }

  return terminated || Boolean(workflowId) || Boolean(state.leaseId);
}

async function terminateWorkflowIfActive(env: Env, workflowId: string): Promise<boolean> {
  if (!env.LEGACY_WORKSPACE_MIGRATIONS) return false;
  try {
    const instance = await env.LEGACY_WORKSPACE_MIGRATIONS.get(workflowId);
    const status = await instance.status();
    if (!ACTIVE_WORKFLOW_INSTANCE_STATUSES.has(status.status)) return false;
    await instance.terminate();
    return true;
  } catch (error) {
    console.warn("Failed to terminate legacy workspace migration workflow", {
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function unlockLegacyWorkspaceBestEffort(
  env: Env,
  orgId: string,
  workspaceId: string,
  leaseId: string,
): Promise<void> {
  try {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}/migration-lock`,
      "http://project-runtime.local",
    );
    const init: RequestInit = withRuntimeAuth(env, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId }),
    });
    const response = env.PROJECT_RUNTIME_HOST
      ? await env.PROJECT_RUNTIME_HOST.fetch(new Request(url.toString(), init))
      : await fetchRuntimeService(env, url, init);
    if (!response.ok && response.status !== 404) {
      console.warn("Failed to unlock legacy workspace migration lease", {
        workspaceId,
        leaseId,
        status: response.status,
        body: await response.text(),
      });
    }
  } catch (error) {
    console.warn("Failed to unlock legacy workspace migration lease", {
      workspaceId,
      leaseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function fetchRuntimeService(env: Env, url: URL, init: RequestInit): Promise<Response> {
  const base = env.PROJECT_RUNTIME_SERVICE_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("PROJECT_RUNTIME_HOST or PROJECT_RUNTIME_SERVICE_URL is required");
  return fetch(`${base}${url.pathname}${url.search}`, init);
}

function withRuntimeAuth(env: Env, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (env.PROJECT_RUNTIME_SERVICE_BEARER_TOKEN && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${env.PROJECT_RUNTIME_SERVICE_BEARER_TOKEN}`);
  }
  return { ...init, headers };
}
