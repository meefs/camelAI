import { spawn } from 'node:child_process';

const rendererPort = process.env.DESKTOP_RENDERER_PORT || '4316';
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const staged = process.argv.includes('--staged');

function run(command, args, env = {}) {
  return spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function waitForUrl(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function captureProcess(child) {
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const result = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    ...result,
    stdout,
    stderr,
  };
}

let renderer = null;

try {
  if (!staged) {
    renderer = run('bun', ['x', 'vite', '--config', 'desktop/vite.config.ts', '--port', rendererPort], {
      DESKTOP_RENDERER_PORT: rendererPort,
    });
    await waitForUrl(rendererUrl);
  }

  const electron = run(
    'bun',
    ['x', 'electron', 'desktop/electron/main.mjs'],
    staged
      ? {
          DESKTOP_STARTUP_PROBE: '1',
          DESKTOP_NO_DEVTOOLS: '1',
          DESKTOP_APP_RESOURCES_DIR: 'desktop/app-resources',
        }
      : {
          DESKTOP_RENDERER_URL: rendererUrl,
          DESKTOP_STARTUP_PROBE: '1',
          DESKTOP_NO_DEVTOOLS: '1',
        }
  );

  const result = await captureProcess(electron);

  if (renderer && renderer.exitCode === null) {
    renderer.kill('SIGTERM');
  }

  if (result.code !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Electron probe exited with code ${result.code ?? 'null'}.\n`);
    process.exit(result.code ?? 1);
  }

  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) {
    process.stderr.write(`${JSON.stringify(parsed, null, 2)}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
} catch (error) {
  if (renderer && renderer.exitCode === null) {
    renderer.kill('SIGTERM');
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
