import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';

const rendererPort = process.env.DESKTOP_RENDERER_PORT || '4316';
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const repoRoot = resolve(import.meta.dirname, '..', '..');
const defaultDevRuntimeImage = 'docker.io/vercantes/camelai-openwork:20260404-v5';
const electronUserDataDir =
  process.env.DESKTOP_USER_DATA_DIR || join(homedir(), 'Library/Application Support/Electron');
const electronDataDir = resolve(electronUserDataDir, 'data');
const electronRuntimeDir = resolve(electronUserDataDir, 'runtime');
const tailedChildren = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
    },
  });
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`[${name}] exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      process.exit(code ?? 1);
    }
  });
  return child;
}

function runAndWait(command, args, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
      },
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(' ')} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
        ),
      );
    });
    child.on('error', rejectPromise);
  });
}

function prefixAndPipe(stream, prefix) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        process.stdout.write(`${prefix} ${line}\n`);
      }
    }
  });
  stream.on('end', () => {
    if (buffered.length > 0) {
      process.stdout.write(`${prefix} ${buffered}\n`);
    }
  });
}

function tailFile(label, filePath) {
  const child = spawn('tail', ['-n', '0', '-F', filePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
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
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function requestHelper(socketPath, command, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = createConnection(socketPath);

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const finishOk = (value) => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(value);
    };

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: `dev-${command}-${Date.now()}`, command })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        finishError(new Error('Runtime helper daemon returned an empty response.'));
        return;
      }
      try {
        const parsed = JSON.parse(line);
        if (!parsed.ok || !parsed.result) {
          finishError(new Error(parsed.error || 'Runtime helper daemon returned an error.'));
          return;
        }
        finishOk(parsed.result);
      } catch (error) {
        finishError(error instanceof Error ? error : new Error('Invalid helper daemon response.'));
      }
    });
    socket.once('error', finishError);
    socket.once('end', () => {
      if (!settled) {
        finishError(new Error('Runtime helper daemon closed the connection unexpectedly.'));
      }
    });
    socket.setTimeout(timeoutMs, () => {
      finishError(new Error(`Timed out waiting for helper daemon ${command} response.`));
    });
  });
}

async function stopExistingRuntime(runtimeDir) {
  const socketPath = resolve(runtimeDir, 'artifacts/helper.sock');
  if (!existsSync(socketPath)) {
    return;
  }

  try {
    await requestHelper(socketPath, 'stop');
    process.stdout.write('[desktop-dev] stopped existing local runtime\n');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stdout.write(`[desktop-dev] failed to stop existing local runtime: ${detail}\n`);
  }
}

mkdirSync(resolve(electronDataDir, 'logs'), { recursive: true });
mkdirSync(resolve(electronRuntimeDir, 'shared/logs'), { recursive: true });
mkdirSync(resolve(electronRuntimeDir, 'shared/runtime'), { recursive: true });

await runAndWait('node', ['desktop/scripts/prepare-runtime-helper.mjs']);
await runAndWait('node', ['desktop/scripts/prepare-control-plane-deps.mjs']);

await stopExistingRuntime(electronRuntimeDir);

tailFile('desktop-backend-log', resolve(electronDataDir, 'logs/desktop-backend.log'));
tailFile('desktop-runtime-service', resolve(electronRuntimeDir, 'shared/logs/control-plane-service.log'));
tailFile('desktop-runtime-control-plane', resolve(electronRuntimeDir, 'shared/logs/control-plane.log'));
tailFile('desktop-runtime-sdk', resolve(electronRuntimeDir, 'shared/logs/claude-sdk-debug.log'));

const renderer = run('renderer', 'bun', ['x', 'vite', '--config', 'desktop/vite.config.ts', '--port', rendererPort], {
  DESKTOP_RENDERER_PORT: rendererPort,
});

await waitForUrl(rendererUrl);

const electron = run('electron', 'bun', ['x', 'electron', 'desktop/electron/main.mjs'], {
  DESKTOP_RENDERER_URL: rendererUrl,
  DESKTOP_STDERR_LOG_LEVEL: process.env.DESKTOP_STDERR_LOG_LEVEL || 'info',
  DESKTOP_USER_DATA_DIR: electronUserDataDir,
  DESKTOP_RUNTIME_DIR: electronRuntimeDir,
  DESKTOP_RUNTIME_IMAGE:
    process.env.DESKTOP_RUNTIME_IMAGE || defaultDevRuntimeImage,
  DESKTOP_RUNTIME_HELPER_PATH:
    process.env.DESKTOP_RUNTIME_HELPER_PATH ||
    resolve(repoRoot, 'desktop/runtime-helper/.build/debug/camelai-runtime-helper'),
  DESKTOP_RUNTIME_KERNEL_PATH:
    process.env.DESKTOP_RUNTIME_KERNEL_PATH ||
    resolve(repoRoot, 'desktop/runtime-helper/assets/vmlinux'),
  DESKTOP_RUNTIME_LOCAL_CONTROL_PLANE_SOURCE:
    process.env.DESKTOP_DISABLE_LOCAL_CONTROL_PLANE_OVERRIDE === '1'
      ? ''
      : resolve(repoRoot, 'desktop/control-plane/control-plane.mjs'),
  DESKTOP_RUNTIME_SHUTDOWN_ON_EXIT:
    process.env.DESKTOP_RUNTIME_SHUTDOWN_ON_EXIT || '1',
});

const shutdown = () => {
  electron.kill('SIGTERM');
  renderer.kill('SIGTERM');
  for (const child of tailedChildren) {
    child.kill('SIGTERM');
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
