#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { readSelfhostEnv } from './selfhost-common.mjs';

const repoRoot = process.cwd();
const defaultOut = path.join(repoRoot, '.selfhost/workerd/camelai.capnp');
const defaultStateDir = path.join(repoRoot, '.selfhost/workerd/state');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith('--')) continue;
  const [key, inlineValue] = arg.slice(2).split('=', 2);
  const value = inlineValue ?? process.argv[index + 1];
  args.set(key, value);
  if (inlineValue === undefined) index += 1;
}

const wranglerPath = path.resolve(
  repoRoot,
  args.get('wrangler') ?? 'build/server/wrangler.json',
);
const serverDir = path.dirname(wranglerPath);
const outPath = path.resolve(repoRoot, args.get('out') ?? defaultOut);
const outDir = path.dirname(outPath);
const stateDir = path.resolve(repoRoot, args.get('state-dir') ?? defaultStateDir);
const socketAddress = args.get('socket') ?? process.env.SELFHOST_WORKERD_SOCKET ?? '*:3001';

const MINIFLARE_WORKERS_DIR = path.join(
  repoRoot,
  'node_modules/miniflare/dist/src/workers',
);

const SELFHOST_DEFAULT_VARS = {
  AI_VIRTUAL_MODEL: 'dynamic/auto',
  AI_GATEWAY_AUTH_TOKEN: '',
  CF_ACCOUNT_ID: 'selfhost',
  CF_GATEWAY_NAME: '',
  CF_GATEWAY_TOKEN: '',
  SELFHOST_AI_PROVIDER: '',
  SELFHOST_AI_API_KEY: '',
  SELFHOST_AI_BASE_URL: '',
  SELFHOST_AI_MODEL: '',
  SELFHOST_AI_NAME: '',
  SELFHOST_AI_AUTH_TYPE: 'bearer',
  SELFHOST_AI_API: 'openai-completions',
  SELFHOST_AI_AWS_REGION: 'us-east-1',
  ARTIFACTS_NAMESPACE: 'selfhost',
  CF_DISPATCH_NAMESPACE: 'selfhost',
  CF_WORKER_NAME: 'chiridion-selfhost',
  ENABLE_LEGACY_WORKSPACE_MIGRATION: '0',
  EMAIL_FROM_ADDRESS: 'no-reply@localhost',
  WORKSPACE_EMAIL_DOMAIN: 'localhost',
  TOKEN_SIGNING_SECRET: 'selfhost-token-signing-secret-change-me',
  INTEGRATION_SECRET_KEY: 'selfhost-integration-secret-32bytes',
  WORKER_BASE_URL: 'http://localhost:3001',
  LOCAL_APP_VANITY_DOMAIN: '',
  LOCAL_APP_IFRAME_DOMAIN: '',
  LOCAL_ARTIFACTS_BASE_URL: 'http://localhost:7001',
  LOCAL_ARTIFACTS_SECRET: 'selfhost-artifacts-secret-change-me',
  PROJECT_RUNTIME_SERVICE_URL: 'http://localhost:4410',
  PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL: 'http://project-runtime:4411',
  PROJECT_RUNTIME_PROXY_SECRET: 'selfhost-runtime-secret-change-me',
  SANDBOX_HOST_URL: '',
  LOCAL_AUTH_BYPASS: '1',
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: '',
  CLOUDFLARE_ACCESS_AUD: '',
  CLOUDFLARE_ACCESS_AUDS: '',
  CLOUDFLARE_ACCESS_ORG_MAP: '',
  CLOUDFLARE_ACCESS_ORG_CLAIMS: '',
  CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: '',
  CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: '',
  CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: '',
  CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN: '',
};

const SELFHOST_KV_IDS = {
  EMAIL_TO_USER: 'selfhost-email-to-user',
  APP_KV: 'selfhost-app-kv',
  SESSIONS: 'selfhost-sessions',
};

const SELFHOST_R2_BUCKETS = {
  R2_BUCKET: 'chiridion-selfhost',
  BACKUP_BUCKET: 'chiridion-selfhost-backups',
};

const SELFHOST_D1_DATABASES = {
  APP_DB: {
    databaseId: 'selfhost-app-db',
    databaseName: 'chiridion-selfhost-db',
  },
};

