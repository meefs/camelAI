import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const rendererPort = process.env.DESKTOP_RENDERER_PORT || '4316';
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const repoRoot = resolve(import.meta.dirname, '..', '..');
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

mkdirSync(resolve(electronDataDir, 'logs'), { recursive: true });
mkdirSync(resolve(electronRuntimeDir, 'shared/logs'), { recursive: true });
mkdirSync(resolve(electronRuntimeDir, 'shared/runtime'), { recursive: true });

await runAndWait('node', ['desktop/scripts/prepare-runtime-helper.mjs']);

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
  DESKTOP_RUNTIME_HELPER_PATH:
    process.env.DESKTOP_RUNTIME_HELPER_PATH ||
    resolve(repoRoot, 'desktop/runtime-helper/.build/debug/camelai-runtime-helper'),
  DESKTOP_RUNTIME_KERNEL_PATH:
    process.env.DESKTOP_RUNTIME_KERNEL_PATH ||
    resolve(repoRoot, 'desktop/runtime-helper/assets/vmlinux'),
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
