#!/usr/bin/env node
import process from "node:process";
import {
  composeArgs,
  readSelfhostEnv,
  run,
  scriptEnv,
} from "./selfhost-common.mjs";

const skipBackup = process.argv.includes("--skip-backup");
const env = await readSelfhostEnv(true);

if (!skipBackup) {
  await run(process.execPath, ["scripts/selfhost-backup.mjs"], { env: scriptEnv(env) });
}

await run("docker", composeArgs(env, ["pull", "--ignore-pull-failures"]), {
  env: scriptEnv(env),
});
await run("docker", composeArgs(env, ["build"]), { env: scriptEnv(env) });
await run(process.execPath, ["scripts/selfhost-d1-migrate.mjs"], { env: scriptEnv(env) });
await run("docker", composeArgs(env, ["up", "-d", "--remove-orphans"]), {
  env: scriptEnv(env),
});
await run(process.execPath, ["scripts/selfhost-doctor.mjs"], { env: scriptEnv(env) });

console.log("Self-host upgrade completed.");

