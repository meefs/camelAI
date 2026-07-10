import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const repoRoot = path.resolve(import.meta.dirname, "..");
export const composeFile = path.join(repoRoot, "docker-compose.selfhost.yml");
export const envFile = path.resolve(
  repoRoot,
  process.env.SELFHOST_ENV_FILE || ".env.selfhost",
);
export const defaultProjectName = "camelai-selfhost";
export const volumeNames = [
  "app-state",
  "local-artifacts-repos",
];

export async function readSelfhostEnv(required = false) {
  if (!existsSync(envFile)) {
    if (required) {
      throw new Error(`Missing ${path.relative(repoRoot, envFile)}. Run \`bun run selfhost:init\` first.`);
    }
    return {};
  }

  const text = await fs.readFile(envFile, "utf8");
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

export function writeEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function projectName(env = {}) {
  return env.COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME || defaultProjectName;
}

export function volumeName(name, env = {}) {
  return `${projectName(env)}_${name}`;
}

export function composeArgs(env, args) {
  return [
    "compose",
    "--env-file",
    envFile,
    "-f",
    composeFile,
    ...args,
  ];
}

export function scriptEnv(env = {}, extra = {}) {
  return {
    ...process.env,
    ...env,
    ...extra,
  };
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      ...options,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

export async function capture(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

export async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}
