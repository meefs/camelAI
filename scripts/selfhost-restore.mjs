#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  readSelfhostEnv,
  run,
  runtimeHostStateDir,
  scriptEnv,
  volumeName,
  volumeNames,
} from "./selfhost-common.mjs";

const backupDir = path.resolve(process.cwd(), process.argv[2] || "");
if (!process.argv[2] || !existsSync(backupDir)) {
  console.error("Usage: bun run selfhost:restore -- <backup-dir>");
  process.exit(1);
}

const env = await readSelfhostEnv(true);
const manifestPath = path.join(backupDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Missing backup manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
for (const name of volumeNames) {
  const archive = path.join(backupDir, `${name}.tgz`);
  if (!existsSync(archive)) {
    console.warn(`[selfhost:restore] Skipping missing archive ${archive}`);
    continue;
  }
  await restoreVolume(volumeName(name, env), `${name}.tgz`);
}
if (existsSync(path.join(backupDir, "project-runtime-state.tgz"))) {
  await restoreDirectory(runtimeHostStateDir(env), "project-runtime-state.tgz");
}

console.log(`Restored self-host backup created at ${manifest.createdAt || "unknown time"}.`);

async function restoreVolume(dockerVolume, archiveName) {
  await run("docker", ["volume", "create", dockerVolume], { env: scriptEnv(env) });
  await run("docker", [
    "run",
    "--rm",
    "-v",
    `${dockerVolume}:/data`,
    "-v",
    `${backupDir}:/backup:ro`,
    "alpine:3.20",
    "sh",
    "-lc",
    `rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; tar -xzf /backup/${archiveName} -C /data`,
  ], { env: scriptEnv(env) });
}

async function restoreDirectory(targetDir, archiveName) {
  await fs.mkdir(targetDir, { recursive: true });
  await run("docker", [
    "run",
    "--rm",
    "-v",
    `${targetDir}:/data`,
    "-v",
    `${backupDir}:/backup:ro`,
    "alpine:3.20",
    "sh",
    "-lc",
    `rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; tar -xzf /backup/${archiveName} -C /data`,
  ], { env: scriptEnv(env) });
}
