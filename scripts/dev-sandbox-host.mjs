#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const sandboxHostDir = resolve(repoRoot, 'services/sandbox-host');
const dockerfilePath = resolve(repoRoot, 'services/sandbox-host/Dockerfile.sandbox');
const imageTag = (process.env.SANDBOX_IMAGE || 'chiridion-sandbox:latest').trim() || 'chiridion-sandbox:latest';
const localPersistRoot = resolve(repoRoot, '.sandbox-host');

const watchImage = process.env.SANDBOX_WATCH_IMAGE !== '0';
const watchDebounceMs = Number.parseInt(process.env.SANDBOX_WATCH_DEBOUNCE_MS || '1500', 10) || 1500;

let shuttingDown = false;
let goProc = null;
let buildInFlight = false;
let buildQueued = false;
let debounceTimer = null;

const watchTargets = [
  dockerfilePath,
  resolve(repoRoot, 'sandbox/control-plane.mjs'),
  resolve(repoRoot, 'sandbox/memory-logger.mjs'),
  resolve(repoRoot, 'sandbox/entrypoint.sh'),
  resolve(repoRoot, 'sandbox/skills'),
  resolve(repoRoot, 'sandbox/create-worker'),
];

function stripWrappingQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDevVarsFile(filePath) {
  if (!existsSync(filePath)) return {};

  const out = {};
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    out[key] = stripWrappingQuotes(rawValue ?? '');
  }
  return out;
}

function parseTfvarsFile(filePath) {
  if (!existsSync(filePath)) return {};

  const out = {};
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const withoutInlineComment = trimmed.split(/\s+#/)[0]?.trim() ?? trimmed;
    const match = withoutInlineComment.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    out[key] = stripWrappingQuotes(rawValue ?? '');
  }
  return out;
}

function loadTerraformVars() {
  const infraDir = resolve(repoRoot, 'infra');
  if (!existsSync(infraDir)) return {};

  const tfvarsPaths = [];
  const primary = resolve(infraDir, 'terraform.tfvars');
  if (existsSync(primary)) tfvarsPaths.push(primary);

  for (const name of readdirSync(infraDir)) {
    if (name.endsWith('.auto.tfvars')) {
      tfvarsPaths.push(resolve(infraDir, name));
    }
  }

  if (tfvarsPaths.length === 0) return {};

  const merged = {};
  for (const tfvarsPath of tfvarsPaths) {
    Object.assign(merged, parseTfvarsFile(tfvarsPath));
  }
  return merged;
}

function loadLocalEnvHints() {
  const devVars = parseDevVarsFile(resolve(repoRoot, '.dev.vars'));
  const tfVars = loadTerraformVars();
  return { devVars, tfVars };
}

function applyEnvFallback(env, key, candidate) {
  if (env[key]) return false;
  if (typeof candidate !== 'string') return false;
  const value = candidate.trim();
  if (!value) return false;
  env[key] = value;
  return true;
}

function spawnStreaming(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectPromise(new Error(`${command} ${args.join(' ')} failed (${detail})`));
    });
  });
}

async function buildImage(reason) {
  if (buildInFlight) {
    buildQueued = true;
    return;
  }
  buildInFlight = true;
  try {
    console.log(`[dev:sandbox-host] Building sandbox image (${reason}) -> ${imageTag}`);
    await spawnStreaming('docker', ['build', '-t', imageTag, '-f', dockerfilePath, '.'], { cwd: repoRoot });
    console.log(`[dev:sandbox-host] Image ready: ${imageTag}`);
  } catch (err) {
    console.error(`[dev:sandbox-host] Image build failed (${reason}):`, err instanceof Error ? err.message : String(err));
    if (reason === 'startup') {
      process.exitCode = 1;
      throw err;
    }
  } finally {
    buildInFlight = false;
    if (buildQueued && !shuttingDown) {
      buildQueued = false;
      void buildImage('queued-change');
    }
  }
}

function scheduleRebuild(event, filename, targetPath) {
  if (shuttingDown) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const changed = filename ? `${targetPath}:${filename}` : targetPath;
    void buildImage(`watch:${event}:${changed}`);
  }, watchDebounceMs);
}