const SELFHOST_QUEUE_NAMES = {
  APP_SCREENSHOT_QUEUE: 'chiridion-app-screenshots-selfhost',
  SLACK_EVENTS_QUEUE: 'chiridion-app-slack-events-selfhost',
};

const SELFHOST_QUEUE_NAME_BY_SOURCE = {
  'chiridion-app-screenshots-local': 'chiridion-app-screenshots-selfhost',
  'chiridion-app-slack-events-local': 'chiridion-app-slack-events-selfhost',
};

const SELFHOST_WORKFLOW_NAMES = {
  DETERMINISTIC_AUTOMATION_WORKFLOWS: 'chiridion-selfhost-deterministic-automations',
  LEGACY_WORKSPACE_MIGRATIONS: 'chiridion-selfhost-legacy-workspace-migrations',
};

const BROWSER_RENDERING_SERVICE_NAME = 'browser-rendering:service';

function q(value) {
  return JSON.stringify(String(value));
}

function relFromOut(filePath) {
  return path.relative(outDir, filePath).replaceAll(path.sep, '/');
}

function capnpModule(name, filePath) {
  return `(name = ${q(name)}, esModule = embed ${q(relFromOut(filePath))})`;
}

function capnpModuleSource(name, source) {
  return `(name = ${q(name)}, esModule = ${q(source)})`;
}

function capnpExtensionModule(name, filePath, internal = true) {
  return `(name = ${q(name)}, internal = ${internal ? 'true' : 'false'}, esModule = embed ${q(relFromOut(filePath))})`;
}

function bindingText(name, value) {
  return `(name = ${q(name)}, text = ${q(value)})`;
}

function bindingJson(name, value) {
  return `(name = ${q(name)}, json = ${q(JSON.stringify(value))})`;
}

function bindingService(name, serviceName) {
  return `(name = ${q(name)}, service = (name = ${q(serviceName)}))`;
}

function bindingServiceEntrypoint(name, serviceName, entrypoint) {
  return `(name = ${q(name)}, service = (name = ${q(serviceName)}, entrypoint = ${q(entrypoint)}))`;
}

function bindingDurableObject(name, className) {
  return `(name = ${q(name)}, durableObjectNamespace = (className = ${q(className)}))`;
}

function bindingDurableObjectFromService(name, className, serviceName) {
  return `(name = ${q(name)}, durableObjectNamespace = (` +
    `className = ${q(className)}, serviceName = ${q(serviceName)}` +
  `))`;
}

function bindingKv(name, serviceName) {
  return `(name = ${q(name)}, kvNamespace = (name = ${q(serviceName)}))`;
}

function bindingR2(name, serviceName) {
  return `(name = ${q(name)}, r2Bucket = (name = ${q(serviceName)}))`;
}

function bindingQueue(name, serviceName) {
  return `(name = ${q(name)}, queue = (name = ${q(serviceName)}))`;
}

function bindingWorkerLoader(name, id) {
  return `(name = ${q(name)}, workerLoader = (id = ${q(id)}))`;
}

function bindingD1(name, serviceName) {
  return `(name = ${q(name)}, wrapped = (` +
    `moduleName = "cloudflare-internal:d1-api", ` +
    `innerBindings = [(name = "fetcher", service = (name = ${q(serviceName)}))]` +
  `))`;
}

function bindingWorkflow(name, serviceName) {
  return `(name = ${q(name)}, wrapped = (` +
    `moduleName = "workflows:local-wrapped-binding", ` +
    `innerBindings = [` +
      `(name = "binding", service = (` +
        `name = ${q(serviceName)}, entrypoint = "WorkflowBinding"` +
      `))` +
    `]` +
  `))`;
}

