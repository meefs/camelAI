#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "bun";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outfileArg = process.argv[2];
if (!outfileArg) {
  console.error("Usage: bun scripts/build-selfhost-dispatcher.mjs <outfile>");
  process.exit(2);
}

const outfile = path.resolve(repoRoot, outfileArg);
const runnerPath = path.join(
  repoRoot,
  "workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs",
);
const runnerSource = await fs.readFile(runnerPath, "utf8");

await fs.mkdir(path.dirname(outfile), { recursive: true });
const result = await build({
  entrypoints: [path.join(repoRoot, "workers/dispatcher/src/index.ts")],
  outdir: path.dirname(outfile),
  naming: path.basename(outfile),
  target: "browser",
  format: "esm",
  external: ["cloudflare:workers"],
  plugins: [
    {
      name: "selfhost-db-query-runner-source",
      setup(builder) {
        builder.onResolve(
          { filter: /^virtual:db-query-runner-source$/ },
          () => ({
            path: "db-query-runner-source",
            namespace: "selfhost-virtual",
          }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "selfhost-virtual" },
          () => ({
            contents: `export default ${JSON.stringify(runnerSource)};`,
            loader: "js",
          }),
        );
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
