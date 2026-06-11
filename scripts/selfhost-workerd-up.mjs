#!/usr/bin/env node

import process from 'node:process';
import {
  composeArgs,
  readSelfhostEnv,
  run,
  runtimeImageDockerfile,
  runtimeServiceDir,
  scriptEnv,
} from './selfhost-common.mjs';

async function main() {
  const env = await readSelfhostEnv(true);
  const runtimeDir = runtimeServiceDir(env);
  console.log(`[selfhost:workerd] Building project runtime image from ${runtimeDir}`);
  await run('docker', [
    'build',
    '-t',
    env.PROJECT_RUNTIME_IMAGE || process.env.PROJECT_RUNTIME_IMAGE || 'project-runtime-basic:latest',
    '-f',
    runtimeImageDockerfile(env),
    runtimeDir,
  ], { env: scriptEnv(env) });

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
