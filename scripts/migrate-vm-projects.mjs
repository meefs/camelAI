#!/usr/bin/env node
/**
 * Fleet driver for the legacy-VM -> DO+R2 project migration, driven through the
 * admin MCP (`POST <base-url>/api/admin/mcp`) instead of the bearer-token admin
 * REST API. One self-contained script with three subcommands:
 *
 *   node scripts/migrate-vm-projects.mjs migrate --base-url https://staging.camelai.dev [options]
 *   node scripts/migrate-vm-projects.mjs verify  --base-url https://staging.camelai.dev [options]
 *   node scripts/migrate-vm-projects.mjs notice  --base-url https://staging.camelai.dev [options]
 *
 * Run with `--help` (or no subcommand) for the full flag reference.
 *
 * Everything here was learned the hard way running the migration against
 * staging; the notable, non-obvious constraints are called out inline so they
 * survive future edits:
 *
 *   - Auth is OAuth (mcporter credential) + a Cloudflare Access token. The MCP
 *     endpoint is stateless JSON-RPC: a bare `tools/call` works, no MCP
 *     initialize handshake needed.
 *   - Only Node/undici `fetch` reaches the endpoint. Python `requests`/`httpx`
 *     get bounced by Cloudflare bot protection, so this stays pure Node.
 *   - `migrate_vm_projects` MUST be called per-project. A whole-workspace call
 *     503s on large workspaces (too much work for one request).
 *   - `admin_js_exec` has a hard ~120s cap. A timeout comes back INSIDE the
 *     tool result as `{ error: ... }`, so any result that is not the expected
 *     shape is treated as a hard error, never as an empty/zero result.
 *
 * Nothing here is destructive to VM checkouts, and every subcommand is
 * resumable: re-running skips work server-side.
 *   - migrate: already-`do-r2` projects are skipped by the tool; `--force`
 *     re-copies.
 *   - verify: builds are read-only and idempotent.
 *   - notice: `appendCamelSystemNotice` dedupes on `sentAt`, so re-running with
 *     the same `--sent-at` is a no-op for threads already noticed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Tunables (all learned against staging; change deliberately).
// ---------------------------------------------------------------------------

/** Projects with <= this many files migrate in the wide pool; larger go serial. */
const SMALL_FILE_THRESHOLD = 500;
/** Default wide-pool concurrency for small projects. */
const DEFAULT_MIGRATE_CONCURRENCY = 8;
/** Default concurrency for large projects (serial by default). */
const DEFAULT_LARGE_CONCURRENCY = 1;
/** Default concurrency for build verification (builds are heavy). */
const DEFAULT_VERIFY_CONCURRENCY = 2;
/** Per migrate_vm_projects call timeout. */
const MIGRATE_TIMEOUT_MS = 600_000;
/** verify_project_build's own build budget. */
const VERIFY_BUILD_TIMEOUT_MS = 300_000;
/** HTTP timeout for the verify RPC (must comfortably exceed the build budget). */
const VERIFY_RPC_TIMEOUT_MS = 600_000;
/** admin_js_exec hard cap; requests that need more must be chunked. */
const JS_EXEC_TIMEOUT_MS = 120_000;
/** search_workspaces / listing calls. */
const LIST_TIMEOUT_MS = 60_000;
/** search_workspaces rejects limits > 100. */
const WORKSPACE_PAGE_LIMIT = 100;
/** Threads per admin_js_exec call in the notice sweep. */
const NOTICE_CHUNK = 100;
/**
 * Concurrent appendCamelSystemNotice calls inside one js_exec chunk. 200
 * sequential appends blow past the 120s cap, so we fan out 20-wide per chunk.
 */
const NOTICE_BATCH = 20;

/** Fallback notice text when --text-file is not supplied. */
const DEFAULT_NOTICE_TEXT = `Project migration notice: the projects in this workspace were migrated to camelAI's new durable project storage.

What changed for how you work:
- Project files: use the standard file tools with location: "project" and the project name.
- The legacy project VM is gone: bash, vm_exec, clone_project, and location: "vm" no longer work for these projects.
- Build and deploy only through the platform actions: build_project, deploy_project, add_dependency, and add_shadcn_component (available on the tools object in js_exec). Do not run package managers or wrangler in a shell.
- Source history: use list_commits and revert_project.
- Deployed apps and their URLs are unchanged and still live.`;

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

