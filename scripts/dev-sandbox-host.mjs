#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const sandboxHostDir = resolve(repoRoot, 'services/sandbox-host');
const dockerfilePath = resolve(repoRoot, 'services/sandbox-host/Dockerfile.sandbox');
const configuredImageTag = (process.env.SANDBOX_IMAGE || 'chiridion-sandbox:latest').trim() || 'chiridion-sandbox:latest';
const imageVersion = (process.env.SANDBOX_IMAGE_VERSION || '').trim();
const imageTag = process.env.SANDBOX_IMAGE
  ? configuredImageTag
  : (imageVersion ? `chiridion-sandbox:${imageVersion}` : configuredImageTag);
const localPersistRoot = resolve(repoRoot, '.sandbox-host');
const localHostPiRoot = resolve(localPersistRoot, 'host-pi');
const localHostPiPackagePath = resolve(localHostPiRoot, 'package.json');
const localHostPiBinPath = resolve(localHostPiRoot, 'node_modules/.bin/pi');
const localHostPiExtensionDir = resolve(localHostPiRoot, 'extensions');
const localHostPiExtensionPath = resolve(localHostPiExtensionDir, 'container-tools.ts');
const localHostPiSkillsPath = resolve(localHostPiRoot, 'skills');
const sourceHostPiExtensionPath = resolve(repoRoot, 'services/sandbox-host/pi/container-tools.ts');
const sourceHostPiSkillsPath = resolve(repoRoot, 'sandbox/skills');
const piCodingAgentVersion = (process.env.PI_CODING_AGENT_VERSION || '0.73.0').trim() || '0.73.0';
const typeboxVersion = (process.env.TYPEBOX_VERSION || '1.1.37').trim() || '1.1.37';

const watchImage = process.env.SANDBOX_WATCH_IMAGE !== '0';
const watchDebounceMs = Number.parseInt(process.env.SANDBOX_WATCH_DEBOUNCE_MS || '1500', 10) || 1500;
const buildNoCache = process.env.SANDBOX_BUILD_NO_CACHE === '1';
const skipImageBuild = process.env.SANDBOX_SKIP_IMAGE_BUILD === '1';

let shuttingDown = false;
let sandboxHostProc = null;
let dataProxyProc = null;
let buildInFlight = false;
let buildQueued = false;
let debounceTimer = null;