function bindingArtifacts(name, { baseUrl, secret, defaultBranch }) {
  return `(name = ${q(name)}, wrapped = (` +
    `moduleName = "selfhost:artifacts-binding", ` +
    `innerBindings = [` +
      [
        bindingText('baseUrl', baseUrl),
        bindingText('secret', secret),
        bindingText('defaultBranch', defaultBranch),
      ].join(', ') +
    `]` +
  `))`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function listJsModules(dir) {
  const result = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        result.push(absolute);
      }
    }
  }
  await walk(dir);
  result.sort();
  const mainPath = path.join(dir, 'index.js');
  return [mainPath, ...result.filter((file) => file !== mainPath)].map((file) => ({
    name: path.relative(dir, file).replaceAll(path.sep, '/'),
    file,
  }));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? code}`));
    });
  });
}

async function buildDispatcherBundle(outDir) {
  const bundleDir = path.join(outDir, 'dispatcher');
  const outfile = path.join(bundleDir, 'index.js');
  await fs.mkdir(bundleDir, { recursive: true });
  await runCommand('bun', [
    'build',
    'workers/dispatcher/src/index.ts',
    '--target=browser',
    '--format=esm',
    '--external=cloudflare:workers',
    `--outfile=${outfile}`,
  ]);
  return outfile;
}

function serviceDisk(name, diskPath) {
  return `(name = ${q(name)}, disk = (path = ${q(diskPath)}, writable = true))`;
}

function serviceObjectEntry(serviceName, objectServiceName, className, namespace) {
  return `(name = ${q(serviceName)}, worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `modules = [${capnpModule(
      'object-entry.worker.js',
      path.join(MINIFLARE_WORKERS_DIR, 'shared/object-entry.worker.js'),
    )}], ` +
    `bindings = [` +
      bindingText('MINIFLARE_NAMESPACE', namespace) + ', ' +
      `(name = "MINIFLARE_OBJECT", durableObjectNamespace = (` +
        `className = ${q(className)}, serviceName = ${q(objectServiceName)}` +
      `))` +
    `]` +
  `))`;
}

function miniflareSupportModules() {
  return [
    capnpModule('miniflare:shared', path.join(MINIFLARE_WORKERS_DIR, 'shared/index.worker.js')),
    capnpModule('miniflare:zod', path.join(MINIFLARE_WORKERS_DIR, 'shared/zod.worker.js')),
    capnpModuleSource(
      'node-internal:internal_assert',
      'import assert from "node:assert"; export default assert; export * from "node:assert";',
    ),
    capnpModuleSource(
      'node-internal:internal_buffer',
      'export { Buffer } from "node:buffer";',
    ),
  ];
}

function storageObjectBindings(storageServiceName) {
  return [
    bindingService('MINIFLARE_BLOBS', storageServiceName),
    bindingService('MINIFLARE_LOOPBACK', 'loopback'),
  ];
}

function serviceStorageObject({
  serviceName,
  workerFile,
  workerModuleName,
  className,
  uniqueKey,
  storageServiceName,
}) {
  return `(name = ${q(serviceName)}, worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `compatibilityFlags = ["nodejs_compat", "experimental"], ` +
    `modules = [` +
      [
        capnpModule(workerModuleName, path.join(MINIFLARE_WORKERS_DIR, workerFile)),
        ...miniflareSupportModules(),
      ].join(', ') +
    `], ` +
    `durableObjectNamespaces = [(` +
      `className = ${q(className)}, uniqueKey = ${q(uniqueKey)}, enableSql = true` +
    `)], ` +
    `durableObjectStorage = (localDisk = ${q(storageServiceName)}), ` +
    `bindings = [${storageObjectBindings(storageServiceName).join(', ')}]` +
  `))`;
}

function serviceCacheEntry() {
  return `(name = "cache:0", worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `compatibilityFlags = ["nodejs_compat", "experimental"], ` +
    `modules = [` +
      [
        capnpModule('cache-entry.worker.js', path.join(MINIFLARE_WORKERS_DIR, 'cache/cache-entry.worker.js')),
        ...miniflareSupportModules(),
      ].join(', ') +
    `], ` +
    `bindings = [` +
      [
        `(name = "MINIFLARE_OBJECT", durableObjectNamespace = (` +
          `className = "CacheObject", serviceName = "cache:cache"` +
        `))`,
        bindingJson('MINIFLARE_CACHE_WARN_USAGE', false),
      ].join(', ') +
    `]` +
  `))`;
}

