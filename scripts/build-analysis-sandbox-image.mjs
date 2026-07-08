#!/usr/bin/env node
// Build camelai-analysis-sandbox:latest for the HOST architecture.
//
// Cloudflare publishes cloudflare/sandbox images for amd64 only. On Apple
// Silicon (or any arm64 Docker host) the amd64 image runs under Rosetta/QEMU,
// where the Jupyter kernel binds its sockets but never answers the client
// handshake ("Kernel didn't respond in N seconds"), so run_notebook — and every
// notebook eval — fails. The upstream Dockerfile is fully multi-arch, though:
// on arm64 hosts this script builds the python base variant from the pinned
// sandbox-sdk source tag and layers workers/main/analysis-sandbox.Dockerfile on
// top of it via SANDBOX_BASE_IMAGE. On amd64 hosts it builds directly from the
// published base image, same as before.
//
// Idempotent: exits fast when camelai-analysis-sandbox:latest already exists
// with the host's architecture. Pass --force to rebuild anyway.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ANALYSIS_IMAGE = "camelai-analysis-sandbox:latest";
const ANALYSIS_DOCKERFILE = "workers/main/analysis-sandbox.Dockerfile";
const SANDBOX_SDK_REPO = "https://github.com/cloudflare/sandbox-sdk.git";

const force = process.argv.includes("--force");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`[analysis-image] ${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The @cloudflare/sandbox version is pinned in the Dockerfile's default base
// tag; parse it so the source checkout can never drift from the base image.
function sandboxVersionFromDockerfile() {
  const dockerfile = readFileSync(ANALYSIS_DOCKERFILE, "utf8");
  const match = dockerfile.match(/cloudflare\/sandbox:(\d+\.\d+\.\d+)-python/);
  if (!match) {
    console.error(`[analysis-image] Could not find cloudflare/sandbox version pin in ${ANALYSIS_DOCKERFILE}`);
    process.exit(1);
  }
  return match[1];
}

const dockerArch = capture("docker", ["info", "--format", "{{.Architecture}}"]);
if (!dockerArch) {
  console.error("[analysis-image] docker is unavailable");
  process.exit(1);
}
const hostArch = /aarch64|arm64/.test(dockerArch) ? "arm64" : "amd64";
const existingArch = capture("docker", [
  "image",
  "inspect",
  ANALYSIS_IMAGE,
  "--format",
  "{{.Architecture}}",
]);

if (!force && existingArch === hostArch) {
  console.log(`[analysis-image] ${ANALYSIS_IMAGE} already built for ${hostArch}`);
  process.exit(0);
}
if (existingArch && existingArch !== hostArch) {
  console.log(
    `[analysis-image] ${ANALYSIS_IMAGE} is ${existingArch} but host is ${hostArch}; rebuilding natively`,
  );
}

const buildArgs = [];
if (hostArch === "arm64") {
  const version = sandboxVersionFromDockerfile();
  const baseImage = `cloudflare-sandbox-local:${version}-python`;
  const baseArch = capture("docker", ["image", "inspect", baseImage, "--format", "{{.Architecture}}"]);
  if (baseArch !== "arm64" || force) {
    const tag = `@cloudflare/sandbox@${version}`;
    const checkout = path.join(os.tmpdir(), `camelai-sandbox-sdk-${version}`);
    if (!existsSync(path.join(checkout, "packages", "sandbox", "Dockerfile"))) {
      mkdirSync(path.dirname(checkout), { recursive: true });
      console.log(`[analysis-image] Cloning sandbox-sdk ${tag}`);
      run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, SANDBOX_SDK_REPO, checkout]);
    }
    // Upstream hardcodes the standalone server binary to x64 Bun targets
    // (packages/sandbox-container/build.ts); retarget them so /container-server/
    // sandbox is a native arm64 binary instead of one Rosetta has to emulate.
    const buildTsPath = path.join(checkout, "packages", "sandbox-container", "build.ts");
    const buildTs = readFileSync(buildTsPath, "utf8");
    const patched = buildTs
      .replaceAll("bun-linux-x64-musl", "bun-linux-arm64-musl")
      .replaceAll("bun-linux-x64", "bun-linux-arm64");
    if (patched !== buildTs) {
      writeFileSync(buildTsPath, patched);
      console.log("[analysis-image] Retargeted sandbox-container build.ts to arm64 Bun binaries");
    } else if (!buildTs.includes("bun-linux-arm64")) {
      console.error("[analysis-image] Could not retarget build.ts to arm64 — upstream layout changed?");
      process.exit(1);
    }
    const bunVersionFile = path.join(checkout, ".bun-version");
    const bunVersion = existsSync(bunVersionFile)
      ? readFileSync(bunVersionFile, "utf8").trim()
      : "1";
    console.log(`[analysis-image] Building ${baseImage} from source for arm64 (one-time, ~10 min)`);
    run("docker", [
      "build",
      "--target",
      "python",
      "--build-arg",
      `BUN_VERSION=${bunVersion}`,
      "-t",
      baseImage,
      "-f",
      path.join(checkout, "packages", "sandbox", "Dockerfile"),
      checkout,
    ]);
  }
  buildArgs.push("--build-arg", `SANDBOX_BASE_IMAGE=${baseImage}`);
}

console.log(`[analysis-image] Building ${ANALYSIS_IMAGE} for ${hostArch}`);
run("docker", [
  "build",
  ...buildArgs,
  "-t",
  ANALYSIS_IMAGE,
  "-f",
  ANALYSIS_DOCKERFILE,
  "workers/main",
]);
console.log(`[analysis-image] Done`);
