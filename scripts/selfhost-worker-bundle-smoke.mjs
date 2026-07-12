#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const workerdPath = path.resolve(repoRoot, "node_modules/workerd/bin/workerd");
const miniflareWorkersDir = path.join(repoRoot, "node_modules/miniflare/dist/src/workers");

const appId = "demo--acme";
const scriptName = "demo";
const orgSlug = "acme";
const workerRegistryKey = `selfhost:worker:${appId}`;
const assetsRegistryKey = `selfhost:assets:${appId}`;
const assetHash = "hash-hello";
const assetObjectKey = `selfhost-assets/${appId}/${assetHash}`;
const assetBody = "hello from asset";

function q(value) {
  return JSON.stringify(String(value));
}

function relFrom(outDir, filePath) {
  return path.relative(outDir, filePath).replaceAll(path.sep, "/");
}

function capnpModule(outDir, name, filePath) {
  return `(name = ${q(name)}, esModule = embed ${q(relFrom(outDir, filePath))})`;
}

function capnpModuleSource(name, source) {
  return `(name = ${q(name)}, esModule = ${q(source)})`;
}

function bindingText(name, value) {
  return `(name = ${q(name)}, text = ${q(value)})`;
}

function bindingService(name, serviceName) {
  return `(name = ${q(name)}, service = (name = ${q(serviceName)}))`;
}

function bindingDurableObject(name, className) {
  return `(name = ${q(name)}, durableObjectNamespace = (className = ${q(className)}))`;
}

function bindingKv(name, serviceName) {
  return `(name = ${q(name)}, kvNamespace = (name = ${q(serviceName)}))`;
}

function bindingR2(name, serviceName) {
  return `(name = ${q(name)}, r2Bucket = (name = ${q(serviceName)}))`;
}

function bindingWorkerLoader(name, id) {
  return `(name = ${q(name)}, workerLoader = (id = ${q(id)}))`;
}

function serviceDisk(name, diskPath) {
  return `(name = ${q(name)}, disk = (path = ${q(diskPath)}, writable = true))`;
}

function miniflareSupportModules(outDir) {
  return [
    capnpModule(outDir, "miniflare:shared", path.join(miniflareWorkersDir, "shared/index.worker.js")),
    capnpModule(outDir, "miniflare:zod", path.join(miniflareWorkersDir, "shared/zod.worker.js")),
    capnpModuleSource(
      "node-internal:internal_assert",
      'import assert from "node:assert"; export default assert; export * from "node:assert";',
    ),
    capnpModuleSource(
      "node-internal:internal_buffer",
      'export { Buffer } from "node:buffer";',
    ),
  ];
}

function storageObjectBindings(storageServiceName) {
  return [
    bindingService("MINIFLARE_BLOBS", storageServiceName),
    bindingService("MINIFLARE_LOOPBACK", "loopback"),
  ];
}

function serviceStorageObject(outDir, {
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
        capnpModule(outDir, workerModuleName, path.join(miniflareWorkersDir, workerFile)),
        ...miniflareSupportModules(outDir),
      ].join(", ") +
    `], ` +
    `durableObjectNamespaces = [(` +
      `className = ${q(className)}, uniqueKey = ${q(uniqueKey)}, enableSql = true` +
    `)], ` +
    `durableObjectStorage = (localDisk = ${q(storageServiceName)}), ` +
    `bindings = [${storageObjectBindings(storageServiceName).join(", ")}]` +
  `))`;
}

