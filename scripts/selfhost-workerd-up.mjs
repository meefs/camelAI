#!/usr/bin/env node

import process from 'node:process';
import {
  composeArgs,
  readSelfhostEnv,
  run,
  scriptEnv,
} from './selfhost-common.mjs';
import { writePomeriumConfig } from './selfhost-pomerium-config.mjs';

async function main() {
  const env = await readSelfhostEnv(true);
  await writePomeriumConfig(env);
  const sourceMode =
    (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
    'source';
  console.log('[selfhost:workerd] Starting Docker Compose workerd stack');
  await run('docker', composeArgs(env, [
    'up',
    ...(sourceMode ? ['--build'] : []),
    'app',
  ]), { env: scriptEnv(env) });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
