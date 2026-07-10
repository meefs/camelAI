#!/usr/bin/env node
import {
  composeArgs,
  readSelfhostEnv,
  run,
  scriptEnv,
} from "./selfhost-common.mjs";

const env = await readSelfhostEnv(true);

await run("docker", composeArgs(env, [
  "up",
  "--build",
]), {
  env: scriptEnv(env),
});
