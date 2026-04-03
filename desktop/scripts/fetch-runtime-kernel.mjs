import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const assetsDirectory = resolve(desktopDirectory, "runtime-helper/assets");
const kernelPath = resolve(assetsDirectory, "vmlinux");
const archivePath = resolve(assetsDirectory, "kata-static-3.17.0-arm64.tar.xz");
const extractionDirectory = resolve(assetsDirectory, "kata-extract");
const kernelArchiveUrl =
  process.env.DESKTOP_RUNTIME_KERNEL_ARCHIVE_URL ||
  "https://github.com/kata-containers/kata-containers/releases/download/3.17.0/kata-static-3.17.0-arm64.tar.xz";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

mkdirSync(assetsDirectory, { recursive: true });

if (existsSync(kernelPath) && process.env.DESKTOP_FORCE_FETCH_RUNTIME_KERNEL !== "1") {
  process.exit(0);
}

if (!existsSync(archivePath) || process.env.DESKTOP_FORCE_FETCH_RUNTIME_KERNEL === "1") {
  run("/usr/bin/curl", ["-fL", "-o", archivePath, kernelArchiveUrl]);
}

rmSync(extractionDirectory, { recursive: true, force: true });
mkdirSync(extractionDirectory, { recursive: true });
run("/usr/bin/python3", [
  "-c",
  `
import sys, tarfile
archive_path, destination = sys.argv[1], sys.argv[2]
with tarfile.open(archive_path, mode="r:xz") as archive:
    archive.extractall(path=destination)
`,
  archivePath,
  extractionDirectory,
]);

run("/bin/cp", [
  "-L",
  resolve(
    extractionDirectory,
    "opt/kata/share/kata-containers/vmlinux.container",
  ),
  kernelPath,
]);

rmSync(extractionDirectory, { recursive: true, force: true });
