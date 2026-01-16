import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import process from 'node:process';
import httpProxy from 'http-proxy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track all spawned processes for cleanup
const children = [];

function getPackageVersion(pkg) {
  try {
    const output = execSync(`npm list ${pkg} --depth=0 --json`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const json = JSON.parse(output);
    return json.dependencies?.[pkg]?.version || 'not found';
  } catch {
    return 'not found';
  }
}

function printVersions() {
  const wranglerVersion = getPackageVersion('wrangler');
  const openNextVersion = getPackageVersion('@opennextjs/cloudflare');
  console.log(`[dev-proxy] wrangler: ${wranglerVersion}`);
  console.log(`[dev-proxy] @opennextjs/cloudflare: ${openNextVersion}`);
}

const nextPort = Number(process.env.NEXT_DEV_PORT || 3001);
const wranglerPort = Number(process.env.WRANGLER_DEV_PORT || 8787);
const proxyPort = Number(process.env.PROXY_DEV_PORT || 3100);
const llmProxyPort = Number(process.env.LLM_PROXY_DEV_PORT || 8790);

const nextTarget = `http://localhost:${nextPort}`;
const wranglerTarget = `http://localhost:${wranglerPort}`;
const llmProxyTarget = `http://localhost:${llmProxyPort}`;

// Kill any zombie processes on our ports before starting
function killZombiesOnPorts(ports) {
  for (const port of ports) {
    try {
      // lsof returns PIDs listening on this port
      const output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const pids = output.trim().split('\n').filter(Boolean);
      if (pids.length > 0) {
        console.log(`[dev-proxy] killing zombie processes on port ${port}: ${pids.join(', ')}`);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            // Process may have already exited
          }
        }
      }
    } catch {
      // No processes on this port, which is fine
    }
  }
}

// Kill zombies before we start
killZombiesOnPorts([proxyPort, nextPort, wranglerPort, llmProxyPort]);

printVersions();

function spawnCommand(command, args, { name, env = process.env } = {}) {
  const resolvedEnv = env;
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: resolvedEnv,
    // Don't detach - we want children to die with the parent
  });
  child.on('exit', (code, signal) => {
    // Remove from tracked children
    const idx = children.indexOf(child);
    if (idx !== -1) children.splice(idx, 1);
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
  });
  children.push(child);
  return child;
}

// Start Docker API proxy for FUSE support in containers
const dockerProxySocket = '/tmp/docker-fuse-proxy.sock';
const dockerProxyProcess = spawnCommand(
  'node',
  [path.join(__dirname, 'docker-api-proxy.mjs')],
  { name: 'docker-proxy' }
);

// Give proxy a moment to start
await new Promise(resolve => setTimeout(resolve, 500));

const wranglerEnv = {
  ...process.env,
  DOCKER_HOST: `unix://${dockerProxySocket}`,
};

const wranglerProcess = spawnCommand(
  'wrangler',
  [
    'dev',
    '-c',
    'wrangler.jsonc',
    '--port',
    String(wranglerPort),
  ],
  { name: 'wrangler dev', env: wranglerEnv }
);

const llmProxyProcess = spawnCommand(
  'wrangler',
  [
    'dev',
    '-c',
    path.join('workers', 'proxy', 'wrangler.jsonc'),
    '--port',
    String(llmProxyPort),
    '--inspector-port',
    '9228',
  ],
  { name: 'llm proxy dev', env: process.env }
);

function waitForWranglerReady({ timeoutMs = 30000, intervalMs = 500 } = {}) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(wranglerTarget, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('Timed out waiting for wrangler dev to be ready'));
          return;
        }
        setTimeout(tryOnce, intervalMs);
      });
      req.on('timeout', () => {
        req.destroy();
      });
    };

    tryOnce();
  });
}

let nextProcess = null;
waitForWranglerReady()
  .then(() => {
    console.log('[dev-proxy] wrangler dev ready, starting next dev...');
    nextProcess = spawnCommand('next', ['dev', '-p', String(nextPort)], { name: 'next dev' });
  })
  .catch((err) => {
    console.error('[dev-proxy] failed waiting for wrangler dev:', err);
  });

const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on('error', (err, _req, resOrSocket) => {
  if (!resOrSocket) {
    console.error('[dev-proxy] proxy error:', err);
    return;
  }

  if ('writeHead' in resOrSocket) {
    if (!resOrSocket.headersSent) {
      resOrSocket.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    resOrSocket.end('Proxy error');
  } else if ('end' in resOrSocket) {
    resOrSocket.end();
  }

  console.error('[dev-proxy] proxy error:', err);
});

// Determine if a request should be routed to wrangler instead of Next.js
function shouldRouteToWrangler(req) {
  if (!req.url) return false;
  // WebSocket and Cloudflare client API routes
  if (req.url.startsWith('/ws/') || req.url.startsWith('/client/v4/')) {
    return true;
  }
  // Preview API POST - handled by worker with deploy token auth
  if (req.method === 'POST' && /^\/api\/threads\/[^/]+\/preview/.test(req.url)) {
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const isWrangler = shouldRouteToWrangler(req);
  const target = isWrangler ? wranglerTarget : nextTarget;
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto'];
  proxy.web(req, res, {
    target,
    changeOrigin: isWrangler,
    headers: isWrangler
      ? undefined
      : {
          'x-forwarded-host': req.headers.host ?? `localhost:${proxyPort}`,
          'x-forwarded-proto': forwardedProto ?? 'http',
        },
  });
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => {
    console.error('[dev-proxy] socket error:', err.message);
  });
  const isWrangler = shouldRouteToWrangler(req);
  const target = isWrangler ? wranglerTarget : nextTarget;
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto'];
  console.log('[dev-proxy] WebSocket upgrade:', req.url, '->', target);
  proxy.ws(req, socket, head, {
    target,
    changeOrigin: isWrangler,
    headers: isWrangler
      ? undefined
      : {
          'x-forwarded-host': req.headers.host ?? `localhost:${proxyPort}`,
          'x-forwarded-proto': forwardedProto ?? 'http',
        },
  });
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.listen(proxyPort, '0.0.0.0', () => {
  console.log(`[dev-proxy] next dev -> ${nextTarget}`);
  console.log(`[dev-proxy] wrangler dev -> ${wranglerTarget}`);
  console.log(`[dev-proxy] llm proxy dev -> ${llmProxyTarget}`);
  console.log(`[dev-proxy] proxy listening on http://0.0.0.0:${proxyPort}`);
});

let isShuttingDown = false;

// Synchronous cleanup for use in 'exit' handler (can't use async/setTimeout there)
function forceKillChildren() {
  for (const child of children) {
    if (child.pid && !child.killed) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Process may have already exited
      }
    }
  }
  killZombiesOnPorts([proxyPort, nextPort, wranglerPort, llmProxyPort]);
}

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('\n[dev-proxy] shutting down...');

  // Close the proxy server
  server.close();

  // First, send SIGTERM to all children
  for (const child of children) {
    if (child.pid && !child.killed) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
  }

  // Give processes a moment to exit gracefully, then force kill
  setTimeout(() => {
    forceKillChildren();
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle crashes and unexpected exits - use sync cleanup since we're exiting
process.on('exit', forceKillChildren);
process.on('uncaughtException', (err) => {
  console.error('[dev-proxy] uncaught exception:', err);
  forceKillChildren();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[dev-proxy] unhandled rejection:', err);
});
