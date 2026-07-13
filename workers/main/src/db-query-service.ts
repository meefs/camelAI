/**
 * Worker-side orchestration for DbQuerySandbox — the static-IP database query
 * path (docs/db-egress-relay.md).
 *
 * The query logic is NOT baked into the container image. It lives in
 * `db-query-sandbox-assets/runner/db-query-runner.mjs`, is embedded into this
 * worker as a string (below), and is run in the container per call by piping
 * that string into `node` over stdin in a single stateless `exec` (no file is
 * written). Changing how we query is therefore a worker-only change — no image
 * rebuild. The image only carries the runtime (node), the drivers
 * (pg/mysql2/socks at /opt/db-query-runner/node_modules), and cloudflared.
 *
 * Callers are responsible for AUTHORIZATION: by the time runDbQuery is
 * invoked, the caller must already have decided this principal may query this
 * database. Callers: the legacy data-proxy compat surface (data-proxy.ts —
 * connection MCP, the DATA_PROXY user-app binding, sandbox container routes)
 * and the admin smoke route (POST /api/admin/db-query-sandbox/query).
 */

// Embedded at build time; the Vite and Wrangler builds alias this virtual
// module to the runner source using their respective raw-text mechanisms.
import RUNNER_SOURCE from "virtual:db-query-runner-source";

/**
 * Directory holding the baked drivers. `node` runs with this as its cwd so the
 * runner's bare `import "pg"` (fed over stdin) resolves against the baked
 * node_modules by normal ESM directory walking — NODE_PATH is not consulted
 * for ESM, and stdin modules resolve bare specifiers relative to cwd.
 */
export const DB_QUERY_RUNNER_DIR = "/opt/db-query-runner";

/** Local port the container's `cloudflared access tcp` forwarder listens on. */
export const DB_RELAY_LOCAL_PORT = 11080;

/** cloudflared forwarder command + stable process id (started once, reused). */
export const DB_RELAY_FORWARDER_PROCESS_ID = "cf-access-tcp";

/** Relay coordinates + credentials, from worker env (never baked in images). */
export interface DbEgressRelayConfig {
  hostname: string;
  socksUsername: string;
  socksPassword: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface DbEgressRelayEnv {
  DB_EGRESS_RELAY_HOSTNAME?: string;
  DB_EGRESS_RELAY_SOCKS_USERNAME?: string;
  DB_EGRESS_RELAY_SOCKS_PASSWORD?: string;
  DB_EGRESS_RELAY_ACCESS_CLIENT_ID?: string;
  DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET?: string;
}

/**
 * Relay config for this environment, or null for direct mode.
 *
 * Only a FULLY-unset relay is direct mode. A PARTIAL config (e.g. hostname set
 * but a SOCKS secret missing after a typo/rollout slip) throws instead of
 * silently degrading: `DbQuerySandbox` keys `enableInternet` off the hostname
 * alone, so a partial config would leave egress locked to relay posture while
 * `runDbQuery` skipped the forwarder — every query would then fail as an opaque
 * network error instead of an obvious config error.
 */
export function relayConfigFromEnv(env: DbEgressRelayEnv): DbEgressRelayConfig | null {
  const hostname = env.DB_EGRESS_RELAY_HOSTNAME?.trim();
  const socksUsername = env.DB_EGRESS_RELAY_SOCKS_USERNAME;
  const socksPassword = env.DB_EGRESS_RELAY_SOCKS_PASSWORD;

  if (!hostname) {
    if (socksUsername || socksPassword) {
      throw Object.assign(
        new Error(
          "DB egress relay SOCKS credentials are set but DB_EGRESS_RELAY_HOSTNAME is missing (partial relay config)",
        ),
        { status: 500 },
      );
    }
    return null; // fully unset → direct mode
  }
  if (!socksUsername || !socksPassword) {
    throw Object.assign(
      new Error(
        "DB_EGRESS_RELAY_HOSTNAME is set but DB_EGRESS_RELAY_SOCKS_USERNAME/PASSWORD are missing (partial relay config)",
      ),
      { status: 500 },
    );
  }
  // The Access service token is a pair: both or neither. Exactly one set (a
  // typo/rollout slip) would otherwise start `cloudflared access tcp` WITHOUT
  // the token, and the Access-gated hostname would reject every connection —
  // surfacing only as a forwarder-readiness timeout, not a config error.
  const accessClientId = env.DB_EGRESS_RELAY_ACCESS_CLIENT_ID?.trim() || undefined;
  const accessClientSecret = env.DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET?.trim() || undefined;
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw Object.assign(
      new Error(
        "DB_EGRESS_RELAY_ACCESS_CLIENT_ID and DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET must be set together (partial relay config)",
      ),
      { status: 500 },
    );
  }
  return { hostname, socksUsername, socksPassword, accessClientId, accessClientSecret };
}