const USAGE = `migrate-vm-projects.mjs — admin-MCP driver for the VM -> DO+R2 project migration

Usage:
  node scripts/migrate-vm-projects.mjs <migrate|verify|notice> --base-url <url> [options]

Common options:
  --base-url <url>        Required. e.g. https://staging.camelai.dev
  --report <path>         Write a JSON report for the run (recommended).
  --concurrency <n>       Override the subcommand's primary pool width.
  --help, -h              Show this help.

migrate — copy legacy VM projects to DO+R2, per project, size-aware.
  --workspace <id>        Limit to a single workspace (default: all).
  --dry-run               Estimate only (per-project dry runs, no copy).
  --force                 Re-copy even already-migrated (do-r2) projects.
  --concurrency <n>       Wide pool for small (<=${SMALL_FILE_THRESHOLD} files) projects (default ${DEFAULT_MIGRATE_CONCURRENCY}).
  --large-concurrency <n> Pool for large projects (default ${DEFAULT_LARGE_CONCURRENCY}, i.e. serial).
  Flow: a per-project dry run first estimates files_copied, then small projects
  migrate wide and large projects migrate serially. Resumable: already-migrated
  projects are skipped server-side (use --force to re-copy).

verify — build-verify migrated package-build projects via verify_project_build.
  --migrate-report <path> Source targets from a prior migrate report (preferred:
                          picks status=migrated + classification=package-build).
  --workspace <id>        With no report, scan a single workspace instead of all.
  --concurrency <n>       Build concurrency (default ${DEFAULT_VERIFY_CONCURRENCY}).
  Without --migrate-report it scans workspaces and verifies every do-r2 project
  (classification is not in the listing, so it cannot pre-filter to package-build).

notice — inject a hidden camelAI system notice into a workspace's threads.
  --sent-at <ms>          Required. Idempotency key; reuse it to make re-runs
                          dedupe (threads already noticed at this sentAt skip).
  --text-file <path>      Notice body (default: built-in migration notice).
  --scope <all|migrated>  'migrated' targets only workspaces whose migrate report
                          shows >=1 migrated project (requires --migrate-report).
  --migrate-report <path> Migrate report used to resolve --scope migrated.
  --workspace <id>        Limit to a single workspace (default: all).
  --concurrency <n>       Threads appended concurrently per chunk (default ${NOTICE_BATCH}).

Auth:
  OAuth token is read from the newest ~/.mcporter/credentials.json entry whose
  serverUrl host matches --base-url and whose name contains "admin".
  Cloudflare Access token comes from CF_ACCESS_TOKEN, else
  \`cloudflared access token -app=<base-url>\`. On 401 the script prints the exact
  re-auth command.`;

