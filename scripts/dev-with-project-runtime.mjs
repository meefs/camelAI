import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const useLocalRuntime = process.env.USE_LOCAL_PROJECT_RUNTIME === "1";
const runtimeUrl = process.env.PROJECT_RUNTIME_SERVICE_URL || "http://127.0.0.1:4410";
const runtimePort = new URL(runtimeUrl).port || "4410";
const dockerProxyPort = process.env.PROJECT_RUNTIME_DOCKER_PROXY_PORT || "4411";
const runtimeRepoUrl =
  process.env.PROJECT_RUNTIME_SERVICE_REPO ||
  "https://github.com/qaml-ai/project-runtime-service.git";

let runtimeProcess;
let appProcess;

if (useLocalRuntime) {
  const runtimeDir = await ensureRuntimeServiceDir();
  if (await isRuntimeHealthy()) {
    console.log(`[dev] project-runtime-service already healthy at ${runtimeUrl}`);
  } else {
    runtimeProcess = startRuntimeService(runtimeDir);
    await waitForRuntime();
  }
} else {
  console.log("[dev] using remote project runtime VPC bindings");
}

const appEnv = { ...process.env };
if (useLocalRuntime) {
  appEnv.PROJECT_RUNTIME_SERVICE_URL = runtimeUrl;
  appEnv.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL =
    process.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL ||
    `http://host.docker.internal:${dockerProxyPort}`;
} else if (!process.env.PROJECT_RUNTIME_SERVICE_URL) {
  delete appEnv.PROJECT_RUNTIME_SERVICE_URL;
}

appProcess = spawn("react-router", ["dev"], {
  cwd: repoRoot,
  env: appEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});

const shutdown = (signal) => {
  if (appProcess && !appProcess.killed) appProcess.kill(signal);
  if (runtimeProcess && !runtimeProcess.killed) runtimeProcess.kill(signal);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

appProcess.on("exit", (code, signal) => {
  if (runtimeProcess && !runtimeProcess.killed) runtimeProcess.kill("SIGTERM");
  process.exit(code ?? signalExitCode(signal));
});

async function ensureRuntimeServiceDir() {
  const configured = process.env.PROJECT_RUNTIME_SERVICE_DIR;
  if (configured) {
    const absolute = path.resolve(configured);
    if (!existsSync(path.join(absolute, "go.mod"))) {
      throw new Error(`PROJECT_RUNTIME_SERVICE_DIR is not a Go module: ${absolute}`);
    }
    return absolute;
  }

  const candidates = [
    path.resolve(repoRoot, "..", "project-runtime-service"),
    path.join(os.homedir(), "qaml-ai", "project-runtime-service"),
  ];
  const existing = candidates.find((candidate) => existsSync(path.join(candidate, "go.mod")));
  if (existing) return existing;

  const target = candidates.at(-1);
  await mkdir(path.dirname(target), { recursive: true });
  console.log(`[dev] cloning ${runtimeRepoUrl} into ${target}`);
  await run("git", ["clone", runtimeRepoUrl, target], { cwd: path.dirname(target) });
  return target;
}

function startRuntimeService(cwd) {
  console.log(`[dev] starting project-runtime-service at ${runtimeUrl}`);
  const runtimeStateRoot = path.join(cwd, ".project-runtime");
  const child = spawn("go", ["run", "./cmd/project-runtime"], {
    cwd,
    env: {
      ...process.env,
      PORT: runtimePort,
      PROJECT_RUNTIME_DOCKER_PROXY_PORT: dockerProxyPort,
      CONTAINER_RUNTIME: process.env.CONTAINER_RUNTIME || "runc",
      WORKSPACES_ROOT: process.env.WORKSPACES_ROOT || path.join(runtimeStateRoot, "workspaces"),
      PROJECT_RUNTIME_USAGE_DB_DIR:
        process.env.PROJECT_RUNTIME_USAGE_DB_DIR || path.join(runtimeStateRoot, "usage"),
      PROJECT_RUNTIME_STATE_ROOT:
        process.env.PROJECT_RUNTIME_STATE_ROOT || path.join(runtimeStateRoot, "state"),
      PROJECT_RUNTIME_BACKUP_ROOT:
        process.env.PROJECT_RUNTIME_BACKUP_ROOT || path.join(runtimeStateRoot, "backups"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(prefixLines("runtime", chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefixLines("runtime", chunk)));
  child.on("exit", (code, signal) => {
    if (!appProcess && code !== 0) {
      console.error(`[dev] project-runtime-service exited before app startup (${signal || code})`);
    }
  });
  return child;
}

async function waitForRuntime() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await isRuntimeHealthy()) {
      console.log(`[dev] project-runtime-service healthy at ${runtimeUrl}`);
      return;
    }
    await sleep(500);
  }
  if (runtimeProcess && !runtimeProcess.killed) runtimeProcess.kill("SIGTERM");
  throw new Error(`Timed out waiting for project-runtime-service at ${runtimeUrl}`);
}

async function isRuntimeHealthy() {
  try {
    const response = await fetch(new URL("/health", runtimeUrl), { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined);
    return body?.service === "project-runtime-service";
  } catch {
    return false;
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(\n)/)
    .map((part) => (part && part !== "\n" ? `[${label}] ${part}` : part))
    .join("");
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 0;
}
