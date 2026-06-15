import type { WorkerScript } from "./auth.js";

export const EVAL_DEPLOY_REQUESTS_TABLE = "eval_deploy_requests";
export const EVAL_DEPLOY_CONTEXTS_TABLE = "eval_deploy_contexts";
export const EVAL_DEPLOY_APPS_TABLE = "eval_deploy_apps";

export interface EvalDeployContext {
  containerId: string;
  orgId: string;
  workspaceId: string;
  userId: string;
  threadId: string | null;
  projectId: string | null;
  updatedAt: number;
}

export interface EvalDeployRequestLog {
  id?: number;
  container_id?: string;
  ts: number;
  method: string;
  path: string;
  query: string;
  content_type: string | null;
  content_length: string | null;
}

export interface EvalDeployApp extends WorkerScript {
  org_id: string;
  container_id: string;
  account_id: string;
  dispatch_namespace: string;
  dispatch_script_name: string;
  deploy_request_count: number;
  latest_upload_content_length: string | null;
  vanity_url: string;
  iframe_url: string;
  eval: true;
}

export interface EvalDeployRecordInput {
  containerId: string;
  accountId: string;
  dispatchNamespace: string;
  scriptName: string;
  query: string;
  contentType: string | null;
  contentLength: string | null;
}

export function isEvalDeployEnabled(env: { RUN_AGENT_EVALS?: string; APP_DB?: D1Database }): boolean {
  return env.RUN_AGENT_EVALS === "1" && Boolean(env.APP_DB);
}

