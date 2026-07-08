#!/usr/bin/env node
// Build the standalone notebook/file renderer SPA into public/notebook-renderer/
// and emit a manifest.json listing every built file. The manifest is what lets
// the notebook deploy path (workers/main/src/notebook-worker-bundle.ts) discover
// the hashed asset filenames through the worker's ASSETS binding at deploy time.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(repoRoot, "public", "notebook-renderer");

const build = spawnSync("bunx", ["vite", "build", "--config", "vite.renderer.config.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("[build-notebook-renderer] vite build failed");
  process.exit(build.status ?? 1);
}

function walk(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const absolute = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(absolute).isDirectory()) {
      files.push(...walk(absolute, relative));
    } else if (relative !== "manifest.json") {
      files.push(relative);
    }
  }
  return files;
}

const files = walk(outDir);
if (!files.includes("index.html")) {
  console.error("[build-notebook-renderer] build output is missing index.html");
  process.exit(1);
}
writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify({ files }, null, 2)}\n`);
console.log(`[build-notebook-renderer] wrote ${files.length} files + manifest.json to public/notebook-renderer/`);
