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

function q(value) {
  return JSON.stringify(String(value));
}

function relFrom(dir, filePath) {
  return path.relative(dir, filePath).replaceAll(path.sep, "/");
}

function moduleFile(outDir, name, filePath) {
  return `(name = ${q(name)}, esModule = embed ${q(relFrom(outDir, filePath))})`;
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

function spawnLogged(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
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

function httpGet(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early with ${child.exitCode}: ${Buffer.concat(child.output).toString("utf8")}`);
    }
    try {
      const response = await httpGet(url, 1000);
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

async function assertBody(url, expected) {
  const response = await httpGet(url, 2000);
  if (response.status !== 200 || response.body !== expected) {
    throw new Error(`Expected ${url} to return 200 ${expected}, got ${response.status} ${response.body}`);
  }
}

const userWorkerSource = `
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch() {
    const current = (await this.ctx.storage.kv.get("count")) || 0;
    const next = Number(current) + 1;
    await this.ctx.storage.kv.put("count", next);
    return new Response(String(next));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") || "main";
    const id = env.COUNTER.idFromName(name);
    const stub = env.COUNTER.get(id);
    return stub.fetch(request);
  }
};
`;

const dynamicWrapperSource = `
export { Counter } from "./user-worker.js";
import userDefault from "./user-worker.js";

const DO_BRIDGE_SECRET = "selfhost-wfp-facets-smoke-secret";

class SelfhostDurableObjectId {
  constructor(value, name) {
    this.value = String(value);
    if (name !== undefined) this.name = name;
  }
  toString() {
    return this.value;
  }
  equals(other) {
    return Boolean(other) && String(other) === this.value;
  }
}

class SelfhostDurableObjectStub {
  constructor(dispatcher, appId, className, id, name) {
    this.dispatcher = dispatcher;
    this.appId = appId;
    this.className = className;
    this.id = id;
    if (name !== undefined) this.name = name;
  }

  fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL("http://selfhost.local/__selfhost_do/fetch");
    url.searchParams.set("appId", this.appId);
    url.searchParams.set("className", this.className);
    url.searchParams.set("id", this.id.toString());
    const headers = new Headers(request.headers);
    headers.set("x-camelai-selfhost-do-bridge", DO_BRIDGE_SECRET);
    headers.set("x-camelai-selfhost-do-original-url", request.url);
    const forwardedInit = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      forwardedInit.body = request.body;
    }
    return this.dispatcher.fetch(new Request(url, forwardedInit));
  }
}

class SelfhostDurableObjectNamespace {
  constructor(dispatcher, appId, className) {
    this.dispatcher = dispatcher;
    this.appId = appId;
    this.className = className;
  }

  idFromName(name) {
    return new SelfhostDurableObjectId("name:" + String(name), String(name));
  }

  idFromString(id) {
    return new SelfhostDurableObjectId(String(id));
  }

  newUniqueId() {
    return new SelfhostDurableObjectId("unique:" + crypto.randomUUID());
  }

  get(id) {
    return new SelfhostDurableObjectStub(this.dispatcher, this.appId, this.className, id, id.name);
  }

  getByName(name) {
    return this.get(this.idFromName(name));
  }

  jurisdiction() {
    return this;
  }
}

function withSelfhostNamespaces(env) {
  const nextEnv = Object.create(env);
  for (const [bindingName, className] of Object.entries(env.__SELFHOST_DO_BINDINGS || {})) {
    nextEnv[bindingName] = new SelfhostDurableObjectNamespace(
      env.__SELFHOST_DO_DISPATCH,
      env.__SELFHOST_APP_ID,
      className,
    );
  }
  return nextEnv;
}

export default {
  fetch(request, env, ctx) {
    return userDefault.fetch(request, withSelfhostNamespaces(env), ctx);
  }
};
`;

const platformSource = `
import { DurableObject } from "cloudflare:workers";

const USER_WORKER_SOURCE = ${JSON.stringify(userWorkerSource)};
const DYNAMIC_WRAPPER_SOURCE = ${JSON.stringify(dynamicWrapperSource)};
const APP_ID = "counter-app";
const CODE_ID = "counter-app:v1";
const DO_BINDINGS = { COUNTER: "Counter" };
const DO_BRIDGE_SECRET = "selfhost-wfp-facets-smoke-secret";