function startWatchers() {
  if (!watchImage) {
    console.log('[dev:sandbox-host] Image watching disabled (set SANDBOX_WATCH_IMAGE=1 to enable).');
    return [];
  }

  const closeFns = [];

  for (const target of watchTargets) {
    if (!existsSync(target)) continue;

    const stat = statSync(target);
    try {
      const watcher = watch(
        target,
        stat.isDirectory() ? { recursive: true } : undefined,
        (event, filename) => scheduleRebuild(event, filename, target),
      );
      closeFns.push(() => watcher.close());
    } catch (err) {
      // Linux does not support recursive directory watching with fs.watch.
      if (stat.isDirectory()) {
        console.warn(`[dev:sandbox-host] Watch unsupported for directory ${target}. Re-run bun run dev:sandbox-host after image changes.`);
      } else {
        console.warn(`[dev:sandbox-host] Watch setup failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (closeFns.length > 0) {
    console.log('[dev:sandbox-host] Watching sandbox image inputs for rebuilds.');
  }
  return closeFns;
}

function stopGoProcess(signal = 'SIGTERM') {
  if (!goProc || goProc.killed) return;
  goProc.kill(signal);
}

async function main() {
  await buildImage('startup');

  const closeWatchers = startWatchers();

  const env = { ...process.env, SANDBOX_IMAGE: imageTag };
  const { devVars, tfVars } = loadLocalEnvHints();

  if (!env.WORKSPACES_ROOT) env.WORKSPACES_ROOT = resolve(localPersistRoot, 'workspaces');
  if (!env.SANDBOX_HOST_STATE_DB) env.SANDBOX_HOST_STATE_DB = resolve(localPersistRoot, 'state.db');

  const loadedSandboxProxyFromDevVars = applyEnvFallback(env, 'SANDBOX_PROXY_SECRET', devVars.SANDBOX_PROXY_SECRET);
  const loadedSandboxProxyFromTfvars = !loadedSandboxProxyFromDevVars
    && applyEnvFallback(env, 'SANDBOX_PROXY_SECRET', tfVars.sandbox_proxy_secret);

  const r2KeyMappings = [
    ['CF_API_TOKEN', 'cf_api_token'],
    ['R2_ACCESS_KEY_ID', 'r2_access_key_id'],
    ['R2_SECRET_ACCESS_KEY', 'r2_secret_access_key'],
    ['R2_ACCOUNT_ID', 'r2_account_id'],
    ['R2_BUCKET_NAME', 'r2_bucket_name'],
  ];

  let loadedR2FromDevVars = false;
  let loadedR2FromTfvars = false;
  for (const [envKey, tfKey] of r2KeyMappings) {
    if (applyEnvFallback(env, envKey, devVars[envKey])) {
      loadedR2FromDevVars = true;
      continue;
    }
    if (applyEnvFallback(env, envKey, tfVars[tfKey])) {
      loadedR2FromTfvars = true;
    }
  }

  if (loadedSandboxProxyFromDevVars) {
    console.log('[dev:sandbox-host] Loaded SANDBOX_PROXY_SECRET from .dev.vars');
  } else if (loadedSandboxProxyFromTfvars) {
    console.log('[dev:sandbox-host] Loaded SANDBOX_PROXY_SECRET from infra tfvars');
  }

  if (loadedR2FromDevVars) {
    console.log('[dev:sandbox-host] Loaded R2_* mount credentials from .dev.vars');
  } else if (loadedR2FromTfvars) {
    console.log('[dev:sandbox-host] Loaded R2_* mount credentials from infra tfvars');
  }
  if (!env.SANDBOX_PROXY_SECRET) {
    console.warn('[dev:sandbox-host] SANDBOX_PROXY_SECRET is not set; proxy calls from sandbox to worker will fail.');
  }
  const hasAllR2Vars = Boolean(env.CF_API_TOKEN && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME);
  if (!hasAllR2Vars) {
    console.warn('[dev:sandbox-host] R2 credential vars are incomplete; containers will start without R2 mounts.');
  }

  goProc = spawn('go', ['run', './cmd/sandbox-host'], {
    cwd: sandboxHostDir,
    stdio: 'inherit',
    env,
  });

  const shutdown = (signalName) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const close of closeWatchers) close();
    console.log(`[dev:sandbox-host] Shutting down (${signalName})`);
    stopGoProcess('SIGTERM');
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  goProc.on('exit', (code, signal) => {
    for (const close of closeWatchers) close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (signal) {
      process.exitCode = 0;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

main().catch((err) => {
  console.error('[dev:sandbox-host] fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
