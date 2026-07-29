#!/usr/bin/env node
import {
  composeArgs,
  readSelfhostEnv,
  run,
  scriptEnv,
} from "./selfhost-common.mjs";

const env = await readSelfhostEnv(true);
const sourceMode =
  (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
  "source";

await run("docker", composeArgs(env, [
  "up",
  ...(sourceMode ? ["--build"] : []),
]), {
  env: scriptEnv(env),
});