function serviceCacheObject() {
  return `(name = "cache:cache", worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `compatibilityFlags = ["nodejs_compat", "experimental"], ` +
    `modules = [` +
      [
        capnpModule('cache.worker.js', path.join(MINIFLARE_WORKERS_DIR, 'cache/cache.worker.js')),
        ...miniflareSupportModules(),
      ].join(', ') +
    `], ` +
    `durableObjectNamespaces = [(` +
      `className = "CacheObject", uniqueKey = "miniflare-CacheObject", enableSql = true` +
    `)], ` +
    `durableObjectStorage = (localDisk = "cache:storage"), ` +
    `bindings = [${storageObjectBindings('cache:storage').join(', ')}]` +
  `))`;
}

function selfhostQueueName(queue, binding) {
  if (binding && SELFHOST_QUEUE_NAMES[binding]) return SELFHOST_QUEUE_NAMES[binding];
  return SELFHOST_QUEUE_NAME_BY_SOURCE[queue] ?? queue;
}

function collectQueueConfig(wrangler) {
  const producers = new Map();
  const consumers = new Map();
  const workerName = 'chiridion-app-selfhost';
  for (const producer of wrangler.queues?.producers ?? []) {
    const queueName = selfhostQueueName(producer.queue, producer.binding);
    producers.set(queueName, {
      queueName,
      workerName,
    });
  }
  for (const consumer of wrangler.queues?.consumers ?? []) {
    const queueName = selfhostQueueName(consumer.queue);
    consumers.set(queueName, {
      queueName,
      workerName,
    });
  }
  return { producers, consumers, workerName };
}

function serviceQueueBroker({ producers, consumers, workerName, mainServiceName }) {
  return `(name = "queue", worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `compatibilityFlags = ["nodejs_compat", "experimental", "service_binding_extra_handlers"], ` +
    `modules = [` +
      [
        capnpModule('broker.worker.js', path.join(MINIFLARE_WORKERS_DIR, 'queues/broker.worker.js')),
        ...miniflareSupportModules(),
      ].join(', ') +
    `], ` +
    `durableObjectNamespaces = [(` +
      `className = "QueueBrokerObject", uniqueKey = "miniflare-QueueBrokerObject", ` +
      `preventEviction = true` +
    `)], ` +
    `durableObjectStorage = (inMemory = void), ` +
    `bindings = [` +
      [
        bindingService('MINIFLARE_LOOPBACK', 'loopback'),
        `(name = "MINIFLARE_OBJECT", durableObjectNamespace = (className = "QueueBrokerObject"))`,
        bindingJson('MINIFLARE_QUEUE_PRODUCERS', Object.fromEntries(producers)),
        bindingJson('MINIFLARE_QUEUE_CONSUMERS', Object.fromEntries(consumers)),
        bindingService(`MINIFLARE_WORKER_${workerName}`, mainServiceName),
      ].join(', ') +
    `]` +
  `))`;
}

function serviceWorkflow({ workflow, mainServiceName, storageServiceName }) {
  const serviceName = `workflows:${workflow.name}`;
  const flags = Array.from(new Set(['experimental', ...(workflow.compatibilityFlags ?? [])]));
  const bindings = [
    `(name = "ENGINE", durableObjectNamespace = (className = "Engine"))`,
    bindingServiceEntrypoint('USER_WORKFLOW', mainServiceName, workflow.className),
    bindingJson('BINDING_NAME', workflow.binding),
    bindingJson('WORKFLOW_NAME', workflow.name),
  ];
  if (workflow.stepLimit !== undefined) {
    bindings.push(bindingJson('STEP_LIMIT', workflow.stepLimit));
  }

  return `(name = ${q(serviceName)}, worker = (` +
    `compatibilityDate = "2024-10-22", ` +
    `compatibilityFlags = [${flags.map(q).join(', ')}], ` +
    `modules = [${capnpModule(
      'workflows.mjs',
      path.join(MINIFLARE_WORKERS_DIR, 'workflows/binding.worker.js'),
    )}], ` +
    `durableObjectNamespaces = [(` +
      `className = "Engine", enableSql = true, ` +
      `uniqueKey = ${q(`miniflare-workflows-${workflow.name}`)}, preventEviction = true` +
    `)], ` +
    `durableObjectStorage = (localDisk = ${q(storageServiceName)}), ` +
    `bindings = [${bindings.join(', ')}]` +
  `))`;
}

