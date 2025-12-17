import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

const watchedPaths = [
  "src",
  "worker",
  "sandbox",
  "public",
  "next.config.ts",
  "open-next.config.ts",
  "wrangler.jsonc",
  "wrangler.build.jsonc",
  "package.json",
  "tsconfig.json",
];

let wranglerProcess = null;
let buildProcess = null;
let rebuildQueued = false;
let rebuildTimer = null;

function spawnCommand(command, args, { name }) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
  });
  return child;
}

function runBuild() {
  return new Promise((resolve) => {
    if (buildProcess) {
      rebuildQueued = true;
      resolve(false);
      return;
    }

    buildProcess = spawnCommand("npm", ["run", "build:cf"], { name: "build:cf" });
    buildProcess.on("exit", (code) => {
      buildProcess = null;
      const ok = code === 0;
      resolve(ok);

      if (rebuildQueued) {
        rebuildQueued = false;
        scheduleRebuild(50);
      }
    });
  });
}

function scheduleRebuild(delayMs = 250) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null;
    console.log("[dev] Rebuilding OpenNext bundle...");
    await runBuild();
  }, delayMs);
}

function startWrangler() {
  if (wranglerProcess) return;
  wranglerProcess = spawnCommand("wrangler", ["dev", "-c", "wrangler.jsonc", "--local"], {
    name: "wrangler dev",
  });
}

function watchForChanges() {
  const watchers = [];

  for (const watchedPath of watchedPaths) {
    const absolutePath = path.join(projectRoot, watchedPath);
    if (!fs.existsSync(absolutePath)) continue;

    try {
      const watcher = fs.watch(absolutePath, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          scheduleRebuild();
          return;
        }
        const file = filename.toString();
        if (file.includes("node_modules") || file.includes(".wrangler") || file.includes(".next") || file.includes(".open-next")) {
          return;
        }
        scheduleRebuild();
      });
      watchers.push(watcher);
    } catch (err) {
      console.warn(`[dev] Failed to watch ${watchedPath}: ${err?.message ?? err}`);
    }
  }

  const shutdown = () => {
    for (const watcher of watchers) watcher.close();
  };

  return shutdown;
}

function shutdown() {
  if (wranglerProcess) wranglerProcess.kill("SIGINT");
  if (buildProcess) buildProcess.kill("SIGINT");
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

const ok = await runBuild();
if (!ok) {
  console.warn("[dev] Initial OpenNext build failed; starting wrangler anyway. Fix build errors to continue.");
}

startWrangler();
watchForChanges();

