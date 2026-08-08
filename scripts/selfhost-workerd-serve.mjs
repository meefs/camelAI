#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { startSelfhostLoopbackServer } from './selfhost-loopback-server.mjs';

const repoRoot = process.cwd();
const configPath = path.resolve(
  repoRoot,
  process.env.SELFHOST_WORKERD_CONFIG ?? '.selfhost/workerd/camelai.capnp',
);
const manifestPath = path.join(path.dirname(configPath), 'manifest.json');
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

let loopbackServer;
try {
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  if (manifest?.loopback?.mode === 'external') {
    loopbackServer = await startSelfhostLoopbackServer({
      hostname: manifest.loopback.hostname ?? '127.0.0.1',
    });
    console.log(
      `[selfhost:workerd] Local bindings loopback on http://${loopbackServer.hostname}:${loopbackServer.port}`,
    );
  }

  const args = ['serve', configPath, 'camelai', '--experimental'];
  if (process.env.SELFHOST_WORKERD_SOCKET) {
    args.push(`--socket-addr=http=${process.env.SELFHOST_WORKERD_SOCKET}`);
  }
  if (loopbackServer) {
    args.push(`--external-addr=loopback=${loopbackServer.hostname}:${loopbackServer.port}`);
  }

  const child = spawn(workerdPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const shutdown = async (signal) => {
    if (!child.killed) child.kill(signal);
    if (loopbackServer) {
      await loopbackServer.close().catch((error) => {
        console.error('[selfhost:workerd] Failed to close local bindings loopback', error);
      });
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  child.on('exit', async (code, signal) => {
    if (loopbackServer) {
      await loopbackServer.close().catch(() => {});
    }
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} catch (error) {
  if (loopbackServer) {
    await loopbackServer.close().catch(() => {});
  }
  console.error(error);
  process.exit(1);
}
