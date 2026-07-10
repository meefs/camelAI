#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import process from "node:process";
import {
  capture,
  composeArgs,
  envFile,
  pathExists,
  readSelfhostEnv,
  repoRoot,
  scriptEnv,
  volumeName,
  volumeNames,
} from "./selfhost-common.mjs";

const checks = [];
const env = await readSelfhostEnv(false);
const appPort = Number(env.SELFHOST_APP_PORT || process.env.SELFHOST_APP_PORT || 3001);
let current;

await check("env file", async () => {
  if (!(await pathExists(envFile))) {
    fail(`missing ${path.relative(repoRoot, envFile)}; run \`bun run selfhost:init\``);
  }
  for (const key of [
    "TOKEN_SIGNING_SECRET",
    "INTEGRATION_SECRET_KEY",
    "LOCAL_ARTIFACTS_SECRET",
  ]) {
    if (!env[key]) fail(`missing ${key}`);
    if (env[key].includes("change-me")) fail(`${key} still uses a development default`);
  }
});

await check("required CLIs", async () => {
  await requireCommand("docker", ["--version"]);
  await requireCommand("git", ["--version"]);
  await requireCommand("bun", ["--version"]);
});

await check("Docker daemon", async () => {
  const result = await capture("docker", ["info"], { env: scriptEnv(env) });
  if (result.code !== 0) fail(result.stderr.trim() || "docker info failed");
});

await check("self-host app domains", async () => {
  const publicBaseUrl = env.SELFHOST_PUBLIC_BASE_URL || process.env.SELFHOST_PUBLIC_BASE_URL || "";
  if (!publicBaseUrl.trim()) fail("missing SELFHOST_PUBLIC_BASE_URL");
  const parsed = new URL(publicBaseUrl);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    warn("SELFHOST_PUBLIC_BASE_URL points at localhost; published apps require configured DNS/tunnel domains");
  }
  for (const key of ["LOCAL_APP_VANITY_DOMAIN", "LOCAL_APP_IFRAME_DOMAIN"]) {
    const value = env[key] || process.env[key] || "";
    if (!value.trim()) fail(`missing ${key}`);
    const hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) {
      fail(`${key} must be a real DNS/tunnel wildcard domain, not localhost`);
    }
    note(`${key}: ${hostname}`);
  }
});

await check("compose config", async () => {
  const result = await capture("docker", composeArgs(env, ["config", "--quiet"]), {
    env: scriptEnv(env),
  });
  if (result.code !== 0) fail(result.stderr.trim() || "docker compose config failed");
});

await check("volume names", async () => {
  for (const name of volumeNames) {
    note(`${name}: ${volumeName(name, env)}`);
  }
});

await check("local services", async () => {
  await optionalHttp(`http://127.0.0.1:${appPort}/api/selfhost/health`, "app self-host health");
  await optionalHttp("http://127.0.0.1:7001/health", "local Artifacts");
});

for (const item of checks) {
  const prefix = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
  console.log(`[${prefix}] ${item.name}${item.message ? `: ${item.message}` : ""}`);
  for (const detail of item.details) console.log(`      ${detail}`);
}

const failed = checks.filter((item) => item.status === "fail").length;
if (failed > 0) {
  console.error(`selfhost:doctor found ${failed} blocking issue${failed === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("selfhost:doctor passed.");

async function check(name, fn) {
  const item = { name, status: "pass", message: "", details: [] };
  checks.push(item);
  const previous = current;
  current = item;
  try {
    await fn();
  } catch (error) {
    if (item.status !== "fail") {
      item.status = "fail";
      item.message = error instanceof Error ? error.message : String(error);
    }
  } finally {
    current = previous;
  }
}

function fail(message) {
  current.status = "fail";
  current.message = message;
  throw new Error(message);
}

function warn(message) {
  if (current.status === "pass") current.status = "warn";
  current.message = message;
}

function note(message) {
  current.details.push(message);
}

async function requireCommand(command, args) {
  const result = await capture(command, args, { env: scriptEnv(env) });
  if (result.code !== 0) fail(`${command} is not available`);
  note(result.stdout.trim().split(/\r?\n/, 1)[0] || command);
}

async function optionalHttp(url, label) {
  const parsed = new URL(url);
  if (!(await canConnect(parsed.hostname, Number(parsed.port)))) {
    warn("stack is not running; live service checks skipped");
    note(`${label}: not listening at ${url}`);
    return;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch((error) => {
    fail(`${label} request failed: ${error.message}`);
  });
  if (!response.ok) {
    warn("stack is not fully healthy; live service checks are diagnostic only");
    note(`${label}: HTTP ${response.status}`);
    return;
  }
  note(`${label}: HTTP ${response.status}`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 500 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}
