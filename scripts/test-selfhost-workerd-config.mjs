#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includesAll(actual, expected, label) {
  for (const item of expected) {
    assert(actual.includes(item), `${label} is missing ${item}`);
  }
}

async function main() {
  const wranglerPath = path.join(repoRoot, 'build/server/wrangler.json');
  await fs.access(wranglerPath).catch(() => {
    throw new Error('Missing build/server/wrangler.json. Run `bun run build:cf` first.');
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camelai-workerd-config-test-'));
  const outPath = path.join(tempDir, 'camelai.capnp');
  const stateDir = path.join(tempDir, 'state');
  const result = spawnSync(process.execPath, [
    'scripts/selfhost-workerd-config.mjs',
    '--out',
    outPath,
    '--state-dir',
    stateDir,
    '--socket',
    '127.0.0.1:0',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SELFHOST_AI_PROVIDER: 'bedrock',
      SELFHOST_AI_API_KEY: 'test-bedrock-key',
      SELFHOST_AI_AWS_REGION: 'us-east-1',
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(tempDir, 'manifest.json'), 'utf8'));
  const config = await fs.readFile(outPath, 'utf8');
  const bindings = manifest.bindings;

  assert(manifest.source === 'build/server/wrangler.json', 'manifest should use the built Wrangler config');
  includesAll(bindings.vars, [
    'LOCAL_ARTIFACTS_BASE_URL',
    'LOCAL_ARTIFACTS_SECRET',
    'PROJECT_RUNTIME_SERVICE_URL',
    'PROJECT_RUNTIME_PROXY_SECRET',
    'WORKER_BASE_URL',
    'LOCAL_APP_VANITY_DOMAIN',
  ], 'vars');
  assert(!bindings.vars.includes('PROJECT_REPO_PROVIDER'), 'PROJECT_REPO_PROVIDER must not be a self-host var');
  assert(!bindings.vars.includes('R2_PARENT_ACCESS_KEY_ID'), 'Cloudflare dev R2 credentials must not leak into self-host vars');

  includesAll(bindings.durableObjects, ['ChatThreadDO', 'WorkspaceDO', 'WorkspaceFilesystemDO'], 'durableObjects');
  includesAll(bindings.kv, ['EMAIL_TO_USER', 'APP_KV', 'SESSIONS'], 'kv');
  includesAll(bindings.r2, ['R2_BUCKET', 'BACKUP_BUCKET'], 'r2');
  includesAll(bindings.d1, ['APP_DB'], 'd1');
  includesAll(bindings.queues, ['APP_SCREENSHOT_QUEUE', 'SLACK_EVENTS_QUEUE'], 'queues');
  includesAll(bindings.workflows, ['DETERMINISTIC_AUTOMATION_WORKFLOWS', 'LEGACY_WORKSPACE_MIGRATIONS'], 'workflows');
  includesAll(bindings.artifacts, ['ARTIFACTS'], 'artifacts');
  includesAll(bindings.ai, ['AI'], 'ai');
  includesAll(bindings.workerLoaders, ['CODE_MODE_LOADER', 'SELFHOST_WORKER_LOADER'], 'workerLoaders');
  assert(!bindings.workerLoaders.includes('LOADER'), 'dispatcher must not include the obsolete generic local Dynamic Worker loader');
  includesAll(manifest.omittedBindings.sendEmail, ['EMAIL'], 'omitted sendEmail bindings');

  assert(manifest.dispatcherServiceName === 'dispatcher', 'manifest should include dispatcher service');
  assert(config.includes('name = "ARTIFACTS"'), 'config should contain ARTIFACTS binding');
  assert(config.includes('name = "AI"'), 'config should contain AI binding');
  assert(config.includes('infra/selfhost/ai-binding.worker.js'), 'config should embed the self-host AI binding module');
  assert(config.includes('name = "dispatcher"'), 'config should contain dispatcher service');
  assert(config.includes('name = "SELFHOST_WORKER_LOADER"'), 'config should contain self-host worker loader binding');
  assert(config.includes('name = "SELFHOST_APP_RUNNER"'), 'config should contain self-host app runner binding');
  assert(config.includes('SelfhostAppRunner'), 'config should contain self-host app runner DO');
  assert(!config.includes('workerLoader = (id = "local-dynamic")'), 'config must not contain a local Dynamic Workers loader');
  assert(!config.includes('LocalDynamicAppRunner'), 'config must not contain local Dynamic Workers app runner DO');
  assert(config.includes('infra/selfhost/artifacts-binding.worker.js'), 'config should embed the local Artifacts binding module');
  assert(config.includes('workflows:local-wrapped-binding'), 'config should contain local Workflows wrapped binding');
  assert(config.includes('name = "BROWSER"'), 'config should contain BROWSER binding');
  assert(config.includes('browser-rendering:service'), 'config should contain Miniflare browser rendering service');
  assert(config.includes('name = "loopback", external = (http = ()))'), 'config should use external loopback for browser rendering');
  assert(config.includes('name = "local", network = (allow = ["local"]'), 'config should expose local outbound for Chrome');
  assert(manifest.loopback?.mode === 'external', 'manifest should request external loopback for browser rendering');
  includesAll(bindings.browser ?? [], ['BROWSER'], 'browser');
  assert(config.includes('selfhost-app-db'), 'config should contain self-host D1 database id');
  assert(config.includes('chiridion-selfhost-deterministic-automations'), 'config should contain self-host workflow names');
  assert(!config.includes('PROJECT_REPO_PROVIDER'), 'config must not contain PROJECT_REPO_PROVIDER');

  console.log('Self-host workerd config test passed.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
