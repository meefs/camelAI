#!/usr/bin/env node
/**
 * Standalone one-time bridge for installations whose checked-out upgrader
 * predates the verified release-manifest flow. This file intentionally imports
 * only Node built-ins so an operator can execute the target release's copy via
 * `git show <release>:scripts/selfhost-upgrade-bootstrap.mjs`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
const repository = path.resolve(options.repo || process.cwd());
const releaseRef = required(options.release, "--release");
const sourceManifest = path.resolve(
  process.cwd(),
  required(options.manifest, "--manifest"),
);
const envFile = path.resolve(
  repository,
  process.env.SELFHOST_ENV_FILE || ".env.selfhost",
);

process.chdir(repository);
await requireFile(path.join(repository, ".git"), "Git checkout");
await requireFile(envFile, "self-host environment");
const status = await capture("git", [
  "status",
  "--porcelain",
  "--untracked-files=no",
]);
if (status) {
  throw new Error(
    "Bootstrap upgrade requires a clean tracked worktree. Commit or stash local changes first.",
  );
}

const manifest = JSON.parse(await fs.readFile(sourceManifest, "utf8"));
if (
  manifest.schema !== 1 ||
  typeof manifest.revision !== "string" ||
  !/^[0-9a-f]{40}$/i.test(manifest.revision)
) {
  throw new Error(`Invalid self-host release manifest: ${sourceManifest}`);
}

await run("git", ["fetch", "--force", "--tags", "origin"]);
const targetCommit = await capture("git", ["rev-parse", `${releaseRef}^{commit}`]);
if (targetCommit.toLowerCase() !== manifest.revision.toLowerCase()) {
  throw new Error(
    `Release manifest revision ${manifest.revision} does not match ${releaseRef} (${targetCommit})`,
  );
}

const previousCommit = await capture("git", ["rev-parse", "HEAD"]);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(
  repository,
  ".selfhost",
  "backups",
  `bootstrap-${timestamp}`,
);
const snapshotDir = path.join(
  repository,
  ".selfhost",
  "releases",
  `bootstrap-${timestamp}`,
);
await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
await fs.copyFile(envFile, path.join(snapshotDir, "env.selfhost"));
await fs.chmod(path.join(snapshotDir, "env.selfhost"), 0o600);
await fs.writeFile(
  path.join(snapshotDir, "runtime.json"),
  `${JSON.stringify(
    {
      schema: 1,
      createdAt: new Date().toISOString(),
      repositoryCommit: previousCommit,
      environmentFile: "env.selfhost",
      backupDirectory: options.skipBackup
        ? null
        : path.relative(repository, backupDir),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
await fs.copyFile(
  sourceManifest,
  path.join(snapshotDir, "target-manifest.json"),
);
await fs.chmod(path.join(snapshotDir, "target-manifest.json"), 0o600);
const handoffPath = path.join(snapshotDir, "upgrade-handoff.json");
await fs.writeFile(
  handoffPath,
  `${JSON.stringify(
    {
      schema: 1,
      targetRef: releaseRef,
      manifestFile: "target-manifest.json",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

if (!options.skipBackup) {
  await run(process.execPath, ["scripts/selfhost-backup.mjs", backupDir]);
  const backupManifestPath = path.join(backupDir, "manifest.json");
  const backupManifest = JSON.parse(
    await fs.readFile(backupManifestPath, "utf8"),
  );
  const declaredArchives = Array.isArray(backupManifest.volumes)
    ? backupManifest.volumes.map((entry) => entry?.archive)
    : [];
  if (declaredArchives.length === 0) {
    throw new Error(`Backup declared no volumes: ${backupManifestPath}`);
  }
  for (const archive of declaredArchives) {
    if (
      typeof archive !== "string" ||
      path.basename(archive) !== archive
    ) {
      throw new Error(`Invalid backup archive in ${backupManifestPath}`);
    }
    await requireFile(
      path.join(backupDir, archive),
      `declared backup archive ${archive}`,
    );
  }
}

try {
  await run("git", ["checkout", "--detach", targetCommit]);
} catch (error) {
  await fs.copyFile(path.join(snapshotDir, "env.selfhost"), envFile);
  await fs.chmod(envFile, 0o600);
  await run("git", ["checkout", "--detach", previousCommit]);
  throw error;
}

console.log(
  `Handing the apply phase to ${releaseRef}'s upgrade implementation.`,
);
// Do not automatically restore after this point. The target upgrader owns the
// D1 migration boundary and its matching runtime/volume rollback guidance.
await run(process.execPath, [
  "scripts/selfhost-upgrade.mjs",
  "--resume-upgrade",
  handoffPath,
]);

function parseArgs(argv) {
  const result = {
    repo: "",
    release: "",
    manifest: "",
    skipBackup: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-backup") {
      result.skipBackup = true;
      continue;
    }
    const match = /^--(repo|release|manifest)(?:=(.*))?$/.exec(arg);
    if (!match) usage(`Unknown argument: ${arg}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith("--")) {
      usage(`Missing value for --${match[1]}`);
    }
    result[match[1]] = value;
  }
  return result;
}

function required(value, name) {
  if (!value) usage(`Missing ${name}`);
  return value;
}

function usage(message) {
  console.error(message);
  console.error(
    "Usage: node selfhost-upgrade-bootstrap.mjs --repo <checkout> --release <git-ref> --manifest <selfhost-release.json> [--skip-backup]",
  );
  process.exit(2);
}

async function requireFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) throw new Error(`Missing ${label}: ${filePath}`);
}

async function capture(command, args) {
  const child = spawn(command, args, {
    cwd: repository,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(
      Buffer.concat(stderr).toString("utf8").trim() ||
        `${command} ${args.join(" ")} exited with ${code}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8").trim();
}

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: repository,
    env: process.env,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${code}`);
  }
}
