import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const rendererPort = process.env.DESKTOP_RENDERER_PORT || '4316';
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const repoRoot = resolve(import.meta.dirname, '..', '..');
const defaultApplianceDiskPath = resolve(repoRoot, 'desktop/.local/vm/disk.raw');
const electronUserDataDir =
  process.env.DESKTOP_USER_DATA_DIR || join(homedir(), 'Library/Application Support/Electron');
const electronDataDir = resolve(electronUserDataDir, 'data');
const electronVmDir = resolve(electronUserDataDir, 'vm');
const tailedChildren = [];

if (!existsSync(defaultApplianceDiskPath) && !process.env.DESKTOP_VM_APPLIANCE_IMAGE_PATH) {
  throw new Error(
    `Desktop VM appliance is missing at ${defaultApplianceDiskPath}. Run \`bun run desktop:appliance:bake\` first or set DESKTOP_VM_APPLIANCE_IMAGE_PATH.`,
  );
}

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
mkdirSync(resolve(electronVmDir, 'shared/logs'), { recursive: true });

tailFile('desktop-backend-log', resolve(electronDataDir, 'logs/desktop-backend.log'));
tailFile('desktop-guest-runtime', resolve(electronVmDir, 'shared/logs/runtime-setup.log'));
tailFile('desktop-guest-service', resolve(electronVmDir, 'shared/logs/guest-control-plane-service.log'));
tailFile('desktop-guest', resolve(electronVmDir, 'shared/logs/guest-control-plane.log'));

const renderer = run('renderer', 'bun', ['x', 'vite', '--config', 'desktop/vite.config.ts', '--port', rendererPort], {
  DESKTOP_RENDERER_PORT: rendererPort,
});

await waitForUrl(rendererUrl);

const electron = run('electron', 'bun', ['x', 'electron', 'desktop/electron/main.mjs'], {
  DESKTOP_RENDERER_URL: rendererUrl,
  DESKTOP_STDERR_LOG_LEVEL: process.env.DESKTOP_STDERR_LOG_LEVEL || 'info',
  DESKTOP_FORCE_SYNC_GUEST_BUNDLE: '1',
  DESKTOP_VM_APPLIANCE_IMAGE_PATH:
    process.env.DESKTOP_VM_APPLIANCE_IMAGE_PATH ||
    defaultApplianceDiskPath,
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
