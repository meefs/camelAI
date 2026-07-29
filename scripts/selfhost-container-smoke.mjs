#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workerdPath = path.join(repoRoot, "node_modules/workerd/bin/workerd");
const egressImage =
  process.env.SELFHOST_CONTAINER_EGRESS_IMAGE ||
  "camelai-selfhost-container-egress:0.12.0";
const socketUri =
  process.env.SELFHOST_DOCKER_SOCKET_URI || "unix:///var/run/docker.sock";
const notebook = Buffer.from(
  JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ["print(6 * 7)"],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }),
).toString("base64");
const runtimes = {
  project: {
    className: "ProjectBuildSandbox",
    image:
      process.env.SELFHOST_PROJECT_BUILD_IMAGE ||
      "camelai-selfhost-project-build:0.12.0",
    command:
      "printf 'console.log(\"camelai-project-build-ok\")' > /tmp/smoke.ts " +
      "&& bun build /tmp/smoke.ts --outfile /tmp/smoke.js >/dev/null " +
      "&& node /tmp/smoke.js",
    marker: "camelai-project-build-ok",
  },
  analysis: {
    className: "AnalysisSandbox",
    image:
      process.env.SELFHOST_ANALYSIS_IMAGE ||
      "camelai-selfhost-analysis:0.12.0",
    command:
      `printf '%s' '${notebook}' | base64 -d > /tmp/smoke.ipynb ` +
      "&& python /usr/local/bin/execute-notebook /tmp/smoke.ipynb " +
      `&& python -c "import json; d=json.load(open('/tmp/smoke.ipynb')); ` +
      `assert ''.join(d['cells'][0]['outputs'][0]['text']) == '42\\\\n'; ` +
      `print('camelai-analysis-notebook-ok')"`,
    marker: "camelai-analysis-notebook-ok",
  },
  "db-query": {
    className: "DbQuerySandbox",
    image:
      process.env.SELFHOST_DB_QUERY_IMAGE ||
      "camelai-selfhost-db-query:0.12.0",
    command:
      "cd /opt/db-query-runner && node -e " +
      `"for (const m of ['pg','pg-cursor','mysql2','tedious','@dsnp/parquetjs','socks']) ` +
      `require.resolve(m); console.log('camelai-db-query-drivers-ok')"`,
    marker: "camelai-db-query-drivers-ok",
  },
};
const runtimeName = process.argv[2] || "project";
const runtime = runtimes[runtimeName];
if (!runtime) {
  throw new Error(
    `Unknown runtime ${runtimeName}; expected ${Object.keys(runtimes).join(", ")}`,
  );
}
if (runtimeName === "analysis") {
  const dockerInfo = await capture("docker", [
    "info",
    "--format",
    "{{.Architecture}}",
  ]);
  const architecture = dockerInfo.stdout.trim();
  if (architecture !== "x86_64" && architecture !== "amd64") {
    console.log(
      `SKIP self-host analysis container smoke on ${architecture}: ` +
        "Cloudflare's analysis sandbox base is amd64-only and Jupyter is " +
        "unreliable under emulation; x86_64 CI is authoritative.",
    );
    process.exit(0);
  }
}

const smokeRoot = path.join(repoRoot, ".selfhost");
await fs.mkdir(smokeRoot, { recursive: true });
const tempDir = await fs.mkdtemp(
  path.join(smokeRoot, "container-smoke-"),
);
const sourcePath = path.join(tempDir, "smoke.ts");
const bundlePath = path.join(tempDir, "smoke.js");
const configPath = path.join(tempDir, "smoke.capnp");
const statePath = path.join(tempDir, "state");
let child;