const watchTargets = [
  dockerfilePath,
  resolve(repoRoot, 'sandbox/memory-logger.mjs'),
  resolve(repoRoot, 'sandbox/entrypoint.sh'),
  resolve(repoRoot, 'sandbox/skills'),
  resolve(repoRoot, 'sandbox/create-worker'),
  resolve(repoRoot, 'sandbox/create-worker/renderer'),
  resolve(repoRoot, 'src/components/chat-file-preview'),
  resolve(repoRoot, 'src/styles/globals.css'),
  resolve(repoRoot, 'vite.renderer.config.ts'),
];
const ignoredWatchPathSegments = [
  `${resolve(repoRoot, 'sandbox/create-worker/renderer-dist')}/`,
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

async function buildRenderer() {
  console.log('[dev:sandbox-host] Building renderer bundle...');
  await spawnStreaming('bun', ['run', 'build:renderer'], { cwd: repoRoot });
}

async function buildImage(reason) {
  if (buildInFlight) {
    buildQueued = true;
    return;
  }
  buildInFlight = true;
  try {
    await buildRenderer();
    console.log(`[dev:sandbox-host] Building sandbox image (${reason}) -> ${imageTag}`);
    const args = ['build', '-t', imageTag, '-f', dockerfilePath];
    if (buildNoCache) {
      args.push('--no-cache');
    }
    args.push('.');
    await spawnStreaming('docker', args, { cwd: repoRoot });
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

async function ensureLocalHostPi() {
  mkdirSync(localHostPiExtensionDir, { recursive: true });
  writeFileSync(localHostPiPackagePath, JSON.stringify({
    name: 'chiridion-local-host-pi',
    private: true,
    type: 'module',
    dependencies: {
      '@mariozechner/pi-coding-agent': piCodingAgentVersion,
      typebox: typeboxVersion,
    },
  }, null, 2) + '\n');
  copyFileSync(sourceHostPiExtensionPath, localHostPiExtensionPath);
  cpSync(sourceHostPiSkillsPath, localHostPiSkillsPath, { recursive: true });

  console.log(`[dev:sandbox-host] Installing local host Pi into ${localHostPiRoot}...`);
  await spawnStreaming('npm', ['install', '--prefix', localHostPiRoot, '--omit=dev', '--loglevel=warn'], {
    cwd: repoRoot,
  });
}

function scheduleRebuild(event, filename, targetPath) {
  if (shuttingDown) return;
  const changedPath = filename
    ? resolve(targetPath, String(filename))
    : targetPath;
  if (ignoredWatchPathSegments.some((ignored) => `${changedPath}/`.startsWith(ignored))) {
    return;
  }
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

function stopGoProcesses(signal = 'SIGTERM') {
  if (sandboxHostProc && !sandboxHostProc.killed) {
    sandboxHostProc.kill(signal);
  }
  if (dataProxyProc && !dataProxyProc.killed) {
    dataProxyProc.kill(signal);
  }
}

async function main() {
  if (!process.env.SANDBOX_IMAGE && imageVersion) {
    console.log(`[dev:sandbox-host] Using versioned local sandbox image tag: ${imageTag}`);
  }
  if (buildNoCache) {
    console.log('[dev:sandbox-host] Docker build cache disabled (SANDBOX_BUILD_NO_CACHE=1).');
  }
  if (skipImageBuild) {
    console.log(`[dev:sandbox-host] Skipping sandbox image build; using existing ${imageTag}.`);
  } else {
    await buildImage('startup');
  }

  const closeWatchers = skipImageBuild ? [] : startWatchers();

  const env = { ...process.env, SANDBOX_IMAGE: imageTag };
  const { devVars, tfVars } = loadLocalEnvHints();

  if (!env.WORKSPACES_ROOT) env.WORKSPACES_ROOT = resolve(localPersistRoot, 'workspaces');
  if (!env.SANDBOX_HOST_STATE_DB) env.SANDBOX_HOST_STATE_DB = resolve(localPersistRoot, 'state.db');
  if (!env.GODEBUG) {
    env.GODEBUG = 'netdns=go';
  } else if (!env.GODEBUG.split(',').some((entry) => entry.trim().startsWith('netdns='))) {
    env.GODEBUG = `${env.GODEBUG},netdns=go`;
  }

  await ensureLocalHostPi();
  if (!env.HOST_PI_PATH) env.HOST_PI_PATH = localHostPiBinPath;
  if (!env.HOST_PI_EXTENSION_PATH) env.HOST_PI_EXTENSION_PATH = localHostPiExtensionPath;
  if (!env.HOST_PI_SKILLS_PATH) env.HOST_PI_SKILLS_PATH = localHostPiSkillsPath;
  if (!env.HOST_PI_SESSION_ROOT) env.HOST_PI_SESSION_ROOT = resolve(localPersistRoot, 'pi-sessions');
  console.log(`[dev:sandbox-host] Host Pi runner enabled (${env.HOST_PI_PATH})`);

  const loadedSandboxProxyFromDevVars = applyEnvFallback(env, 'SANDBOX_PROXY_SECRET', devVars.SANDBOX_PROXY_SECRET);
  const loadedSandboxProxyFromTfvars = !loadedSandboxProxyFromDevVars
    && applyEnvFallback(env, 'SANDBOX_PROXY_SECRET', tfVars.sandbox_proxy_secret);

  const r2KeyMappings = [
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

  const gatewayMappings = [
    ['CF_ACCOUNT_ID', 'cf_account_id'],
    ['CF_GATEWAY_NAME', 'cf_gateway_name'],
    ['CF_GATEWAY_TOKEN', 'cf_gateway_token'],
    ['OPENAI_PROXY_UPSTREAM_URL', 'openai_proxy_upstream_url'],
    ['OPENAI_PROXY_AUTH_TOKEN', 'openai_proxy_auth_token'],
  ];
  let loadedGatewayFromDevVars = false;
  let loadedGatewayFromTfvars = false;
  for (const [envKey, tfKey] of gatewayMappings) {
    if (applyEnvFallback(env, envKey, devVars[envKey])) {
      loadedGatewayFromDevVars = true;
      continue;
    }
    if (applyEnvFallback(env, envKey, tfVars[tfKey])) {
      loadedGatewayFromTfvars = true;
    }
  }

  const webProviderMappings = [
    ['FIRECRAWL_API_KEY', 'firecrawl_api_key'],
    ['PARALLEL_API_KEY', 'parallel_api_key'],
    ['EXA_API_KEY', 'exa_api_key'],
  ];
  const loadedWebProvidersFromDevVars = [];
  const loadedWebProvidersFromTfvars = [];
  for (const [envKey, tfKey] of webProviderMappings) {
    if (applyEnvFallback(env, envKey, devVars[envKey])) {
      loadedWebProvidersFromDevVars.push(envKey);
      continue;
    }
    if (applyEnvFallback(env, envKey, tfVars[tfKey])) {
      loadedWebProvidersFromTfvars.push(envKey);
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
  if (loadedGatewayFromDevVars) {
    console.log('[dev:sandbox-host] Loaded AI Gateway vars from .dev.vars');
  } else if (loadedGatewayFromTfvars) {
    console.log('[dev:sandbox-host] Loaded AI Gateway vars from infra tfvars');
  }
  if (loadedWebProvidersFromDevVars.length > 0) {
    console.log(`[dev:sandbox-host] Loaded web provider vars from .dev.vars: ${loadedWebProvidersFromDevVars.join(', ')}`);
  }
  if (loadedWebProvidersFromTfvars.length > 0) {
    console.log(`[dev:sandbox-host] Loaded web provider vars from infra tfvars: ${loadedWebProvidersFromTfvars.join(', ')}`);
  }
  if (!env.SANDBOX_PROXY_SECRET) {
    console.warn('[dev:sandbox-host] SANDBOX_PROXY_SECRET is not set; proxy calls from sandbox to worker will fail.');
  }
  const hasAllR2Vars = Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME);
  if (!hasAllR2Vars) {
    console.warn('[dev:sandbox-host] R2 credential vars are incomplete; containers will start without R2 mounts.');
  }
  if (!env.OPENAI_PROXY_AUTH_TOKEN && !env.CF_GATEWAY_TOKEN) {
    console.warn('[dev:sandbox-host] OPENAI proxy auth token is not set; OPENAI proxy requests will fail.');
  }
  if (!env.FIRECRAWL_API_KEY && !env.PARALLEL_API_KEY && !env.EXA_API_KEY) {
    console.warn('[dev:sandbox-host] No web provider API key is set; WebSearch/WebFetch will fail until FIRECRAWL_API_KEY, PARALLEL_API_KEY, or EXA_API_KEY is configured.');
  }

  dataProxyProc = spawn('go', ['run', './cmd/data-proxy'], {
    cwd: sandboxHostDir,
    stdio: 'inherit',
    env,
  });

  sandboxHostProc = spawn('go', ['run', './cmd/sandbox-host'], {
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
    stopGoProcesses('SIGTERM');
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const handleChildExit = (label, code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev:sandbox-host] ${label} exited (${signal ? `signal ${signal}` : `code ${code ?? 0}`})`);
      shutdown(`${label}-exit`);
    }
    for (const close of closeWatchers) close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (signal) {
      process.exitCode = 0;
      return;
    }
    process.exitCode = code ?? 0;
  };

  sandboxHostProc.on('exit', (code, signal) => handleChildExit('sandbox-host', code, signal));
  dataProxyProc.on('exit', (code, signal) => handleChildExit('data-proxy', code, signal));
}

main().catch((err) => {
  console.error('[dev:sandbox-host] fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
