/**
 * Eval deploy context: the only eval-specific state the deploy path needs.
 *
 * Agent evals run their sandbox container inside Miniflare, so the container's
 * Cloudflare API traffic is intercepted in-process (see eval-sandbox.ts) instead of
 * reaching a deployed Worker. To forward those calls through the real cf-api-proxy we
 * need to know which org/workspace each container belongs to; this table provides that
 * container -> identity mapping. Everything else about a deploy (registration, URLs,
 * list_apps) flows through the normal OrgDO path, so production code stays eval-agnostic.
 */

export const EVAL_DEPLOY_CONTEXTS_TABLE = "eval_deploy_contexts";

export interface EvalDeployContext {
  containerId: string;
  orgId: string;
  workspaceId: string;
  userId: string;
  threadId: string | null;
  projectId: string | null;
  updatedAt: number;
}

/**
 * Real deploys are the default for agent eval runs and opt-out: within an agent eval
 * (`RUN_AGENT_EVALS=1`) an eval deploys for real to the testing-grounds namespace
 * whenever a Cloudflare API token is available, unless explicitly disabled with
 * `EVAL_REAL_DEPLOY=0` (or "false"). It stays inert when there is no token to deploy
 * with, and outside agent eval runs entirely — so other Sandbox-backed harnesses (e.g.
 * `RUN_SANDBOX_EVAL_PROTOTYPE`) are never forced through the real-deploy path.
 */
export function isRealEvalDeployEnabled(env: {
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
}): boolean {
  if (env.RUN_AGENT_EVALS !== "1") return false;
  const flag = env.EVAL_REAL_DEPLOY?.trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  return Boolean(env.CF_API_TOKEN?.trim());
}

export async function ensureEvalDeployContextTable(db?: D1Database): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${EVAL_DEPLOY_CONTEXTS_TABLE} (
        container_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        thread_id TEXT,
        project_id TEXT,
        updated_at INTEGER NOT NULL
      )`,
    )
    .run();
}

export async function upsertEvalDeployContext(
  db: D1Database | undefined,
  context: Omit<EvalDeployContext, "updatedAt">,
): Promise<void> {
  if (!db || !context.orgId || !context.workspaceId || !context.userId) return;
  await ensureEvalDeployContextTable(db);
  await db
    .prepare(
      `INSERT INTO ${EVAL_DEPLOY_CONTEXTS_TABLE}
       (container_id, org_id, workspace_id, user_id, thread_id, project_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(container_id) DO UPDATE SET
         org_id = excluded.org_id,
         workspace_id = excluded.workspace_id,
         user_id = excluded.user_id,
         thread_id = excluded.thread_id,
         project_id = excluded.project_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      context.containerId,
      context.orgId,
      context.workspaceId,
      context.userId,
      context.threadId,
      context.projectId,
      Date.now(),
    )
    .run();
}

export async function getEvalDeployContext(
  db: D1Database | undefined,
  containerId: string,
): Promise<EvalDeployContext | null> {
  if (!db) return null;
  await ensureEvalDeployContextTable(db);
  const row = await db
    .prepare(
      `SELECT container_id, org_id, workspace_id, user_id, thread_id, project_id, updated_at
       FROM ${EVAL_DEPLOY_CONTEXTS_TABLE}
       WHERE container_id = ?`,
    )
    .bind(containerId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    containerId: String(row.container_id),
    orgId: String(row.org_id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    threadId: typeof row.thread_id === "string" ? row.thread_id : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    updatedAt: Number(row.updated_at),
  };
}

export async function cloneEvalDeployContext(
  db: D1Database | undefined,
  sourceContainerId: string,
  targetContainerId: string,
): Promise<void> {
  if (!db || sourceContainerId === targetContainerId) return;
  const context = await getEvalDeployContext(db, sourceContainerId);
  if (!context) return;
  await upsertEvalDeployContext(db, {
    containerId: targetContainerId,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    userId: context.userId,
    threadId: context.threadId,
    projectId: targetContainerId,
  });
}