export interface DbQueryTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  /** May be empty ONLY for mysql (Go data-proxy parity). */
  database: string;
  /**
   * default "require"; "verify-full" enables CA + hostname verification,
   * "verify-ca" chain-only, "prefer" (mysql) tries TLS then falls back to
   * plaintext when the server lacks it.
   */
  sslMode?: "disable" | "require" | "verify-ca" | "verify-full" | "prefer";
  /** mysql only; identifier, e.g. "utf8mb4" (the driver default). */
  charset?: string;
}

export interface DbQueryRequest {
  /** "query" (default): point query over exec; "export": streaming Parquet extract. */
  op?: "query" | "export";
  engine: "postgres" | "mysql" | "mssql";
  /** "read" (default) runs in a rolled-back transaction; "modify" returns rowsAffected. */
  mode?: "read" | "modify";
  target: DbQueryTarget;
  sql: string;
  /** Positional array for postgres/mysql; named record for mssql. */
  params?: unknown[] | Record<string, unknown>;
  /** null = uncapped rows (the byte cap still bounds the response). */
  rowLimit?: number | null;
  timeoutMs?: number;
  /** Serialized-result size cap for op "query" (default 8 MiB in the runner). */
  maxResponseBytes?: number;
}

export type DbQueryResult =
  | {
      ok: true;
      rows: Record<string, unknown>[];
      fields: { name: string }[];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
      /** Present for mode "modify". */
      rowsAffected?: number[];
    }
  | { ok: false; error: { message: string; code?: string; number?: number; status?: number } };

interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The slice of the DbQuerySandbox stub this module uses (test seam). */
export interface DbQuerySandboxStub {
  ensureRelayEgress(relayHostname: string): Promise<void>;
  ensureWarehouseExportMount(prefix: string): Promise<void>;
  startProcess(
    command: string,
    options?: { processId?: string; env?: Record<string, string | undefined> },
  ): Promise<unknown>;
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
  ): Promise<SandboxExecResult>;
}

