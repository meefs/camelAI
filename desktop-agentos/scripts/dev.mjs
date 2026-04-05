import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const defaultRendererPort = Number.parseInt(
  process.env.DESKTOP_RENDERER_PORT || "4316",
  10,
);
const repoRoot = resolve(import.meta.dirname, "..", "..");
const electronUserDataDir =
  process.env.DESKTOP_AGENTOS_USER_DATA_DIR ||
  join(homedir(), "Library/Application Support", "camelAI AgentOS");
const electronDataDir = resolve(electronUserDataDir, "data");
const electronRuntimeDir = resolve(electronUserDataDir, "runtime");
const tailedChildren = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
    },
  });
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      console.error(
        `[${name}] exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
      );
      process.exit(code ?? 1);
    }
  });
  return child;
}

function prefixAndPipe(stream, prefix) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) {
        process.stdout.write(`${prefix} ${line}\n`);
      }
    }
  });
  stream.on("end", () => {
    if (buffered.length > 0) {
      process.stdout.write(`${prefix} ${buffered}\n`);
    }
  });
}

function tailFile(label, filePath) {
  const child = spawn("tail", ["-n", "0", "-F", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  prefixAndPipe(child.stdout, `[${label}]`);
  prefixAndPipe(child.stderr, `[${label}]`);
  tailedChildren.push(child);
  return child;
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function reservePort(port) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (code === "EADDRINUSE") {
          resolvePromise(null);
          return;
        }
      }
      rejectPromise(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => resolvePromise(null));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
  });
}

async function resolveRendererPort(preferredPort) {
  const preferred = await reservePort(preferredPort);
  if (preferred) {
    return preferred;
  }

  const fallback = await reservePort(0);
  if (!fallback) {
    throw new Error("Unable to find a free renderer port for desktop-agentos.");
  }

  process.stdout.write(
    `[desktop-agentos-dev] renderer port ${preferredPort} is busy, using ${fallback}\n`,
  );
  return fallback;
}

mkdirSync(resolve(electronDataDir, "logs"), { recursive: true });
mkdirSync(electronRuntimeDir, { recursive: true });
const backendLogPath = resolve(electronDataDir, "logs/desktop-backend.log");
writeFileSync(backendLogPath, "", { flag: "a" });

const rendererPort = `${await resolveRendererPort(defaultRendererPort)}`;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

tailFile("desktop-agentos-backend-log", backendLogPath);

const renderer = run(
  "renderer",
  "bun",
  [
    "x",
    "vite",
    "--config",
    "desktop/vite.config.ts",
    "--port",
    rendererPort,
    "--strictPort",
  ],
  {
    DESKTOP_RENDERER_PORT: rendererPort,
  },
);

await waitForUrl(rendererUrl);

const electron = run(
  "electron",
  "bun",
  ["x", "electron", "desktop-agentos/electron/main.mjs"],
  {
    DESKTOP_RENDERER_URL: rendererUrl,
    DESKTOP_STDERR_LOG_LEVEL: process.env.DESKTOP_STDERR_LOG_LEVEL || "info",
    DESKTOP_USER_DATA_DIR: electronUserDataDir,
    DESKTOP_DATA_DIR: electronDataDir,
    DESKTOP_RUNTIME_DIR: electronRuntimeDir,
    DESKTOP_AGENTOS_WORKSPACE_DIR:
      process.env.DESKTOP_AGENTOS_WORKSPACE_DIR || repoRoot,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      "--import",
      "tsx/esm",
    ]
      .filter(Boolean)
      .join(" "),
  },
);

const shutdown = () => {
  electron.kill("SIGTERM");
  renderer.kill("SIGTERM");
  for (const child of tailedChildren) {
    child.kill("SIGTERM");
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