function parseArgs(argv) {
  const subcommand = argv[2];
  const args = {
    subcommand,
    baseUrl: null,
    report: null,
    workspace: null,
    dryRun: false,
    force: false,
    concurrency: null,
    largeConcurrency: DEFAULT_LARGE_CONCURRENCY,
    migrateReport: null,
    sentAt: null,
    textFile: null,
    scope: "all",
    help: false,
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--workspace") args.workspace = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--large-concurrency") args.largeConcurrency = Number(argv[++i]);
    else if (arg === "--migrate-report") args.migrateReport = argv[++i];
    else if (arg === "--sent-at") args.sentAt = Number(argv[++i]);
    else if (arg === "--text-file") args.textFile = argv[++i];
    else if (arg === "--scope") args.scope = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Auth + transport.
// ---------------------------------------------------------------------------

/** 401-tagged error so top-level handling can print re-auth instructions. */
class AuthError extends Error {
  constructor(message, serverName) {
    super(message);
    this.name = "AuthError";
    this.serverName = serverName;
  }
}

/**
 * Resolve the OAuth access token from ~/.mcporter/credentials.json: newest
 * entry whose serverUrl host matches the base URL and whose name contains
 * "admin".
 */
function resolveOAuth(baseUrl) {
  const host = new URL(baseUrl).host;
  const credPath = join(homedir(), ".mcporter", "credentials.json");
  let creds;
  try {
    creds = JSON.parse(readFileSync(credPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${credPath}: ${error}. Run \`bunx mcporter auth <server>\` first.`);
  }
  let best = null;
  for (const [key, entry] of Object.entries(creds.entries ?? {})) {
    const name = entry.serverName ?? key;
    if (!/admin/i.test(name)) continue;
    let urlHost = "";
    try {
      urlHost = new URL(entry.serverUrl ?? "").host;
    } catch {
      continue;
    }
    if (urlHost !== host) continue;
    const token = entry.tokens?.access_token;
    if (!token) continue;
    const updatedAt = entry.updatedAt ?? "";
    if (!best || updatedAt > best.updatedAt) {
      best = { name, token, updatedAt };
    }
  }
  if (!best) {
    throw new Error(
      `No admin OAuth token for host ${host} in ${credPath}. ` +
        `Authenticate with \`bunx mcporter auth <server>\` (server baseUrl ${baseUrl}/api/admin/mcp, scope admin:mcp).`,
    );
  }
  return best;
}

let cfAccessCache;
/** Cloudflare Access token, cached; CF_ACCESS_TOKEN wins; skipped for localhost. */
function resolveAccessToken(baseUrl) {
  if (process.env.CF_ACCESS_TOKEN) return process.env.CF_ACCESS_TOKEN;
  if (cfAccessCache !== undefined) return cfAccessCache;
  if (/localhost|127\.0\.0\.1/.test(baseUrl)) {
    cfAccessCache = null;
    return null;
  }
  try {
    cfAccessCache = execFileSync("cloudflared", ["access", "token", `-app=${baseUrl}`], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    console.warn(`cloudflared access token failed (${error}); proceeding without CF-Access-Token`);
    cfAccessCache = null;
  }
  return cfAccessCache;
}

/** Build a bound JSON-RPC caller against <base-url>/api/admin/mcp. */
function makeClient(baseUrl) {
  const endpoint = `${baseUrl}/api/admin/mcp`;
  const oauth = resolveOAuth(baseUrl);
  const accessToken = resolveAccessToken(baseUrl);

  /**
   * Direct stateless JSON-RPC tools/call. Returns the tool's decoded text
   * payload (content[0].text parsed as JSON). Throws on HTTP error, JSON-RPC
   * error, or a malformed envelope.
   */
  async function rpc(name, toolArgs, { timeoutMs = MIGRATE_TIMEOUT_MS } = {}) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${oauth.token}`,
          ...(accessToken ? { "cf-access-token": accessToken } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: toolArgs },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`${name}: request failed: ${error}`);
    }
    if (response.status === 401) {
      throw new AuthError(`${name}: 401 Unauthorized`, oauth.name);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${name}: HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    const envelope = await response.json();
    if (envelope.error) {
      throw new Error(`${name}: JSON-RPC error: ${JSON.stringify(envelope.error).slice(0, 400)}`);
    }
    const text = envelope.result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`${name}: unexpected result envelope: ${JSON.stringify(envelope.result).slice(0, 400)}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${name}: result is not JSON: ${error}: ${text.slice(0, 300)}`);
    }
  }

  /**
   * admin_js_exec with strict result validation. A js_exec timeout is reported
   * INSIDE the payload as `{ error }`, so we surface it as a hard error and
   * return the unwrapped `result`, never a silent empty value.
   */
  async function jsExec(code, { timeoutMs = JS_EXEC_TIMEOUT_MS } = {}) {
    const out = await rpc("admin_js_exec", { code, timeout_ms: timeoutMs }, { timeoutMs: timeoutMs + 30_000 });
    if (out && typeof out === "object" && out.error !== undefined && out.result === undefined && out.body_json === undefined) {
      throw new Error(`admin_js_exec error: ${JSON.stringify(out.error).slice(0, 400)}`);
    }
    const result = out?.result ?? out?.body_json?.result;
    if (result === undefined) {
      throw new Error(`admin_js_exec returned no result: ${JSON.stringify(out).slice(0, 400)}`);
    }
    return result;
  }

  return { endpoint, oauth, rpc, jsExec };
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with a bounded worker pool, preserving order. */
async function runPool(items, concurrency, fn, onResult) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
      if (onResult) onResult(results[index], index);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Enumerate workspaces via search_workspaces (100-page cap). -> [{id, org}]. */
async function enumerateWorkspaces(client, only) {
  const workspaces = [];
  let offset = 0;
  for (;;) {
    const page = await client.rpc(
      "search_workspaces",
      { limit: WORKSPACE_PAGE_LIMIT, offset },
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    const body = page.body_json;
    if (!body || !Array.isArray(body.items) || !Number.isFinite(body.total)) {
      throw new Error(`search_workspaces: unexpected shape: ${JSON.stringify(page).slice(0, 300)}`);
    }
    for (const w of body.items) workspaces.push({ id: w.id, org: w.org_id });
    offset += WORKSPACE_PAGE_LIMIT;
    // Guard against a stuck loop if a page ever returns an empty slice before
    // reaching `total`.
    if (body.items.length === 0 || offset >= body.total) break;
  }
  if (only) return workspaces.filter((w) => w.id === only);
  return workspaces;
}

/** List a workspace's projects via the migration-reset listing DO method. */
async function listProjects(client, workspaceId) {
  const projects = await client.jsExec(
    `return await DO.call('WORKSPACE_FS', ${JSON.stringify(workspaceId)}, 'listProjectsForMigrationReset');`,
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (!Array.isArray(projects)) {
    throw new Error(`listProjectsForMigrationReset(${workspaceId}) not an array: ${JSON.stringify(projects).slice(0, 300)}`);
  }
  return projects;
}

/** One per-project migrate_vm_projects call, returning the first result row. */
async function migrateProject(client, workspaceId, project, { dryRun, force }) {
  const out = await client.rpc(
    "migrate_vm_projects",
    { workspace_id: workspaceId, project, dry_run: dryRun, ...(force ? { force: true } : {}) },
    { timeoutMs: MIGRATE_TIMEOUT_MS },
  );
  const body = out.body_json;
  if (!body || !Array.isArray(body.results)) {
    throw new Error(`migrate_vm_projects(${project}) unexpected shape: ${JSON.stringify(out).slice(0, 300)}`);
  }
  const row = body.results[0] ?? {};
  return {
    project,
    status: row.status ?? null,
    classification: row.classification ?? null,
    files_copied: row.files_copied ?? null,
    bytes_copied: row.bytes_copied ?? null,
    verified_files: row.verified_files ?? null,
    snapshot_id: row.snapshot_id ?? null,
    error: row.error ?? null,
    duration_ms: row.duration_ms ?? null,
  };
}

function writeReport(path, payload) {
  if (!path) return;
  writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`Report written to ${path}`);
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

async function cmdMigrate(client, args) {
  const smallConcurrency = positiveInt(args.concurrency ?? DEFAULT_MIGRATE_CONCURRENCY, "--concurrency");
  const largeConcurrency = positiveInt(args.largeConcurrency, "--large-concurrency");

  const workspaces = await enumerateWorkspaces(client, args.workspace);
  if (args.workspace && workspaces.length === 0) {
    throw new Error(`Workspace ${args.workspace} not found via search_workspaces`);
  }
  console.log(`migrate: ${workspaces.length} workspace(s)${args.dryRun ? " (dry run)" : ""}`);

  const wsReports = [];
  const failures = [];
  const totals = { legacy: 0, migrated: 0, failed: 0, filesCopied: 0 };

  for (const [wsIndex, ws] of workspaces.entries()) {
    let projects;
    try {
      projects = await listProjects(client, ws.id);
    } catch (error) {
      failures.push({ workspace_id: ws.id, project: null, error: String(error) });
      console.error(`[${wsIndex + 1}/${workspaces.length}] ${ws.id}: LIST ERROR ${error}`);
      wsReports.push({ workspaceId: ws.id, orgId: ws.org, error: String(error), migrated: 0, results: [] });
      continue;
    }
    const legacy = projects.filter((p) => (p.backend ?? "vm") !== "do-r2").map((p) => p.name);
    totals.legacy += legacy.length;
    console.log(
      `[${wsIndex + 1}/${workspaces.length}] ${ws.id}: ${projects.length} project(s), ${legacy.length} legacy`,
    );
    if (legacy.length === 0) {
      wsReports.push({ workspaceId: ws.id, orgId: ws.org, migrated: 0, results: [] });
      continue;
    }

    // Estimate pass: per-project dry runs give files_copied so we can size the
    // real pass. In --dry-run mode this pass IS the run.
    const estimates = await runPool(legacy, smallConcurrency, async (project) => {
      try {
        const r = await migrateProject(client, ws.id, project, { dryRun: true, force: args.force });
        return r;
      } catch (error) {
        return { project, status: "call-error", error: String(error), files_copied: null };
      }
    });

    if (args.dryRun) {
      for (const r of estimates) {
        console.log(`  ~ ${r.project}: class=${r.classification} files=${r.files_copied}${r.error ? ` err=${String(r.error).slice(0, 120)}` : ""}`);
        if (r.status === "call-error" || r.status === "failed") failures.push({ workspace_id: ws.id, ...r });
      }
      wsReports.push({ workspaceId: ws.id, orgId: ws.org, migrated: 0, dryRun: true, results: estimates });
      continue;
    }

    // Partition by estimated file count. Unknown/failed estimates are treated
    // as large (serial is the safe default for big or uncertain copies).
    const small = [];
    const large = [];
    for (const est of estimates) {
      const count = typeof est.files_copied === "number" ? est.files_copied : Infinity;
      (count <= SMALL_FILE_THRESHOLD ? small : large).push(est.project);
    }
    console.log(`  sizing: ${small.length} small (<=${SMALL_FILE_THRESHOLD} files, ${smallConcurrency}-wide), ${large.length} large (serial x${largeConcurrency})`);

    const runOne = async (project) => {
      try {
        const r = await migrateProject(client, ws.id, project, { dryRun: false, force: args.force });
        console.log(`  ${project}: status=${r.status} class=${r.classification} files=${r.files_copied} verified=${r.verified_files}${r.error ? ` err=${String(r.error).slice(0, 140)}` : ""}`);
        return r;
      } catch (error) {
        console.log(`  ${project}: CALL ERROR ${String(error).slice(0, 160)}`);
        return { project, status: "call-error", error: String(error) };
      }
    };
    const smallResults = await runPool(small, smallConcurrency, runOne);
    const largeResults = await runPool(large, largeConcurrency, runOne);
    const results = [...smallResults, ...largeResults];

    let migrated = 0;
    for (const r of results) {
      if (r.status === "migrated") {
        migrated += 1;
        if (typeof r.files_copied === "number") totals.filesCopied += r.files_copied;
      } else if (r.status === "failed" || r.status === "call-error") {
        failures.push({ workspace_id: ws.id, ...r });
      }
    }
    totals.migrated += migrated;
    wsReports.push({ workspaceId: ws.id, orgId: ws.org, migrated, results });
  }

  totals.failed = failures.length;
  console.log("\n=== migrate summary ===");
  console.log(`workspaces:      ${workspaces.length}`);
  console.log(`legacy projects: ${totals.legacy}`);
  console.log(`${args.dryRun ? "estimated" : "migrated"}:       ${args.dryRun ? "(dry run)" : totals.migrated}`);
  if (!args.dryRun) console.log(`files copied:    ${totals.filesCopied}`);
  console.log(`failures:        ${failures.length}`);
  for (const f of failures.slice(0, 20)) {
    console.log(`  FAIL ${f.workspace_id} ${f.project ?? ""}: ${String(f.error ?? "").slice(0, 160)}`);
  }
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more (see report)`);

  writeReport(args.report, {
    subcommand: "migrate",
    baseUrl: args.baseUrl,
    dryRun: args.dryRun,
    force: args.force,
    generatedAt: new Date().toISOString(),
    totals,
    workspaces: wsReports,
    failures,
  });

  return failures.length === 0;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/** Package-build migrate targets from a prior migrate report. */
function targetsFromMigrateReport(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const targets = [];
  for (const ws of report.workspaces ?? []) {
    for (const r of ws.results ?? []) {
      if (r.status === "migrated" && r.classification === "package-build") {
        targets.push({ ws: ws.workspaceId, project: r.project });
      }
    }
  }
  return targets;
}

async function cmdVerify(client, args) {
  const concurrency = positiveInt(args.concurrency ?? DEFAULT_VERIFY_CONCURRENCY, "--concurrency");

  // Resolve org ids for workspace_id -> org_id (verify_project_build needs org).
  const orgByWs = {};
  for (const w of await enumerateWorkspaces(client)) orgByWs[w.id] = w.org;

  let targets;
  if (args.migrateReport) {
    targets = targetsFromMigrateReport(args.migrateReport);
    console.log(`verify: ${targets.length} package-build target(s) from ${args.migrateReport}`);
  } else {
    // Scan fallback: the listing has no classification, so we verify every
    // do-r2 project (cannot pre-filter to package-build without a report).
    const workspaces = await enumerateWorkspaces(client, args.workspace);
    targets = [];
    for (const ws of workspaces) {
      const projects = await listProjects(client, ws.id);
      for (const p of projects) {
        if ((p.backend ?? "vm") === "do-r2") targets.push({ ws: ws.id, project: p.name });
      }
    }
    console.log(`verify: scanned ${workspaces.length} workspace(s) -> ${targets.length} do-r2 project(s)`);
  }

  const results = await runPool(targets, concurrency, async ({ ws, project }) => {
    const orgId = orgByWs[ws];
    try {
      const out = await client.rpc(
        "verify_project_build",
        { workspace_id: ws, project, org_id: orgId, timeout_ms: VERIFY_BUILD_TIMEOUT_MS },
        { timeoutMs: VERIFY_RPC_TIMEOUT_MS },
      );
      const b = out.body_json ?? {};
      const record = {
        ws,
        project,
        success: b.success === true,
        exit_code: b.exit_code ?? null,
        duration_ms: b.duration_ms ?? null,
        error: b.error ?? null,
        log_excerpt: b.log_excerpt ?? null,
      };
      console.log(`  ${project}: success=${record.success} exit=${record.exit_code} dur=${record.duration_ms}ms${record.error ? ` err=${String(record.error).slice(0, 120)}` : ""}`);
      return record;
    } catch (error) {
      console.log(`  ${project}: CALL ERROR ${String(error).slice(0, 140)}`);
      return { ws, project, success: false, error: String(error), log_excerpt: null };
    }
  });

  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  console.log("\n=== verify scorecard ===");
  console.log(`targets: ${results.length}`);
  console.log(`passed:  ${passed.length}`);
  console.log(`failed:  ${failed.length}`);
  for (const r of failed) {
    console.log(`  FAIL ${r.ws} ${r.project}: ${String(r.error ?? `exit ${r.exit_code}`).slice(0, 200)}`);
    if (r.log_excerpt) {
      console.log(`    log: ${String(r.log_excerpt).replace(/\n/g, "\n    ").slice(0, 600)}`);
    }
  }

  writeReport(args.report, {
    subcommand: "verify",
    baseUrl: args.baseUrl,
    generatedAt: new Date().toISOString(),
    totals: { targets: results.length, passed: passed.length, failed: failed.length },
    results,
  });

  return failed.length === 0;
}

// ---------------------------------------------------------------------------
// notice
// ---------------------------------------------------------------------------

/** Build the chunked appendCamelSystemNotice js_exec body for one workspace. */
function noticeChunkCode({ org, ws, offset, chunk, batch, text, sentAt }) {
  return `
const threads = await DO.call('ORG', ${JSON.stringify(org)}, 'getThreadsByWorkspace', [${JSON.stringify(ws)}]);
const slice = threads.slice(${offset}, ${offset + chunk});
let appended = 0, skipped = 0;
for (let i = 0; i < slice.length; i += ${batch}) {
  const group = slice.slice(i, i + ${batch});
  const outcomes = await Promise.all(group.map((t) =>
    DO.call('CHAT_THREAD', t.id, 'appendCamelSystemNotice', [{ text: ${JSON.stringify(text)}, sentAt: ${sentAt} }])
  ));
  for (const o of outcomes) {
    if (o && o.status === 'appended') appended++; else skipped++;
  }
}
return { total: threads.length, appended, skipped };`;
}

async function cmdNotice(client, args) {
  if (!Number.isFinite(args.sentAt)) {
    throw new Error("--sent-at <ms> is required (idempotency key; reuse it to dedupe re-runs)");
  }
  if (args.scope !== "all" && args.scope !== "migrated") {
    throw new Error(`--scope must be 'all' or 'migrated' (got ${args.scope})`);
  }
  const batch = positiveInt(args.concurrency ?? NOTICE_BATCH, "--concurrency");
  const text = args.textFile ? readFileSync(args.textFile, "utf8") : DEFAULT_NOTICE_TEXT;

  let workspaces = await enumerateWorkspaces(client, args.workspace);
  if (args.scope === "migrated") {
    if (!args.migrateReport) {
      throw new Error("--scope migrated requires --migrate-report <path>");
    }
    const report = JSON.parse(readFileSync(args.migrateReport, "utf8"));
    const migratedIds = new Set(
      (report.workspaces ?? []).filter((w) => (w.migrated ?? 0) >= 1).map((w) => w.workspaceId),
    );
    workspaces = workspaces.filter((w) => migratedIds.has(w.id));
    console.log(`notice: scope=migrated -> ${workspaces.length} workspace(s) with >=1 migrated project`);
  } else {
    console.log(`notice: scope=all -> ${workspaces.length} workspace(s)`);
  }
  console.log(`notice: sentAt=${args.sentAt} (reuse to dedupe re-runs)`);

  const wsResults = [];
  const failures = [];
  let totalThreads = 0;
  let totalAppended = 0;

  for (const [i, ws] of workspaces.entries()) {
    let wsTotal = 0;
    let wsAppended = 0;
    let wsSkipped = 0;
    try {
      let offset = 0;
      for (;;) {
        const result = await client.jsExec(
          noticeChunkCode({ org: ws.org, ws: ws.id, offset, chunk: NOTICE_CHUNK, batch, text, sentAt: args.sentAt }),
          { timeoutMs: JS_EXEC_TIMEOUT_MS },
        );
        if (typeof result?.total !== "number") {
          throw new Error(`notice chunk unexpected shape: ${JSON.stringify(result).slice(0, 200)}`);
        }
        wsTotal = result.total;
        wsAppended += result.appended ?? 0;
        wsSkipped += result.skipped ?? 0;
        offset += NOTICE_CHUNK;
        if (offset >= wsTotal) break;
      }
      totalThreads += wsTotal;
      totalAppended += wsAppended;
      wsResults.push({ workspaceId: ws.id, orgId: ws.org, total: wsTotal, appended: wsAppended, skipped: wsSkipped });
      console.log(`[${i + 1}/${workspaces.length}] ${ws.id}: ${wsAppended}/${wsTotal} appended (${wsSkipped} skipped/deduped)`);
    } catch (error) {
      failures.push({ workspaceId: ws.id, error: String(error) });
      console.log(`[${i + 1}/${workspaces.length}] ${ws.id}: ERROR ${String(error).slice(0, 160)}`);
    }
  }

  console.log("\n=== notice summary ===");
  console.log(`workspaces:      ${workspaces.length}`);
  console.log(`threads:         ${totalThreads}`);
  console.log(`notices appended: ${totalAppended}`);
  console.log(`failures:        ${failures.length}`);
  for (const f of failures) console.log(`  FAIL ${f.workspaceId}: ${String(f.error).slice(0, 160)}`);

  writeReport(args.report, {
    subcommand: "notice",
    baseUrl: args.baseUrl,
    sentAt: args.sentAt,
    scope: args.scope,
    generatedAt: new Date().toISOString(),
    totals: { workspaces: workspaces.length, threads: totalThreads, appended: totalAppended, failures: failures.length },
    workspaces: wsResults,
    failures,
  });

  return failures.length === 0;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.subcommand || args.subcommand === "help") {
    console.log(USAGE);
    return;
  }
  if (!["migrate", "verify", "notice"].includes(args.subcommand)) {
    throw new Error(`Unknown subcommand '${args.subcommand}' (expected migrate|verify|notice). Use --help.`);
  }
  if (!args.baseUrl) {
    throw new Error("--base-url is required (e.g. https://staging.camelai.dev)");
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");

  const client = makeClient(args.baseUrl);
  console.log(`admin MCP: ${client.endpoint} (oauth: ${client.oauth.name})`);

  let ok;
  if (args.subcommand === "migrate") ok = await cmdMigrate(client, args);
  else if (args.subcommand === "verify") ok = await cmdVerify(client, args);
  else ok = await cmdNotice(client, args);

  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof AuthError) {
    console.error(`\n${error.message}`);
    console.error(`Re-authenticate with: bunx mcporter auth ${error.serverName}`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
