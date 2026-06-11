#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const configPath = path.resolve(
  repoRoot,
  process.env.SELFHOST_WORKERD_CONFIG ?? '.selfhost/workerd/camelai.capnp',
);
const workerdPath = path.resolve(repoRoot, 'node_modules/workerd/bin/workerd');

if (!fs.existsSync(configPath)) {
  console.error(`Missing generated workerd config: ${path.relative(repoRoot, configPath)}`);
  console.error('Run `bun run selfhost:workerd:build` first.');
  process.exit(1);
}

if (!fs.existsSync(workerdPath)) {
  console.error('Missing workerd binary. Run `bun install` first.');
  process.exit(1);
}

if (process.env.SELFHOST_SKIP_D1_MIGRATIONS !== '1') {
  const result = spawnSync(process.execPath, ['scripts/selfhost-d1-migrate.mjs'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const args = ['serve', configPath, 'camelai', '--experimental'];
if (process.env.SELFHOST_WORKERD_SOCKET) {
  args.push(`--socket-addr=http=${process.env.SELFHOST_WORKERD_SOCKET}`);
}

const child = spawn(workerdPath, args, {
  cwd: repoRoot,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