export interface DbQueryDeps {
  sandbox: DbQuerySandboxStub;
  /**
   * Static-IP egress relay, or null to dial the database DIRECTLY from the
   * container's own Cloudflare IP (the opt-out when no relay is configured).
   */
  relay: DbEgressRelayConfig | null;
  /** Max ms to wait for the cloudflared forwarder to come up (default 30s). */
  readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 500;
/** Extra wall-clock beyond the query timeout for node start + driver import + connect. */
const EXEC_OVERHEAD_MS = 15_000;

/** Probe whether the cloudflared forwarder's local port is accepting yet. */
async function forwarderReady(deps: DbQueryDeps): Promise<boolean> {
  const probe = await deps.sandbox.exec(
    `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${DB_RELAY_LOCAL_PORT}' 2>/dev/null && echo up || echo down`,
    { timeout: 5_000 },
  );
  return probe.stdout.trim() === "up";
}

/**
 * Make sure the container's `cloudflared access tcp` forwarder is running and
 * its local port is accepting. Idempotent: startProcess uses a stable id, so a
 * second attempt on a warm container is a no-op collision we swallow. Relay
 * credentials travel via process env — never image contents.
 */
async function ensureRelayForwarder(deps: DbQueryDeps, relay: DbEgressRelayConfig): Promise<void> {
  const deadline = Date.now() + (deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  if (await forwarderReady(deps)) return;

  try {
    await deps.sandbox.startProcess(
      `cloudflared access tcp --hostname ${relay.hostname} --url 127.0.0.1:${DB_RELAY_LOCAL_PORT}` +
        (relay.accessClientId && relay.accessClientSecret
          ? ` --service-token-id ${relay.accessClientId} --service-token-secret ${relay.accessClientSecret}`
          : ""),
      { processId: DB_RELAY_FORWARDER_PROCESS_ID },
    );
  } catch {
    // A concurrent caller likely started it first (stable processId → name
    // collision, not a second forwarder). Readiness polling below is the real
    // gate.
  }

  while (!(await forwarderReady(deps))) {
    if (Date.now() >= deadline) {
      throw new Error(
        "db-query relay forwarder never became ready (check the relay hostname, Access service token, and that the egress allowlist admits the relay host)",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
  }
}

function parseRunnerOutput(exec: SandboxExecResult): DbQueryResult {
  const text = exec.stdout.trim();
  if (!text) {
    return {
      ok: false,
      error: {
        message: `runner produced no output (exit ${exec.exitCode})${exec.stderr ? `: ${exec.stderr.trim().slice(0, 500)}` : ""}`,
        status: 502,
      },
    };
  }
  let parsed: DbQueryResult & { error?: { message?: string; code?: string; number?: number; status?: number } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `runner returned non-JSON output: ${text.slice(0, 500)}`, status: 502 } };
  }
  if (parsed.ok === true) return parsed;
  return {
    ok: false,
    error: {
      message: parsed.error?.message ?? `query failed (exit ${exec.exitCode})`,
      code: parsed.error?.code,
      number: parsed.error?.number,
      status: parsed.error?.status,
    },
  };
}

/**
 * Run one worker-authorized query. With `deps.relay` set, it tunnels through
 * the static-IP egress relay; with `deps.relay` null it dials the database
 * directly from the container's own IP (no SOCKS, no forwarder).
 *
 * The runner is shipped and run in a SINGLE stateless `exec`: the source rides
 * in the `DB_RUNNER_SRC` env var and is piped into `node` over stdin. Nothing
 * is written to the container filesystem — no per-call file, no cleanup, no
 * "did we already write it" state. `cwd` is the drivers dir so the runner's
 * bare `import "pg"` resolves against the baked node_modules.
 */
export async function runDbQuery(deps: DbQueryDeps, request: DbQueryRequest): Promise<DbQueryResult> {
  if (deps.relay) {
    await deps.sandbox.ensureRelayEgress(deps.relay.hostname);
    await ensureRelayForwarder(deps, deps.relay);
  }

  const exec = await deps.sandbox.exec(
    `bash -c 'printf %s "$DB_RUNNER_SRC" | node --input-type=module'`,
    {
      cwd: DB_QUERY_RUNNER_DIR,
      timeout: (request.timeoutMs ?? 30_000) + EXEC_OVERHEAD_MS,
      env: runnerEnv(deps, request),
    },
  );
  return parseRunnerOutput(exec);
}

/** Env for a runner invocation: source + request + optional relay creds. */
function runnerEnv(deps: DbQueryDeps, request: DbQueryRequest): Record<string, string | undefined> {
  return {
    DB_RUNNER_SRC: RUNNER_SOURCE,
    DB_QUERY_REQUEST: JSON.stringify(request),
    // SOCKS creds present ⇒ runner uses the relay; absent ⇒ direct dial.
    ...(deps.relay
      ? {
          DB_RELAY_LOCAL_PORT: String(DB_RELAY_LOCAL_PORT),
          DB_EGRESS_RELAY_SOCKS_USERNAME: deps.relay.socksUsername,
          DB_EGRESS_RELAY_SOCKS_PASSWORD: deps.relay.socksPassword,
        }
      : {}),
  };
}

/**
 * Extra wall-clock beyond the export timeout: node start + driver import +
 * connect, PLUS the Parquet footer write and the s3fs flush of the staged
 * file to R2 (which runs after the database deadline — see the runner).
 */
const EXPORT_EXEC_OVERHEAD_MS = 90_000;

export type DbExportResult =
  | { ok: true; rowCount: number; bytes: number; durationMs: number }
  | { ok: false; error: { message: string; code?: string; number?: number; status?: number } };

/**
 * Run one worker-authorized bulk export: the runner streams the read-only
 * result set as a Snappy Parquet file written DIRECTLY into the workspace's
 * mounted warehouse R2 prefix (credential-less bucket mount) — nothing
 * streams through the Worker. Same single stateless exec as runDbQuery, plus
 * the mount ensure. `exportPath` must be `'/' + r2Key` (inside the mounted
 * prefix); `mountPrefix` is the workspace's warehouse prefix. On failure the
 * runner unlinks the partial file — callers should still HEAD-verify the
 * object (warehouse-export parity).
 */
export async function runDbExport(
  deps: DbQueryDeps,
  request: DbQueryRequest,
  mountPrefix: string,
  exportPath: string,
): Promise<DbExportResult> {
  if (deps.relay) {
    await deps.sandbox.ensureRelayEgress(deps.relay.hostname);
    await ensureRelayForwarder(deps, deps.relay);
  }
  await deps.sandbox.ensureWarehouseExportMount(mountPrefix);

  const exportRequest: DbQueryRequest = { ...request, op: "export" };
  const exec = await deps.sandbox.exec(
    `bash -c 'printf %s "$DB_RUNNER_SRC" | node --input-type=module'`,
    {
      cwd: DB_QUERY_RUNNER_DIR,
      timeout: (request.timeoutMs ?? 120_000) + EXPORT_EXEC_OVERHEAD_MS,
      env: {
        ...runnerEnv(deps, exportRequest),
        DB_EXPORT_PATH: exportPath,
      },
    },
  );
  const parsed = parseRunnerOutput(exec) as unknown as DbExportResult;
  if (parsed.ok && (typeof parsed.rowCount !== "number" || typeof parsed.bytes !== "number")) {
    return { ok: false, error: { message: "export runner returned a malformed result", status: 502 } };
  }
  return parsed;
}
