#!/usr/bin/env node
import net from "node:net";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
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
const deploymentMode = (
  env.SELFHOST_DEPLOYMENT_MODE ||
  process.env.SELFHOST_DEPLOYMENT_MODE ||
  "release"
).trim();
const effectiveEnv = scriptEnv({
  ...env,
  SELFHOST_DEPLOYMENT_MODE: deploymentMode,
});
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
  const result = await capture("docker", ["info"], { env: effectiveEnv });
  if (result.code !== 0) fail(result.stderr.trim() || "docker info failed");
});

await check("deployment mode", async () => {
  if (!new Set(["release", "source"]).has(deploymentMode)) {
    fail(
      `SELFHOST_DEPLOYMENT_MODE must be "release" or "source", got ${deploymentMode}`,
    );
  }
  note(`SELFHOST_DEPLOYMENT_MODE: ${deploymentMode}`);
});

const imageKeys = [
  "SELFHOST_APP_IMAGE",
  "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
  "SELFHOST_PROJECT_BUILD_IMAGE",
  "SELFHOST_ANALYSIS_IMAGE",
  "SELFHOST_DB_QUERY_IMAGE",
  "SELFHOST_CONTAINER_EGRESS_IMAGE",
];

await check("container images", async () => {
  for (const key of imageKeys) {
    const image = (effectiveEnv[key] || "").trim();
    if (!image) fail(`missing ${key}`);
    note(`${key}: ${image}`);
  }

  const unavailable = [];
  for (const key of imageKeys) {
    const image = effectiveEnv[key];
    const result = await capture("docker", ["image", "inspect", image], {
      env: effectiveEnv,
    });
    if (result.code !== 0) unavailable.push(key);
  }
  if (unavailable.length > 0) {
    warn(
      `${unavailable.length} configured image${
        unavailable.length === 1 ? " is" : "s are"
      } not local yet; selfhost:up will pull or build them`,
    );
    note(`not local: ${unavailable.join(", ")}`);
  }
});

await check("Docker VM capacity", async () => {
  const result = await capture(
    "docker",
    ["info", "--format", "{{json .}}"],
    { env: effectiveEnv },
  );
  if (result.code !== 0) fail(result.stderr.trim() || "docker info failed");
  const info = JSON.parse(result.stdout);
  const warnings = [];
  const architecture = String(info.Architecture || "");
  const cpus = Number(info.NCPU || 0);
  const memoryBytes = Number(info.MemTotal || 0);

  note(`architecture: ${architecture || "unknown"}`);
  note(`CPUs: ${cpus || "unknown"}`);
  note(
    `memory: ${
      memoryBytes ? `${(memoryBytes / 1024 ** 3).toFixed(1)} GiB` : "unknown"
    }`,
  );
  if (architecture !== "x86_64" && architecture !== "amd64") {
    warnings.push(
      `${architecture || "unknown"} Docker architecture may not run the analysis sandbox reliably; use x86_64 for full notebook support`,
    );
  }
  if (cpus > 0 && cpus < 4) warnings.push("fewer than 4 Docker CPUs");
  if (memoryBytes > 0 && memoryBytes < 8 * 1024 ** 3) {
    warnings.push("less than 8 GiB Docker memory");
  }

  const dockerRootDir = String(info.DockerRootDir || "").trim();
  if (dockerRootDir) {
    const disk = await capture("df", ["-Pk", dockerRootDir]);
    if (disk.code === 0) {
      const fields = disk.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/);
      const freeKiB = Number(fields?.[3] || 0);
      if (freeKiB > 0) {
        const freeGiB = freeKiB / 1024 ** 2;
        note(`Docker disk free: ${freeGiB.toFixed(1)} GiB`);
        if (freeGiB < 20) warnings.push("less than 20 GiB free Docker disk");
      }
    } else {
      note(
        `Docker disk free: unavailable from host path ${dockerRootDir} (common with Docker Desktop)`,
      );
    }
  }
  if (warnings.length > 0) warn(warnings.join("; "));
});

await check("Docker socket", async () => {
  const socketPath =
    env.SELFHOST_DOCKER_SOCKET_PATH ||
    process.env.SELFHOST_DOCKER_SOCKET_PATH ||
    "/var/run/docker.sock";
  await fs.access(socketPath, fsConstants.R_OK | fsConstants.W_OK).catch(() => {
    fail(`Docker socket is not readable and writable: ${socketPath}`);
  });
  note(socketPath);
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

await check("AI provider", async () => {
  const provider = (env.SELFHOST_AI_PROVIDER || "").trim().toLowerCase();
  const supported = new Set([
    "anthropic",
    "bedrock",
    "custom",
    "openai",
    "openrouter",
  ]);
  if (!provider) {
    fail("missing SELFHOST_AI_PROVIDER; chat cannot run without an AI provider");
  }
  if (!supported.has(provider)) {
    fail(`unsupported SELFHOST_AI_PROVIDER=${provider}`);
  }
  if (!(env.SELFHOST_AI_API_KEY || "").trim()) {
    fail("missing SELFHOST_AI_API_KEY");
  }
  if (provider === "custom") {
    if (!(env.SELFHOST_AI_BASE_URL || "").trim()) {
      fail("missing SELFHOST_AI_BASE_URL for custom provider");
    }
    if (!(env.SELFHOST_AI_MODEL || "").trim()) {
      fail("missing SELFHOST_AI_MODEL for custom provider");
    }
  }
  note(`SELFHOST_AI_PROVIDER: ${provider}`);
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