export async function ensureEvalDeployRegistry(db?: D1Database): Promise<void> {
  if (!db) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${EVAL_DEPLOY_CONTEXTS_TABLE} (
        container_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        thread_id TEXT,
        project_id TEXT,
        updated_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${EVAL_DEPLOY_REQUESTS_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        container_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT NOT NULL,
        content_type TEXT,
        content_length TEXT
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${EVAL_DEPLOY_APPS_TABLE} (
        script_name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        container_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_public INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        dispatch_namespace TEXT NOT NULL,
        dispatch_script_name TEXT NOT NULL,
        deploy_request_count INTEGER NOT NULL,
        latest_upload_content_length TEXT,
        vanity_url TEXT NOT NULL,
        iframe_url TEXT NOT NULL,
        config_path TEXT,
        project_id TEXT,
        PRIMARY KEY (org_id, script_name)
      )`,
    ),
  ]);
}

export async function upsertEvalDeployContext(
  db: D1Database | undefined,
  context: Omit<EvalDeployContext, "updatedAt">,
): Promise<void> {
  if (!db || !context.orgId || !context.workspaceId || !context.userId) return;
  await ensureEvalDeployRegistry(db);
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
  await ensureEvalDeployRegistry(db);
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

export async function logEvalDeployRequest(
  db: D1Database | undefined,
  containerId: string,
  request: Request,
  url: URL,
): Promise<void> {
  if (!db) return;
  await ensureEvalDeployRegistry(db);
  await db
    .prepare(
      `INSERT INTO ${EVAL_DEPLOY_REQUESTS_TABLE}
       (container_id, ts, method, path, query, content_type, content_length)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      containerId,
      Date.now(),
      request.method,
      url.pathname,
      url.search.slice(1),
      request.headers.get("content-type"),
      request.headers.get("content-length"),
    )
    .run();
}

export async function listEvalDeployRequests(
  db: D1Database | undefined,
  containerId: string,
): Promise<EvalDeployRequestLog[]> {
  if (!db) return [];
  await ensureEvalDeployRegistry(db);
  const rows = await db
    .prepare(
      `SELECT id, container_id, ts, method, path, query, content_type, content_length
       FROM ${EVAL_DEPLOY_REQUESTS_TABLE}
       WHERE container_id = ?
       ORDER BY id ASC`,
    )
    .bind(containerId)
    .all<Record<string, unknown>>();

  return rows.results.map((row) => ({
    id: Number(row.id),
    container_id: String(row.container_id),
    ts: Number(row.ts),
    method: String(row.method),
    path: String(row.path),
    query: String(row.query ?? ""),
    content_type: typeof row.content_type === "string" ? row.content_type : null,
    content_length: typeof row.content_length === "string" ? row.content_length : null,
  }));
}

export async function recordEvalDeployApp(
  db: D1Database | undefined,
  input: EvalDeployRecordInput,
): Promise<EvalDeployApp | null> {
  if (!db) return null;
  await ensureEvalDeployRegistry(db);
  const context = await getEvalDeployContext(db, input.containerId);
  if (!context) return null;

  const now = Date.now();
  const existing = await getEvalDeployApp(db, context.workspaceId, input.scriptName);
  const createdAt = existing?.created_at ?? now;
  const requestCount = await countEvalDeployRequests(db, input.containerId);
  const vanityUrl = `https://${input.scriptName}.eval.camelai.app`;
  const iframeUrl = `https://${input.scriptName}.apps.eval.camelai.dev`;

  await db
    .prepare(
      `INSERT INTO ${EVAL_DEPLOY_APPS_TABLE}
       (script_name, workspace_id, org_id, container_id, created_by, created_at, updated_at,
        is_public, account_id, dispatch_namespace, dispatch_script_name, deploy_request_count,
        latest_upload_content_length, vanity_url, iframe_url, config_path, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, script_name) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         container_id = excluded.container_id,
         updated_at = excluded.updated_at,
         account_id = excluded.account_id,
         dispatch_namespace = excluded.dispatch_namespace,
         dispatch_script_name = excluded.dispatch_script_name,
         deploy_request_count = excluded.deploy_request_count,
         latest_upload_content_length = excluded.latest_upload_content_length,
         vanity_url = excluded.vanity_url,
         iframe_url = excluded.iframe_url,
         config_path = excluded.config_path,
         project_id = excluded.project_id`,
    )
    .bind(
      input.scriptName,
      context.workspaceId,
      context.orgId,
      input.containerId,
      context.userId,
      createdAt,
      now,
      input.accountId,
      input.dispatchNamespace,
      input.scriptName,
      requestCount,
      input.contentLength,
      vanityUrl,
      iframeUrl,
      null,
      context.projectId,
    )
    .run();

  return getEvalDeployApp(db, context.workspaceId, input.scriptName);
}

async function countEvalDeployRequests(
  db: D1Database,
  containerId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${EVAL_DEPLOY_REQUESTS_TABLE}
       WHERE container_id = ?`,
    )
    .bind(containerId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function toEvalDeployApp(row: Record<string, unknown>): EvalDeployApp {
  const createdAt = Number(row.created_at);
  const updatedAt = Number(row.updated_at);
  return {
    script_name: String(row.script_name),
    workspace_id: String(row.workspace_id),
    org_id: String(row.org_id),
    container_id: String(row.container_id),
    created_by: String(row.created_by),
    created_at: createdAt,
    updated_at: updatedAt,
    is_public: Number(row.is_public) === 1,
    account_id: String(row.account_id),
    dispatch_namespace: String(row.dispatch_namespace),
    dispatch_script_name: String(row.dispatch_script_name),
    deploy_request_count: Number(row.deploy_request_count),
    latest_upload_content_length:
      typeof row.latest_upload_content_length === "string"
        ? row.latest_upload_content_length
        : null,
    vanity_url: String(row.vanity_url),
    iframe_url: String(row.iframe_url),
    preview_key: null,
    preview_updated_at: updatedAt,
    preview_status: "ready",
    preview_error: null,
    config_path: typeof row.config_path === "string" ? row.config_path : null,
    project_id: typeof row.project_id === "string" ? row.project_id : null,
    custom_domain_hostname: null,
    custom_domain_cf_hostname_id: null,
    custom_domain_status: null,
    custom_domain_ssl_status: null,
    custom_domain_error: null,
    custom_domain_updated_at: null,
    eval: true,
  };
}

export async function getEvalDeployApp(
  db: D1Database | undefined,
  workspaceId: string,
  scriptName: string,
): Promise<EvalDeployApp | null> {
  if (!db) return null;
  await ensureEvalDeployRegistry(db);
  const row = await db
    .prepare(
      `SELECT * FROM ${EVAL_DEPLOY_APPS_TABLE}
       WHERE workspace_id = ? AND script_name = ?`,
    )
    .bind(workspaceId, scriptName)
    .first<Record<string, unknown>>();
  return row ? toEvalDeployApp(row) : null;
}

export async function setEvalDeployAppPublic(
  db: D1Database | undefined,
  workspaceId: string,
  scriptName: string,
  isPublic: boolean,
): Promise<EvalDeployApp | null> {
  const existing = await getEvalDeployApp(db, workspaceId, scriptName);
  if (!db || !existing) return null;

  await db
    .prepare(
      `UPDATE ${EVAL_DEPLOY_APPS_TABLE}
       SET is_public = ?, updated_at = ?
       WHERE org_id = ? AND script_name = ?`,
    )
    .bind(isPublic ? 1 : 0, Date.now(), existing.org_id, scriptName)
    .run();

  return getEvalDeployApp(db, workspaceId, scriptName);
}

export async function listEvalDeployApps(
  db: D1Database | undefined,
  workspaceId: string,
): Promise<EvalDeployApp[]> {
  if (!db) return [];
  await ensureEvalDeployRegistry(db);
  const rows = await db
    .prepare(
      `SELECT * FROM ${EVAL_DEPLOY_APPS_TABLE}
       WHERE workspace_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(workspaceId)
    .all<Record<string, unknown>>();
  return rows.results.map(toEvalDeployApp);
}

export async function listEvalDeployAppsForContainer(
  db: D1Database | undefined,
  containerId: string,
): Promise<EvalDeployApp[]> {
  const context = await getEvalDeployContext(db, containerId);
  if (!context) return [];
  return listEvalDeployApps(db, context.workspaceId);
}