function serviceBrowserRendering() {
  const bindings = [
    bindingService('MINIFLARE_LOOPBACK', 'loopback'),
    bindingDurableObject('BrowserSession', 'BrowserSession'),
  ];
  return `(name = ${q(BROWSER_RENDERING_SERVICE_NAME)}, worker = (` +
    `compatibilityDate = "2025-05-01", ` +
    `compatibilityFlags = ["nodejs_compat"], ` +
    `modules = [` +
      [
        capnpModule(
          'binding.worker.js',
          path.join(MINIFLARE_WORKERS_DIR, 'browser-rendering/binding.worker.js'),
        ),
        ...miniflareSupportModules(),
      ].join(', ') +
    `], ` +
    `bindings = [${bindings.join(', ')}], ` +
    `durableObjectNamespaces = [` +
      `(className = "BrowserSession", uniqueKey = "miniflare-BrowserSession")` +
    `], ` +
    `durableObjectStorage = (inMemory = void), ` +
    `globalOutbound = "local"` +
  `))`;
}

function serviceEntryWorker(mainServiceName, dispatcherServiceName, vars) {
  const source = `
const STATIC_PATHS = new Set([
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/site.webmanifest",
  "/robots.txt"
]);

function hostWithoutPort(request, url) {
  const host = request.headers.get("Host");
  return (host || url.host).replace(/:\\d+$/, "").toLowerCase();
}

function configuredDomain(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/^https?:\\/\\//, "").replace(/\\/.*$/, "").replace(/:\\d+$/, "");
}

function matchesConfiguredDomain(hostname, domain) {
  return Boolean(domain) && hostname !== domain && hostname.endsWith("." + domain);
}

function shouldRouteToDispatcher(hostname, env) {
  if (matchesConfiguredDomain(hostname, configuredDomain(env.LOCAL_APP_VANITY_DOMAIN))) return true;
  if (matchesConfiguredDomain(hostname, configuredDomain(env.LOCAL_APP_IFRAME_DOMAIN))) return true;
  if (hostname.endsWith(".camelai.app")) return true;
  return hostname.endsWith(".camelai.dev") && hostname.includes(".apps.");
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeForPath(pathname) {
  const lower = pathname.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return MIME_TYPES[lower.slice(dot)] ?? null;
}

function hasFileExtension(pathname) {
  const slash = pathname.lastIndexOf("/");
  const lastSegment = slash === -1 ? pathname : pathname.slice(slash + 1);
  return /\\.[A-Za-z0-9]{1,16}$/.test(lastSegment);
}

function assetResponseWithContentType(request, response, pathname) {
  const headers = new Headers(response.headers);
  const contentType = contentTypeForPath(pathname);
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (shouldRouteToDispatcher(hostWithoutPort(request, url), env)) {
      return env.DISPATCHER.fetch(request);
    }
    const mayBeAsset =
      url.pathname.startsWith("/assets/") ||
      STATIC_PATHS.has(url.pathname) ||
      hasFileExtension(url.pathname);
    if (mayBeAsset && (request.method === "GET" || request.method === "HEAD")) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        return assetResponseWithContentType(request, response, url.pathname);
      }
    }
    return env.WORKER.fetch(request);
  }
};
`;
  return `(name = "entry", worker = (` +
    `compatibilityDate = "2025-12-01", ` +
    `modules = [${capnpModuleSource('entry.worker.js', source)}], ` +
    `bindings = [` +
      `${bindingService('ASSETS', 'assets')}, ` +
      `${bindingService('WORKER', mainServiceName)}, ` +
      `${bindingService('DISPATCHER', dispatcherServiceName)}, ` +
      `${bindingText('LOCAL_APP_VANITY_DOMAIN', vars.LOCAL_APP_VANITY_DOMAIN ?? '')}, ` +
      `${bindingText('LOCAL_APP_IFRAME_DOMAIN', vars.LOCAL_APP_IFRAME_DOMAIN ?? '')}` +
    `]` +
  `))`;
}

