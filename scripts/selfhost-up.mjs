#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  composeArgs,
  readSelfhostEnv,
  repoRoot,
  run,
  runtimeImageDockerfile,
  runtimeServiceDir,
  scriptEnv,
} from "./selfhost-common.mjs";

const env = await readSelfhostEnv(true);
const runtimeDir = runtimeServiceDir(env);

if (!existsSync(path.join(runtimeDir, "go.mod"))) {
  console.error(`Project runtime service not found at ${runtimeDir}`);
  console.error("Set PROJECT_RUNTIME_SERVICE_DIR to the project-runtime-service checkout.");
  process.exit(1);
}

await run("docker", [
  "build",
  "-t",
  env.PROJECT_RUNTIME_IMAGE || process.env.PROJECT_RUNTIME_IMAGE || "project-runtime-basic:latest",
  "-f",
  runtimeImageDockerfile(env),
  runtimeDir,
], {
  env: scriptEnv(env),
});

await run("docker", composeArgs(env, [
  "up",
  "--build",
]), {
  env: scriptEnv(env),
});