function serviceObjectEntry(outDir, serviceName, objectServiceName, className, namespace) {
  return `(name = ${q(serviceName)}, worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `modules = [${capnpModule(
      outDir,
      "object-entry.worker.js",
      path.join(miniflareWorkersDir, "shared/object-entry.worker.js"),
    )}], ` +
    `bindings = [` +
      bindingText("MINIFLARE_NAMESPACE", namespace) + ", " +
      `(name = "MINIFLARE_OBJECT", durableObjectNamespace = (` +
        `className = ${q(className)}, serviceName = ${q(objectServiceName)}` +
      `))` +
    `]` +
  `))`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    ...options,
  });
  child.output = [];
  child.stdout.on("data", (chunk) => child.output.push(chunk));
  child.stderr.on("data", (chunk) => child.output.push(chunk));
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function httpRequest(url, { headers = {}, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
}

async function waitForHttp(url, child, label) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early with ${child.exitCode}: ${Buffer.concat(child.output).toString("utf8")}`);
    }
    try {
      const response = await httpRequest(url, { timeoutMs: 1000 });
      if (response.status >= 200 && response.status < 500) return;
      lastError = new Error(`${label} returned ${response.status}: ${response.body}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Timed out waiting for ${label}: ${lastError?.message ?? "no response"}\n\nworkerd output:\n${Buffer.concat(child.output).toString("utf8")}`,
  );
}

async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString("utf8"));
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}\n${Buffer.concat(output).toString("utf8")}`));
    });
  });
}

async function buildUserWorkerBundle(dir) {
  const sourceDir = path.join(dir, "user-src");
  const bundleDir = path.join(dir, "user-bundle");
  const sourcePath = path.join(sourceDir, "index.ts");
  const bundlePath = path.join(bundleDir, "index.js");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.writeFile(sourcePath, `
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async increment(name = "main") {
    const key = \`rpc-count:\${name}\`;
    const current = Number((await this.ctx.storage.kv.get(key)) || 0);
    const next = current + 1;
    await this.ctx.storage.kv.put(key, next);
    return { name, count: next };
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/do-url") {
      return new Response(url.pathname + url.search, {
        headers: { "content-type": "text/plain" },
      });
    }
    const key = \`count:\${url.searchParams.get("name") || "main"}\`;
    const current = Number((await this.ctx.storage.kv.get(key)) || 0);
    const next = current + 1;
    await this.ctx.storage.kv.put(key, next);
    return new Response(String(next), {
      headers: { "content-type": "text/plain" },
    });
  }
}

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher; BUCKET: R2Bucket; COUNTER: DurableObjectNamespace; DATA_BLOB: ArrayBuffer; GREETING: string; KV: KVNamespace; TEXT_BLOB: string }) {
    const url = new URL(request.url);
    if (url.pathname === "/env") {
      return new Response(env.GREETING, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/blobs") {
      return new Response(env.TEXT_BLOB + ":" + new TextDecoder().decode(env.DATA_BLOB), {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/outbound") {
      const response = await fetch("https://example.com");
      return new Response(String(response.status), {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/r2") {
      const key = url.searchParams.get("key") || "message.txt";
      const value = url.searchParams.get("value") || "stored from bundle";
      await env.BUCKET.put(key, value);
      const object = await env.BUCKET.get(key);
      return new Response(object ? await object.text() : "missing", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/r2-read") {
      const key = url.searchParams.get("key") || "message.txt";
      const object = await env.BUCKET.get(key);
      return new Response(object ? await object.text() : "missing", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/kv") {
      await env.KV.put("message", "from-kv");
      return new Response(await env.KV.get("message") ?? "missing", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/kv-read") {
      return new Response(await env.KV.get("message") ?? "missing", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/asset") {
      return env.ASSETS.fetch(new Request(new URL("/hello.txt", request.url), request));
    }
    const name = url.searchParams.get("name") || "main";
    if (url.pathname === "/rpc") {
      const result = await env.COUNTER.get(env.COUNTER.idFromName(name)).increment(name);
      return Response.json(result);
    }
    return env.COUNTER.get(env.COUNTER.idFromName(name)).fetch(request);
  },
};
`);
  await runCommand("bun", [
    "build",
    sourcePath,
    "--target=browser",
    "--format=esm",
    "--external=cloudflare:workers",
    `--outfile=${bundlePath}`,
  ]);
  return {
    sourcePath,
    bundlePath,
    bundleSource: await fs.readFile(bundlePath, "utf8"),
  };
}

async function buildDispatcherBundle(dir) {
  const bundleDir = path.join(dir, "dispatcher");
  const bundlePath = path.join(bundleDir, "index.js");
  await fs.mkdir(bundleDir, { recursive: true });
  await runCommand("bun", [
    "build",
    "workers/dispatcher/src/index.ts",
    "--target=browser",
    "--format=esm",
    "--external=cloudflare:workers",
    `--outfile=${bundlePath}`,
  ]);
  return bundlePath;
}

