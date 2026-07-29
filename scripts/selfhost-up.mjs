#!/usr/bin/env node
import {
  composeArgs,
  readSelfhostEnv,
  run,
  scriptEnv,
} from "./selfhost-common.mjs";
import { writePomeriumConfig } from "./selfhost-pomerium-config.mjs";

const env = await readSelfhostEnv(true);
await writePomeriumConfig(env);
const sourceMode =
  (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
  "source";

await run("docker", composeArgs(env, [
  "up",
  ...(sourceMode ? ["--build"] : []),
]), {
  env: scriptEnv(env),
});
