import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const desktopDir = resolve(import.meta.dirname, "..");
const guestDir = resolve(desktopDir, "guest");
const defaultImageRef =
  process.env.DESKTOP_GUEST_CONTROL_PLANE_IMAGE?.trim()
  || "vercantes/camelai-openwork:20260403-v2";
const allowedContextFiles = [
  ".dockerignore",
  "Dockerfile",
  "control-plane.mjs",
  "entrypoint.sh",
  "package.json",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    fail(
      result.stderr?.trim()
        || result.stdout?.trim()
        || `Command failed: ${command} ${args.join(" ")}`,
    );
  }
  return result;
}

function checkGuestContext() {
  const missingFiles = allowedContextFiles.filter(
    (file) => !existsSync(resolve(guestDir, file)),
  );
  if (missingFiles.length > 0) {
    fail(`Guest image context is missing required files: ${missingFiles.join(", ")}`);
  }

  const dockerignore = readFileSync(resolve(guestDir, ".dockerignore"), "utf8");
  for (const file of allowedContextFiles) {
    if (!dockerignore.includes(`!${file}`)) {
      fail(`desktop/guest/.dockerignore must explicitly allow ${file}`);
    }
  }

  return {
    contextDirectory: guestDir,
    includedFiles: allowedContextFiles.map((file) => resolve(guestDir, file)),
  };
}

function dockerDaemonAvailable() {
  const result = spawnSync("docker", ["info"], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const push = args.has("--push");
  const imageRef = defaultImageRef;

  const audit = checkGuestContext();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: push ? "publish" : "audit",
        imageRef: imageRef || null,
        contextDirectory: audit.contextDirectory,
        includedFiles: audit.includedFiles,
        note: "The guest image build context contains only the explicit allowlist above. Runtime auth and workspace data are mounted at container start and are not baked into the image.",
      },
      null,
      2,
    )}\n`,
  );

  if (!push) {
    return;
  }

  if (!dockerDaemonAvailable()) {
    fail("Docker is not reachable from this shell. Start Docker Desktop and log in to Docker Hub before publishing.");
  }

  run("docker", ["build", "-t", imageRef, guestDir]);
  run("docker", ["push", imageRef]);
}

main();