function loadDynamicWorker(env) {
  return env.LOADER.get(CODE_ID, () => ({
    compatibilityDate: "2026-06-09",
    mainModule: "wrapper.js",
    modules: {
      "wrapper.js": DYNAMIC_WRAPPER_SOURCE,
      "user-worker.js": USER_WORKER_SOURCE,
    },
    env: {
      __SELFHOST_APP_ID: APP_ID,
      __SELFHOST_DO_BINDINGS: DO_BINDINGS,
      __SELFHOST_DO_DISPATCH: env.DO_DISPATCH,
    },
  }));
}

export class AppRunner extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__facet") {
      const className = url.searchParams.get("className");
      const objectId = url.searchParams.get("id");
      if (!className || !objectId) return new Response("missing facet target", { status: 400 });
      const facet = this.ctx.facets.get(className + ":" + objectId, async () => {
        const worker = loadDynamicWorker(this.env);
        return {
          id: objectId,
          class: worker.getDurableObjectClass(className),
        };
      });
      const originalUrl = request.headers.get("x-camelai-selfhost-do-original-url") || request.url;
      const headers = new Headers(request.headers);
      headers.delete("x-camelai-selfhost-do-bridge");
      headers.delete("x-camelai-selfhost-do-original-url");
      const forwardedInit = { method: request.method, headers };
      if (request.method !== "GET" && request.method !== "HEAD") {
        forwardedInit.body = request.body;
      }
      return facet.fetch(new Request(originalUrl, forwardedInit));
    }
    const worker = loadDynamicWorker(this.env);
    return worker.getEntrypoint().fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const appId = url.searchParams.get("appId") || APP_ID;
    const runner = env.RUNNER.get(env.RUNNER.idFromName(appId));
    if (url.pathname === "/__selfhost_do/fetch") {
      if (request.headers.get("x-camelai-selfhost-do-bridge") !== DO_BRIDGE_SECRET) {
        return new Response("not found", { status: 404 });
      }
      const facetUrl = new URL(request.url);
      facetUrl.pathname = "/__facet";
      return runner.fetch(new Request(facetUrl, request));
    }
    return runner.fetch(request);
  }
};
`;

async function writeConfig({ dir, configPath, port }) {
  const outDir = path.dirname(configPath);
  const platformPath = path.join(dir, "platform.js");
  const stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(platformPath, platformSource);

  const config = `using Workerd = import "/workerd/workerd.capnp";

const smoke :Workerd.Config = (
  services = [
    (name = "platform", worker = (
      compatibilityDate = "2026-06-09",
      compatibilityFlags = ["nodejs_compat"],
      modules = [${moduleFile(outDir, "platform.js", platformPath)}],
      bindings = [
        (name = "LOADER", workerLoader = (id = "selfhost-wfp-facets-smoke")),
        (name = "RUNNER", durableObjectNamespace = (className = "AppRunner")),
        (name = "DO_DISPATCH", service = "platform")
      ],
      durableObjectNamespaces = [
        (className = "AppRunner", uniqueKey = "selfhost-wfp-facets-smoke-AppRunner", enableSql = true)
      ],
      durableObjectStorage = (localDisk = "do-storage"),
      globalOutbound = "internet"
    )),
    (name = "do-storage", disk = (path = ${q(stateDir)}, writable = true)),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true)))
  ],
  sockets = [
    (name = "http", address = ${q(`127.0.0.1:${port}`)}, http = (), service = "platform")
  ]
);
`;
  await fs.writeFile(configPath, config);
}

async function main() {
  if (!process.env.SELFHOST_ALLOW_EXPERIMENTAL_WORKER_LOADER && !process.argv.includes("--allow-experimental")) {
    console.warn("Using workerd --experimental for Worker Loader and Durable Object Facets smoke coverage.");
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camelai-wfp-facets-smoke-"));
  const port = await freePort();
  const configPath = path.join(dir, "smoke.capnp");
  await writeConfig({ dir, configPath, port });

  let child;
  try {
    child = spawnLogged(workerdPath, ["serve", "--experimental", configPath]);
    await waitForHttp(`http://127.0.0.1:${port}/?name=main`, child, "workerd facets smoke");

    await assertBody(`http://127.0.0.1:${port}/?name=main`, "2");
    await assertBody(`http://127.0.0.1:${port}/?name=other`, "1");
    await assertBody(`http://127.0.0.1:${port}/?name=main`, "3");

    await stopChild(child);
    child = spawnLogged(workerdPath, ["serve", "--experimental", configPath]);
    await waitForHttp(`http://127.0.0.1:${port}/?name=main`, child, "restarted workerd facets smoke");
    await assertBody(`http://127.0.0.1:${port}/?name=main`, "5");

    console.log("Self-host WFP facets workerd smoke passed.");
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
