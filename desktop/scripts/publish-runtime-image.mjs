import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const controlPlaneDir = resolve(repoRoot, "desktop/control-plane");
const imageRef =
  process.env.DESKTOP_RUNTIME_IMAGE?.trim() ||
  "docker.io/vercantes/camelai-openwork:20260403-v3";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const relativePath of [
  "Dockerfile",
  ".dockerignore",
  "entrypoint.sh",
  "control-plane.mjs",
  "package.json",
  "package-lock.json",
]) {
  if (!existsSync(resolve(controlPlaneDir, relativePath))) {
    fail(`Runtime image context is missing ${relativePath}`);
  }
}

run("docker", ["build", "-t", imageRef, controlPlaneDir]);
run("docker", ["push", imageRef]);
