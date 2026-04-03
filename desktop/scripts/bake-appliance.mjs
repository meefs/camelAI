import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..", "..");
const vmLocalDirectory = resolve(repoRoot, "desktop/.local/vm");
const sourceBaseDiskPath =
  process.env.DESKTOP_VM_BASE_IMAGE_PATH ||
  resolve(vmLocalDirectory, "base.raw");
const sourceBaseImageUrl =
  process.env.DESKTOP_VM_BASE_IMAGE_URL ||
  "https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-arm64.img";
const targetApplianceDiskPath = resolve(vmLocalDirectory, "disk.raw");

function runOrThrow(command, args, { input, env } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    input,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `${command} failed`;
    throw new Error(detail);
  }
  return result;
}

function ensureBaseDisk() {
  if (existsSync(sourceBaseDiskPath)) {
    return;
  }

  const downloadedQcowPath = resolve(vmLocalDirectory, "base-download.img");
  rmSync(downloadedQcowPath, { force: true });
  runOrThrow("mkdir", ["-p", vmLocalDirectory]);
  runOrThrow("curl", ["-fL", sourceBaseImageUrl, "-o", downloadedQcowPath]);
  runOrThrow("qemu-img", [
    "convert",
    "-f",
    "qcow2",
    "-O",
    "raw",
    downloadedQcowPath,
    sourceBaseDiskPath,
  ]);
  runOrThrow("qemu-img", ["resize", "-f", "raw", sourceBaseDiskPath, "64G"]);
  rmSync(downloadedQcowPath, { force: true });
}

const bakeVmDirectory = mkdtempSync(join(tmpdir(), "camelai-appliance-bake-"));
const bakeRuntimeStatusPath = resolve(bakeVmDirectory, "shared/runtime/status.txt");
const bakeSentinelPath = resolve(bakeVmDirectory, "shared/runtime/appliance-baked");
const bakedDiskPath = resolve(bakeVmDirectory, "disk.raw");

ensureBaseDisk();

process.env.DESKTOP_VM_DIR = bakeVmDirectory;
process.env.DESKTOP_VM_APPLIANCE_IMAGE_PATH = sourceBaseDiskPath;
process.env.DESKTOP_VM_BAKE_APPLIANCE = "1";

const { VmManager } = await import("../backend/vm.ts");
const vm = new VmManager();

let lastStatusLine = "";

function logStatus(status) {
  const line = JSON.stringify({
    state: status.state,
    detail: status.detail,
  });
  if (line === lastStatusLine) {
    return;
  }
  lastStatusLine = line;
  console.log(line);
}

function readBakeStatus() {
  if (!existsSync(bakeRuntimeStatusPath)) {
    return "";
  }
  return readFileSync(bakeRuntimeStatusPath, "utf8").trim();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBakeCompletion(timeoutMs = 10 * 60_000) {
  const startedAt = Date.now();
  let lastBakeStatus = "";

  while (Date.now() - startedAt < timeoutMs) {
    const helperStatus = await vm.getStatus();
    logStatus(helperStatus);

    const bakeStatus = readBakeStatus();
    if (bakeStatus && bakeStatus !== lastBakeStatus) {
      lastBakeStatus = bakeStatus;
      console.log(JSON.stringify({ bakeStatus }));
    }

    if (existsSync(bakeSentinelPath) || bakeStatus === "appliance-baked") {
      return;
    }

    if (helperStatus.state === "error" || helperStatus.state === "unavailable") {
      throw new Error(helperStatus.detail);
    }

    await sleep(1000);
  }

  throw new Error("Timed out waiting for appliance bake to complete.");
}

try {
  logStatus(await vm.prepareRuntime());
  logStatus(await vm.startRuntime());
  await waitForBakeCompletion();
  logStatus(await vm.stopRuntime());

  if (!existsSync(bakedDiskPath)) {
    throw new Error(`Baked appliance disk missing: ${bakedDiskPath}`);
  }

  cpSync(bakedDiskPath, targetApplianceDiskPath, { force: true });

  console.log(
    JSON.stringify({
      baked: true,
      baseDiskPath: sourceBaseDiskPath,
      applianceDiskPath: targetApplianceDiskPath,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      baked: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await vm.stopRuntime();
  } catch {
    // Best-effort cleanup only.
  }
  vm.dispose();
  rmSync(bakeVmDirectory, { recursive: true, force: true });
}
