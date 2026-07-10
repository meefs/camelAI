#!/usr/bin/env node

import process from 'node:process';
import {
  composeArgs,
  readSelfhostEnv,
  run,
  scriptEnv,
} from './selfhost-common.mjs';

async function main() {
  const env = await readSelfhostEnv(true);
  console.log('[selfhost:workerd] Starting Docker Compose workerd stack');
  await run('docker', composeArgs(env, [
    'up',
    '--build',
    'app',
  ]), { env: scriptEnv(env) });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
