#!/usr/bin/env node
// Report a finished local eval run to the shared results viewer (workers/eval-reports,
// https://evals.camelai.dev): uploads the transcript artifact + output log and posts run
// metadata, which the worker folds into the dashboard's run record.
//
// Normally invoked automatically by scripts/run-agent-eval.mjs when EVAL_REPORT=1, but
// can be run by hand on any artifact:
//
//   node scripts/report-eval-run.mjs --eval dashboard-fake-data-live \
//     --artifact .eval-artifacts/dashboard-fake-data-live.json \
//     [--log <file>] [--exit-code 0] [--model sonnet] [--batch <id>] \
//     [--kind unit|skill] [--tier hard] [--started <iso>] [--finished <iso>]
//
// Auth: the viewer sits behind Cloudflare Access. Set CF_ACCESS_CLIENT_ID/SECRET (an
// Access service token) — or, for humans, the script falls back to minting a token via
// `cloudflared access token`. EVAL_REPORT_BASE overrides the target (e.g. a local
// wrangler dev with CF_ACCESS_ENABLED=0, which needs no credentials).

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { retryEvalFinalize } from "./eval-report-utils.mjs";

const base = (process.env.EVAL_REPORT_BASE ?? "https://evals.camelai.dev").replace(/\/+$/, "");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = {
      "--eval": "eval",
      "--artifact": "artifact",
      "--log": "log",
      "--exit-code": "exitCode",
      "--model": "model",
      "--real-deploy": "realDeploy",
      "--started": "started",
      "--finished": "finished",
      "--run-id": "runId",
      "--batch": "batch",
      "--batch-label": "batchLabel",
      "--kind": "kind",
      "--tier": "tier",
      "--description": "description",
    }[arg];
    if (!key) {
      console.error(`Unknown option "${arg}"`);
      process.exit(1);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      console.error(`Missing value for ${arg}`);
      process.exit(1);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.eval) {
  console.error("--eval <id> is required");
  process.exit(1);
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function accessHeaders() {
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    return {
      "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
    };
  }
  // Human path: reuse the local cloudflared login (cloudflared access login <base>).
  const minted = spawnSync("cloudflared", ["access", "token", `-app=${base}`], {
    encoding: "utf8",
  });
  const token = minted.status === 0 ? minted.stdout.trim() : "";
  return token ? { "cf-access-token": token } : {};
}

const headers = accessHeaders();

async function send(method, urlPath, body, contentType) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
    body,
  });
  if (!response.ok) {
    throw new Error(`${method} ${urlPath} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

function newRunId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-");
  return `eval-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
}

const runId = options.runId ?? newRunId();

try {
  if (options.artifact) {
    const name = path.basename(options.artifact);
    await send(
      "PUT",
      `/upload/${runId}/artifacts/${encodeURIComponent(name)}`,
      readFileSync(options.artifact),
      "application/json",
    );
  }
  if (options.log) {
    await send(
      "PUT",
      `/upload/${runId}/log`,
      readFileSync(options.log),
      "text/plain; charset=utf-8",
    );
  }
  const complete = {
    evalTarget: options.eval,
    exitCode: options.exitCode !== undefined ? Number(options.exitCode) : 1,
    batchId: options.batch || undefined,
    batchLabel: options.batchLabel || undefined,
    kind: options.kind || undefined,
    tier: options.tier || undefined,
    description: options.description || undefined,
    ref: git("rev-parse", "--abbrev-ref", "HEAD"),
    commit: git("rev-parse", "HEAD"),
    model: options.model || undefined,
    realDeploy:
      options.realDeploy !== undefined ? options.realDeploy === "1" : undefined,
    startedAt: options.started || undefined,
    finishedAt: options.finished || undefined,
    host: hostname(),
  };
  const completePath = `/upload/${runId}/complete`;
  const completeBody = JSON.stringify(complete);
  const completeResponse = await retryEvalFinalize(
    () => send("POST", completePath, completeBody, "application/json"),
    {
      onRetry(error, attempt, attempts) {
        console.warn(
          `Eval report finalization failed (attempt ${attempt}/${attempts}); retrying: ${error instanceof Error ? error.message : error}`,
        );
      },
    },
  );
  const run = await completeResponse.json();
  console.log(`Reported eval run: ${base}/runs/${encodeURIComponent(run.runId)} (${run.status})`);
} catch (error) {
  // Reporting is best-effort telemetry — never fail the eval over it.
  console.warn(`Eval report upload failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 0;
}