async function main() {
  const wrangler = await readJson(wranglerPath);
  const modules = await listJsModules(serverDir);
  const dispatcherBundle = await buildDispatcherBundle(outDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(path.join(stateDir, 'do'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'kv'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'r2'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'd1'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'cache'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'workflows'), { recursive: true });

  const mainServiceName = 'camelai';
  const dispatcherServiceName = 'dispatcher';
  const bindings = [];
  const services = [];
  const extensions = [];

  const selfhostEnv = await readSelfhostEnv(false);
  const vars = { ...SELFHOST_DEFAULT_VARS, ...selfhostEnv };
  for (const key of Object.keys(vars)) {
    if (process.env[key] !== undefined) vars[key] = process.env[key];
  }
  for (const [name, value] of Object.entries(vars)) {
    bindings.push(bindingText(name, value));
  }

  const localArtifactsBaseUrl = String(vars.LOCAL_ARTIFACTS_BASE_URL ?? '').trim();
  const localArtifactsSecret = String(vars.LOCAL_ARTIFACTS_SECRET ?? '').trim();
  const useLocalArtifactsBinding = Boolean(localArtifactsBaseUrl && localArtifactsSecret);
  if (useLocalArtifactsBinding) {
    bindings.push(bindingArtifacts('ARTIFACTS', {
      baseUrl: localArtifactsBaseUrl,
      secret: localArtifactsSecret,
      defaultBranch: vars.LOCAL_ARTIFACTS_DEFAULT_BRANCH || 'main',
    }));
    extensions.push(`(modules = [${capnpExtensionModule(
      'selfhost:artifacts-binding',
      path.join(repoRoot, 'infra/selfhost/artifacts-binding.worker.js'),
      true,
    )}])`);
  }

  for (const binding of wrangler.durable_objects?.bindings ?? []) {
    bindings.push(bindingDurableObject(binding.name, binding.class_name));
  }

  for (const namespace of wrangler.kv_namespaces ?? []) {
    const namespaceId = SELFHOST_KV_IDS[namespace.binding] ?? namespace.id;
    const serviceName = `kv:ns:${namespaceId}`;
    bindings.push(bindingKv(namespace.binding, serviceName));
    services.push(serviceObjectEntry(serviceName, 'kv:ns', 'KVNamespaceObject', namespaceId));
  }

  for (const bucket of wrangler.r2_buckets ?? []) {
    const bucketId = SELFHOST_R2_BUCKETS[bucket.binding] ?? bucket.bucket_name ?? bucket.binding;
    const serviceName = `r2:bucket:${bucketId}`;
    bindings.push(bindingR2(bucket.binding, serviceName));
    services.push(serviceObjectEntry(serviceName, 'r2:bucket', 'R2BucketObject', bucketId));
  }

  for (const database of wrangler.d1_databases ?? []) {
    const databaseOverride = SELFHOST_D1_DATABASES[database.binding];
    const databaseId = databaseOverride?.databaseId ?? database.database_id ?? database.database_name ?? database.binding;
    const serviceName = `d1:db:${databaseId}`;
    bindings.push(bindingD1(database.binding, serviceName));
    services.push(serviceObjectEntry(serviceName, 'd1:db', 'D1DatabaseObject', databaseId));
  }

  const { producers, consumers, workerName } = collectQueueConfig(wrangler);
  for (const producer of wrangler.queues?.producers ?? []) {
    const queueName = selfhostQueueName(producer.queue, producer.binding);
    bindings.push(bindingQueue(producer.binding, `queue:${queueName}`));
    services.push(serviceObjectEntry(`queue:${queueName}`, 'queue', 'QueueBrokerObject', queueName));
  }

  for (const service of wrangler.services ?? []) {
    if (service.binding === 'WORKER_SELF_REFERENCE') {
      bindings.push(bindingService(service.binding, mainServiceName));
    }
  }

  for (const loader of wrangler.worker_loaders ?? []) {
    bindings.push(bindingWorkerLoader(loader.binding, loader.binding.toLowerCase()));
  }

  if (wrangler.assets?.binding) {
    bindings.push(bindingService(wrangler.assets.binding, 'assets'));
  }

  const browserBindingName = wrangler.browser?.binding;
  const enableBrowserBinding = Boolean(browserBindingName);
  if (enableBrowserBinding) {
    bindings.push(bindingService(browserBindingName, BROWSER_RENDERING_SERVICE_NAME));
  }

  const workflows = (wrangler.workflows ?? []).map((workflow) => ({
    binding: workflow.binding,
    name: SELFHOST_WORKFLOW_NAMES[workflow.binding] ?? workflow.name,
    className: workflow.class_name,
    stepLimit: workflow.step_limit,
    compatibilityFlags: workflow.compatibility_flags,
  }));
  if (workflows.length > 0) {
    bindings.push(...workflows.map((workflow) => bindingWorkflow(workflow.binding, `workflows:${workflow.name}`)));
    extensions.push(`(modules = [${capnpExtensionModule(
      'workflows:local-wrapped-binding',
      path.join(MINIFLARE_WORKERS_DIR, 'workflows/wrapped-binding.worker.js'),
      true,
    )}])`);
  }

  bindings.push(bindingServiceEntrypoint('DISPATCHER', dispatcherServiceName, 'PlatformAppFetchBinding'));

  const compatibilityFlags = (wrangler.compatibility_flags ?? []).filter((flag) => {
    if (process.env.SELFHOST_WORKERD_STRICT_PUBLIC === '1') return true;
    return flag !== 'global_fetch_strictly_public';
  });

  const durableObjectClasses = (wrangler.durable_objects?.bindings ?? []).map((binding) => binding.class_name);
  const mainWorker = `(name = ${q(mainServiceName)}, worker = (` +
    `compatibilityDate = ${q(wrangler.compatibility_date)}, ` +
    `compatibilityFlags = [${compatibilityFlags.map(q).join(', ')}], ` +
    `modules = [${modules.map(({ name, file }) => capnpModule(name, file)).join(', ')}], ` +
    `bindings = [${bindings.join(', ')}], ` +
    `globalOutbound = "internet", ` +
    `cacheApiOutbound = "cache:0", ` +
    `durableObjectNamespaces = [` +
      durableObjectClasses.map((className) => (
        `(className = ${q(className)}, uniqueKey = ${q(`camelai-selfhost-${className}`)}, enableSql = true)`
      )).join(', ') +
    `], ` +
    `durableObjectStorage = (localDisk = "do-storage")` +
  `))`;

  const dispatcherBindings = [
    ...Object.entries(vars).map(([name, value]) => bindingText(name, value)),
    bindingText('SKIP_AUTH', 'true'),
    bindingService('DISPATCHER', mainServiceName),
    bindingWorkerLoader('SELFHOST_WORKER_LOADER', 'selfhost-user-workers'),
    bindingDurableObject('SELFHOST_APP_RUNNER', 'SelfhostAppRunner'),
    bindingService('SELFHOST_DO_DISPATCH', dispatcherServiceName),
    bindingDurableObjectFromService('ORG', 'OrgDO', mainServiceName),
    bindingR2('R2_BUCKET', `r2:bucket:${SELFHOST_R2_BUCKETS.R2_BUCKET}`),
    bindingKv('APP_KV', `kv:ns:${SELFHOST_KV_IDS.APP_KV}`),
    bindingKv('SESSIONS', `kv:ns:${SELFHOST_KV_IDS.SESSIONS}`),
  ];
  const dispatcherWorker = `(name = ${q(dispatcherServiceName)}, worker = (` +
    `compatibilityDate = "2026-06-09", ` +
    `compatibilityFlags = ["nodejs_compat"], ` +
    `modules = [${capnpModule('index.js', dispatcherBundle)}], ` +
    `bindings = [${dispatcherBindings.join(', ')}], ` +
    `cacheApiOutbound = "cache:0", ` +
    `durableObjectNamespaces = [` +
      `(className = "SelfhostAppRunner", uniqueKey = "camelai-selfhost-SelfhostAppRunner", enableSql = true)` +
    `], ` +
    `durableObjectStorage = (localDisk = "do-storage"), ` +
    `globalOutbound = "internet"` +
  `))`;

  services.unshift(mainWorker);
  services.unshift(dispatcherWorker);
  services.unshift(serviceEntryWorker(mainServiceName, dispatcherServiceName, vars));
  services.push(serviceDisk('do-storage', path.join(stateDir, 'do')));
  services.push(serviceDisk('kv:storage', path.join(stateDir, 'kv')));
  services.push(serviceDisk('r2:storage', path.join(stateDir, 'r2')));
  services.push(serviceDisk('d1:storage', path.join(stateDir, 'd1')));
  services.push(serviceDisk('cache:storage', path.join(stateDir, 'cache')));
  for (const workflow of workflows) {
    const workflowStorageServiceName = `workflows:storage-${workflow.name}`;
    const workflowStoragePath = path.join(stateDir, 'workflows', workflow.name);
    await fs.mkdir(workflowStoragePath, { recursive: true });
    services.push(serviceDisk(workflowStorageServiceName, workflowStoragePath));
    services.push(serviceWorkflow({
      workflow,
      mainServiceName,
      storageServiceName: workflowStorageServiceName,
    }));
  }
  services.push(serviceStorageObject({
    serviceName: 'kv:ns',
    workerFile: 'kv/namespace.worker.js',
    workerModuleName: 'namespace.worker.js',
    className: 'KVNamespaceObject',
    uniqueKey: 'miniflare-KVNamespaceObject',
    storageServiceName: 'kv:storage',
  }));
  services.push(serviceStorageObject({
    serviceName: 'r2:bucket',
    workerFile: 'r2/bucket.worker.js',
    workerModuleName: 'bucket.worker.js',
    className: 'R2BucketObject',
    uniqueKey: 'miniflare-R2BucketObject',
    storageServiceName: 'r2:storage',
  }));
  services.push(serviceStorageObject({
    serviceName: 'd1:db',
    workerFile: 'd1/database.worker.js',
    workerModuleName: 'database.worker.js',
    className: 'D1DatabaseObject',
    uniqueKey: 'miniflare-D1DatabaseObject',
    storageServiceName: 'd1:storage',
  }));
  services.push(serviceCacheEntry());
  services.push(serviceCacheObject());
  if (producers.size > 0) {
    services.push(serviceQueueBroker({ producers, consumers, workerName, mainServiceName }));
  }
  if (enableBrowserBinding) {
    services.push(serviceBrowserRendering());
    services.push('(name = "loopback", external = (http = ()))');
    services.push('(name = "local", network = (allow = ["local"], tlsOptions = (trustBrowserCas = true)))');
  } else {
    services.push('(name = "loopback", network = (allow = ["local"], tlsOptions = (trustBrowserCas = true)))');
  }
  services.push(`(name = "assets", disk = (path = ${q(path.resolve(serverDir, wrangler.assets?.directory ?? '../client'))}, writable = false))`);
  services.push('(name = "internet", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true)))');

  const config = `using Workerd = import "/workerd/workerd.capnp";

const camelai :Workerd.Config = (
  services = [
    ${services.join(',\n    ')}
  ],
  extensions = [
    ${extensions.join(',\n    ')}
  ],
  sockets = [
    (name = "http", address = ${q(socketAddress)}, http = (), service = "entry")
  ]
);
`;

  await fs.writeFile(outPath, config);
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: path.relative(repoRoot, wranglerPath),
    config: path.relative(repoRoot, outPath),
    stateDir: path.relative(repoRoot, stateDir),
    socketAddress,
    mainServiceName,
    dispatcherServiceName,
    modules: modules.length,
    bindings: {
      vars: Object.keys(vars),
      durableObjects: durableObjectClasses,
      kv: (wrangler.kv_namespaces ?? []).map((item) => item.binding),
      r2: (wrangler.r2_buckets ?? []).map((item) => item.binding),
      d1: (wrangler.d1_databases ?? []).map((item) => item.binding),
      cache: ['default'],
      queues: (wrangler.queues?.producers ?? []).map((item) => item.binding),
      workflows: workflows.map((item) => item.binding),
      artifacts: useLocalArtifactsBinding ? ['ARTIFACTS'] : (wrangler.artifacts ?? []).map((item) => item.binding),
      workerLoaders: [
        ...(wrangler.worker_loaders ?? []).map((item) => item.binding),
        'SELFHOST_WORKER_LOADER',
      ],
      assets: wrangler.assets?.binding,
      browser: enableBrowserBinding ? [browserBindingName] : [],
    },
    loopback: enableBrowserBinding
      ? { mode: 'external', hostname: '127.0.0.1' }
      : { mode: 'network' },
    omittedBindings: {
      sendEmail: (wrangler.send_email ?? []).map((item) => item.name),
    },
  };
  await fs.writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`Generated ${path.relative(repoRoot, outPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
