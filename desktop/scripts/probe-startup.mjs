import { spawn } from 'node:child_process';

const rendererPort = process.env.DESKTOP_RENDERER_PORT || '4316';
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.env,
      },
      cwd: options.cwd || process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          [
            `${command} ${args.join(' ')} failed with code ${code ?? 'null'} signal ${signal ?? 'null'}.`,
            stderr.trim(),
            stdout.trim(),
          ]
            .filter(Boolean)
            .join('\n')
        )
      );
    });
  });
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const cwd = process.cwd();

const renderer = spawn(
  'bun',
  ['x', 'vite', '--config', 'desktop/vite.config.ts', '--port', rendererPort],
  {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DESKTOP_RENDERER_PORT: rendererPort,
    },
  }
);

let rendererStderr = '';
renderer.stderr.setEncoding('utf8');
renderer.stderr.on('data', (chunk) => {
  rendererStderr += chunk;
});

try {
  await waitForUrl(rendererUrl);

  const { stdout, stderr } = await run(
    'bun',
    ['x', 'electron', 'desktop/electron/main.mjs'],
    {
      cwd,
      env: {
        DESKTOP_STARTUP_PROBE: '1',
        DESKTOP_NO_DEVTOOLS: '1',
        DESKTOP_RENDERER_URL: rendererUrl,
      },
    }
  );

  if (rendererStderr.trim()) {
    process.stderr.write(rendererStderr);
  }
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }

  process.stdout.write(stdout);
} finally {
  renderer.kill('SIGTERM');
}
