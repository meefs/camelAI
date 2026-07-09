#!/usr/bin/env node
/**
 * Fleet driver for migrating legacy VM-backed projects to DO+R2 storage.
 *
 * Enumerates workspaces through the admin API and calls
 * POST /api/admin/workspaces/:id/project-vm-migration for each, collecting a
 * per-project report. Safe to re-run: already-migrated projects are skipped
 * server-side and VM checkouts are never modified.
 *
 * Usage:
 *   ADMIN_API_KEY=... node scripts/migrate-vm-projects.mjs \
 *     --base-url https://staging.camelai.dev [--dry-run] [--workspace <id>] \
 *     [--concurrency 4] [--report migration-report.json]
 *
 * Staging/prod sit behind Cloudflare Access; pass a service/user token via
 * CF_ACCESS_TOKEN or let the script shell out to
 * `cloudflared access token -app=<base-url>`.
 */

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

function parseArgs(argv) {
  const args = {
    baseUrl: null,
    dryRun: false,
    workspace: null,
    concurrency: 4,
    report: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--workspace") args.workspace = argv[++i];
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--report") args.report = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.baseUrl) throw new Error("--base-url is required (e.g. https://staging.camelai.dev)");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return args;
}

function resolveAccessToken(baseUrl) {
  if (process.env.CF_ACCESS_TOKEN) return process.env.CF_ACCESS_TOKEN;
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) return null;
  try {
    return execFileSync("cloudflared", ["access", "token", `-app=${baseUrl}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY env var is required");
  const accessToken = resolveAccessToken(args.baseUrl);

  const headers = {
    Authorization: `Bearer ${adminKey}`,
    "Content-Type": "application/json",
    ...(accessToken ? { "CF-Access-Token": accessToken } : {}),
  };

  async function api(path, init) {
    const response = await fetch(`${args.baseUrl}/api/admin${path}`, { ...init, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    }
    return response.json();
  }

  let workspaceIds = [];
  if (args.workspace) {
    workspaceIds = [args.workspace];
  } else {
    const limit = 200;
    for (let offset = 0; ; offset += limit) {
      const page = await api(`/workspaces?limit=${limit}&offset=${offset}`);
      workspaceIds.push(...page.items.map((workspace) => workspace.id));
      if (offset + limit >= page.total) break;
    }
  }
  console.log(`Migrating ${workspaceIds.length} workspace(s)${args.dryRun ? " (dry run)" : ""}`);

  const perWorkspace = [];
  const failures = [];
  let migrated = 0;
  let alreadyDoR2 = 0;
  let processed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < workspaceIds.length) {
      const index = cursor;
      cursor += 1;
      const workspaceId = workspaceIds[index];
      try {
        const summary = await api(`/workspaces/${workspaceId}/project-vm-migration`, {
          method: "POST",
          body: JSON.stringify({ dry_run: args.dryRun }),
        });
        perWorkspace.push(summary);
        processed += summary.processed;
        migrated += summary.migrated;
        alreadyDoR2 += summary.already_do_r2;
        for (const result of summary.results) {
          if (result.status === "failed") {
            failures.push({ workspace_id: workspaceId, ...result });
          }
        }
        const label = args.dryRun ? "scanned" : "migrated";
        console.log(
          `[${index + 1}/${workspaceIds.length}] ${workspaceId}: ${summary.processed} project(s), ` +
            `${args.dryRun ? summary.processed - summary.already_do_r2 : summary.migrated} ${label}, ${summary.failed} failed`,
        );
      } catch (error) {
        failures.push({ workspace_id: workspaceId, status: "failed", error: String(error) });
        console.error(`[${index + 1}/${workspaceIds.length}] ${workspaceId}: ERROR ${error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(args.concurrency, workspaceIds.length) }, worker));

  console.log("\n=== Summary ===");
  console.log(`workspaces: ${workspaceIds.length}`);
  console.log(`projects processed: ${processed}`);
  console.log(`${args.dryRun ? "would migrate" : "migrated"}: ${migrated}`);
  console.log(`already do-r2: ${alreadyDoR2}`);
  console.log(`failures: ${failures.length}`);
  for (const failure of failures.slice(0, 20)) {
    console.log(`  FAIL ${failure.workspace_id} ${failure.project_name ?? ""}: ${failure.error}`);
  }
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more (see report)`);

  if (args.report) {
    writeFileSync(
      args.report,
      JSON.stringify({ args: { ...args }, generatedAt: new Date().toISOString(), perWorkspace, failures }, null, 2),
    );
    console.log(`Report written to ${args.report}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