try {
  await fs.mkdir(statePath);
  await fs.writeFile(
    sourcePath,
    `
import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox";

export { ContainerProxy };
export class ${runtime.className} extends Sandbox {}

export default {
  async fetch(_request, env) {
    const sandbox = getSandbox(
      env.SANDBOX,
      "selfhost-local-docker-smoke-${runtimeName}",
    );
    try {
      const result = await sandbox.exec(${JSON.stringify(runtime.command)});
      return Response.json(result);
    } finally {
      await sandbox.destroy();
    }
  },
};
`,
  );

  await run("bun", [
    "build",
    sourcePath,
    "--target=browser",
    "--format=esm",
    "--external=cloudflare:workers",
    `--outfile=${bundlePath}`,
  ]);

  await fs.writeFile(
    configPath,
    `using Workerd = import "/workerd/workerd.capnp";

const smoke :Workerd.Config = (
  services = [
    (name = "smoke", worker = (
      compatibilityDate = "2026-06-09",
      compatibilityFlags = ["nodejs_compat"],
      modules = [(name = "smoke.js", esModule = embed "smoke.js")],
      bindings = [
        (name = "SANDBOX", durableObjectNamespace = (
          className = ${JSON.stringify(runtime.className)}
        ))
      ],
      globalOutbound = "internet",
      durableObjectNamespaces = [(
        className = ${JSON.stringify(runtime.className)},
        uniqueKey = ${JSON.stringify(`camelai-selfhost-container-smoke-${runtimeName}`)},
        enableSql = true,
        container = (imageName = ${JSON.stringify(runtime.image)})
      )],
      durableObjectStorage = (localDisk = "do-storage"),
      containerEngine = (localDocker = (
        socketPath = ${JSON.stringify(socketUri)},
        containerEgressInterceptorImage = ${JSON.stringify(egressImage)}
      ))
    )),
    (name = "do-storage", disk = (
      path = ${JSON.stringify(statePath)},
      writable = true
    )),
    (name = "internet", network = (
      allow = ["public", "private"],
      tlsOptions = (trustBrowserCas = true)
    ))
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:0", http = (), service = "smoke")
  ]
);
`,
  );

  await run(
    workerdPath,
    ["compile", "--config-only", configPath],
    ["ignore", "ignore", "inherit"],
  );
  const port = await availablePort();
  const logs = [];
  child = spawn(
    workerdPath,
    [
      "serve",
      configPath,
      "smoke",
      "--experimental",
      `--socket-addr=http=127.0.0.1:${port}`,
    ],
    {
      cwd: tempDir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const response = await poll(`http://127.0.0.1:${port}/`, child, logs);
  const result = await response.json();
  if (!result.success || !result.stdout.includes(runtime.marker)) {
    throw new Error(`Unexpected sandbox response: ${JSON.stringify(result)}`);
  }
  console.log(
    `Self-host ${runtimeName} localDocker smoke passed with ${runtime.image}.`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await cleanupSmokeContainers();
  await fs.rm(tempDir, { recursive: true, force: true });
}

function run(command, args, stdio = "inherit") {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      cwd: repoRoot,
      stdio,
    });
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function cleanupSmokeContainers() {
  const namePrefix =
    `workerd-camelai-selfhost-container-smoke-${runtimeName}`;
  // workerd can exit just before its egress sidecar appears in Docker. Poll
  // briefly so the smoke never leaks that late-created container into CI.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ids = await listSmokeContainerIds(namePrefix);
    if (ids.length > 0) {
      await removeSmokeContainers(ids);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const remaining = await listSmokeContainerIds(namePrefix);
  if (remaining.length > 0) {
    throw new Error(
      `Failed to clean up smoke containers: ${remaining.join(", ")}`,
    );
  }
}

async function listSmokeContainerIds(namePrefix) {
  try {
    const listed = await capture("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=${namePrefix}`,
    ]);
    return listed.stdout.trim().split(/\s+/).filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const containers = await dockerApi(
      "GET",
      `/containers/json?all=1&filters=${encodeURIComponent(
        JSON.stringify({ name: [namePrefix] }),
      )}`,
    );
    return containers.map((container) => container.Id);
  }
}

async function removeSmokeContainers(ids) {
  try {
    await run(
      "docker",
      ["rm", "--force", ...ids],
      ["ignore", "ignore", "inherit"],
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await Promise.all(
      ids.map((id) =>
        dockerApi("DELETE", `/containers/${encodeURIComponent(id)}?force=1`),
      ),
    );
  }
}

function dockerApi(method, requestPath) {
  if (!socketUri.startsWith("unix:///")) {
    throw new Error(
      "Docker CLI is unavailable and SELFHOST_DOCKER_SOCKET_URI is not a unix:/// socket",
    );
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method,
        path: requestPath,
        socketPath: socketUri.slice("unix://".length),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve(body ? JSON.parse(body) : null);
            return;
          }
          reject(
            new Error(
              `Docker API ${method} ${requestPath} returned ` +
                `${response.statusCode}: ${body}`,
            ),
          );
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    childProcess.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    childProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
      } else {
        reject(
          new Error(
            `${command} exited with ${code}: ${stderr.join("").trim()}`,
          ),
        );
      }
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a smoke-test port");
  return port;
}

async function poll(url, workerd, logs) {
  const deadline = Date.now() + 240_000;
  let lastError;
  while (Date.now() < deadline) {
    if (workerd.exitCode !== null) {
      throw new Error(
        `workerd exited with ${workerd.exitCode}\n${logs.join("").slice(-8000)}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(180_000),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Container smoke timed out: ${lastError?.message ?? "no response"}\n` +
      logs.join("").slice(-8000),
  );
}