function entryWorkerSource(record) {
  return `
const RECORD = ${JSON.stringify(record)};
const REGISTRY_KEY = ${JSON.stringify(workerRegistryKey)};
const ASSETS_REGISTRY_KEY = ${JSON.stringify(assetsRegistryKey)};
const ASSET_OBJECT_KEY = ${JSON.stringify(assetObjectKey)};
const ASSET_BODY = ${JSON.stringify(assetBody)};
const ASSETS_RECORD = ${JSON.stringify({
  schemaVersion: 1,
  appId,
  createdAt: new Date(0).toISOString(),
  manifest: {
    "hello.txt": {
      hash: assetHash,
      size: assetBody.length,
      contentType: "text/plain",
    },
  },
})};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__seed") {
      await env.APP_KV.put(REGISTRY_KEY, JSON.stringify(RECORD));
      await env.APP_KV.put(ASSETS_REGISTRY_KEY, JSON.stringify(ASSETS_RECORD));
      await env.R2_BUCKET.put(ASSET_OBJECT_KEY, ASSET_BODY, {
        httpMetadata: { contentType: "text/plain" },
      });
      return new Response("seeded");
    }
    return env.DISPATCHER.fetch(request);
  }
};
`;
}

async function writeConfig({ dir, configPath, port, dispatcherBundlePath, record }) {
  const outDir = path.dirname(configPath);
  const stateDir = path.join(dir, "state");
  await fs.mkdir(path.join(stateDir, "do"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "kv"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "r2"), { recursive: true });

  const kvStorageService = "kv:storage";
  const r2StorageService = "r2:storage";
  const appKvService = "kv:ns:selfhost-app-kv";
  const sessionsKvService = "kv:ns:selfhost-sessions";
  const r2BucketService = "r2:bucket:chiridion-selfhost";

  const dispatcherBindings = [
    bindingText("CF_ACCOUNT_ID", "selfhost"),
    bindingText("CF_DISPATCH_NAMESPACE", "selfhost"),
    bindingText("SKIP_AUTH", "true"),
    bindingText("LOCAL_APP_VANITY_DOMAIN", "apps.example.test"),
    bindingText("LOCAL_APP_IFRAME_DOMAIN", "apps.example.test"),
    bindingText("TOKEN_SIGNING_SECRET", "test-token-secret"),
    bindingService("DISPATCHER", "dispatcher"),
    bindingWorkerLoader("SELFHOST_WORKER_LOADER", "selfhost-worker-bundle-smoke"),
    bindingDurableObject("SELFHOST_APP_RUNNER", "SelfhostAppRunner"),
    bindingService("SELFHOST_DO_DISPATCH", "dispatcher"),
    bindingKv("APP_KV", appKvService),
    bindingR2("R2_BUCKET", r2BucketService),
    bindingKv("SESSIONS", sessionsKvService),
  ];

  const services = [
    `(name = "entry", worker = (` +
      `compatibilityDate = "2026-06-09", ` +
      `compatibilityFlags = ["nodejs_compat"], ` +
      `modules = [${capnpModuleSource("entry.js", entryWorkerSource(record))}], ` +
      `bindings = [${[
        bindingKv("APP_KV", appKvService),
        bindingR2("R2_BUCKET", r2BucketService),
        bindingService("DISPATCHER", "dispatcher"),
      ].join(", ")}]` +
    `))`,
    `(name = "dispatcher", worker = (` +
      `compatibilityDate = "2026-06-09", ` +
      `compatibilityFlags = ["nodejs_compat"], ` +
      `modules = [${capnpModule(outDir, "index.js", dispatcherBundlePath)}], ` +
      `bindings = [${dispatcherBindings.join(", ")}], ` +
      `durableObjectNamespaces = [` +
        `(className = "SelfhostAppRunner", uniqueKey = "camelai-selfhost-smoke-SelfhostAppRunner", enableSql = true)` +
      `], ` +
      `durableObjectStorage = (localDisk = "do-storage"), ` +
      `globalOutbound = "internet"` +
    `))`,
    serviceObjectEntry(outDir, appKvService, "kv:ns", "KVNamespaceObject", "selfhost-app-kv"),
    serviceObjectEntry(outDir, sessionsKvService, "kv:ns", "KVNamespaceObject", "selfhost-sessions"),
    serviceObjectEntry(outDir, r2BucketService, "r2:bucket", "R2BucketObject", "chiridion-selfhost"),
    serviceStorageObject(outDir, {
      serviceName: "kv:ns",
      workerFile: "kv/namespace.worker.js",
      workerModuleName: "namespace.worker.js",
      className: "KVNamespaceObject",
      uniqueKey: "miniflare-selfhost-worker-bundle-smoke-KVNamespaceObject",
      storageServiceName: kvStorageService,
    }),
    serviceStorageObject(outDir, {
      serviceName: "r2:bucket",
      workerFile: "r2/bucket.worker.js",
      workerModuleName: "bucket.worker.js",
      className: "R2BucketObject",
      uniqueKey: "miniflare-selfhost-worker-bundle-smoke-R2BucketObject",
      storageServiceName: r2StorageService,
    }),
    serviceDisk("do-storage", path.join(stateDir, "do")),
    serviceDisk(kvStorageService, path.join(stateDir, "kv")),
    serviceDisk(r2StorageService, path.join(stateDir, "r2")),
    `(name = "internet", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true)))`,
    `(name = "loopback", network = (allow = ["local"], tlsOptions = (trustBrowserCas = true)))`,
  ];

  const config = `using Workerd = import "/workerd/workerd.capnp";

const smoke :Workerd.Config = (
  services = [
    ${services.join(",\n    ")}
  ],
  sockets = [
    (name = "http", address = ${q(`127.0.0.1:${port}`)}, http = (), service = "entry")
  ]
);
`;
  await fs.writeFile(configPath, config);
}

async function assertBody(url, headers, expected, child) {
  let response;
  try {
    response = await httpRequest(url, { headers });
  } catch (error) {
    const output = child ? `\n\nworkerd output:\n${Buffer.concat(child.output).toString("utf8")}` : "";
    throw new Error(`Expected ${url} to return 200 ${JSON.stringify(expected)}, request failed: ${error.message}${output}`);
  }
  if (response.status !== 200 || response.body !== expected) {
    const output = child ? `\n\nworkerd output:\n${Buffer.concat(child.output).toString("utf8")}` : "";
    throw new Error(`Expected ${url} to return 200 ${JSON.stringify(expected)}, got ${response.status} ${JSON.stringify(response.body)}${output}`);
  }
}

async function main() {
  console.warn("Using workerd --experimental for Worker Loader and Durable Object Facets bundle smoke coverage.");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camelai-selfhost-worker-bundle-smoke-"));
  const port = await freePort();
  const configPath = path.join(dir, "smoke.capnp");

  const { bundleSource } = await buildUserWorkerBundle(dir);
  const dispatcherBundlePath = await buildDispatcherBundle(dir);
  const record = {
    schemaVersion: 1,
    appId,
    scriptName,
    dispatchScriptName: appId,
    orgId: "org_1",
    orgSlug,
    workspaceId: "workspace_1",
    version: "bundle-smoke-v1",
    createdAt: new Date().toISOString(),
    compatibilityDate: "2026-06-09",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "index.js",
    modules: {
      "index.js": {
        name: "index.js",
        type: "js",
        content: bundleSource,
      },
      "blob.txt": {
        name: "blob.txt",
        type: "text",
        content: "hello-text",
      },
      "blob.bin": {
        name: "blob.bin",
        type: "data",
        content: Buffer.from("hello-data").toString("base64"),
      },
    },
    bindings: [
      { type: "plain_text", name: "GREETING", text: "hello from bundle" },
      { type: "text_blob", name: "TEXT_BLOB", part: "blob.txt" },
      { type: "data_blob", name: "DATA_BLOB", part: "blob.bin" },
      {
        type: "service",
        name: "BUCKET",
        service: "chiridion-selfhost",
        entrypoint: "R2VirtualBucket",
        props: { workspaceId: "workspace_1", bucketName: "files" },
      },
      {
        type: "service",
        name: "KV",
        service: "chiridion-selfhost",
        entrypoint: "KVVirtualNamespace",
        props: { workspaceId: "workspace_1", appId, namespaceId: "test-kv" },
      },
      {
        type: "service",
        name: "ASSETS",
        service: "chiridion-selfhost",
        entrypoint: "AssetsVirtualBinding",
        props: { appId },
      },
      { type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" },
    ],
  };
  await writeConfig({ dir, configPath, port, dispatcherBundlePath, record });

  let child;
  try {
    child = spawnLogged(workerdPath, ["serve", "--experimental", configPath]);
    await waitForHttp(`http://127.0.0.1:${port}/__seed`, child, "self-host worker bundle smoke");

    const seedResponse = await httpRequest(`http://127.0.0.1:${port}/__seed`);
    if (seedResponse.status !== 200 || seedResponse.body !== "seeded") {
      throw new Error(`Expected seed to return 200 seeded, got ${seedResponse.status} ${seedResponse.body}`);
    }

    const appHeaders = { Host: "demo--acme.apps.example.test" };
    const directBridge = await httpRequest(`http://127.0.0.1:${port}/__selfhost_do/fetch?appId=${encodeURIComponent(appId)}&className=Counter&id=name:main`);
    if (directBridge.status !== 404) {
      throw new Error(`Expected public DO bridge call to return 404, got ${directBridge.status} ${directBridge.body}`);
    }
    await assertBody(`http://127.0.0.1:${port}/env`, appHeaders, "hello from bundle", child);
    await assertBody(`http://127.0.0.1:${port}/blobs`, appHeaders, "hello-text:hello-data", child);
    await assertBody(`http://127.0.0.1:${port}/outbound`, appHeaders, "200", child);
    await assertBody(`http://127.0.0.1:${port}/r2?key=message.txt&value=from-r2`, appHeaders, "from-r2", child);
    await assertBody(`http://127.0.0.1:${port}/kv`, appHeaders, "from-kv", child);
    await assertBody(`http://127.0.0.1:${port}/asset`, appHeaders, "hello from asset", child);
    await assertBody(`http://127.0.0.1:${port}/do-url?value=1`, appHeaders, "/do-url?value=1", child);
    await assertBody(`http://127.0.0.1:${port}/rpc?name=main`, appHeaders, '{"name":"main","count":1}', child);
    await assertBody(`http://127.0.0.1:${port}/rpc?name=main`, appHeaders, '{"name":"main","count":2}', child);
    await assertBody(`http://127.0.0.1:${port}/?name=main`, appHeaders, "1", child);
    await assertBody(`http://127.0.0.1:${port}/?name=main`, appHeaders, "2", child);
    await assertBody(`http://127.0.0.1:${port}/?name=other`, appHeaders, "1", child);

    await stopChild(child);
    child = spawnLogged(workerdPath, ["serve", "--experimental", configPath]);
    await waitForHttp(`http://127.0.0.1:${port}/__seed`, child, "restarted self-host worker bundle smoke");
    await assertBody(`http://127.0.0.1:${port}/r2-read?key=message.txt`, appHeaders, "from-r2", child);
    await assertBody(`http://127.0.0.1:${port}/kv-read`, appHeaders, "from-kv", child);
    await assertBody(`http://127.0.0.1:${port}/asset`, appHeaders, "hello from asset", child);
    await assertBody(`http://127.0.0.1:${port}/rpc?name=main`, appHeaders, '{"name":"main","count":3}', child);
    await assertBody(`http://127.0.0.1:${port}/?name=main`, appHeaders, "3", child);

    console.log("Self-host worker bundle smoke passed.");
  } finally {
    await stopChild(child);
    if (process.env.SELFHOST_KEEP_SMOKE_DIR !== "1") {
      await fs.rm(dir, { recursive: true, force: true });
    } else {
      console.log(`Kept smoke directory: ${dir}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
