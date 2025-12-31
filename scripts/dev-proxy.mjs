import http from 'node:http';
import { spawn } from 'node:child_process';
import process from 'node:process';
import httpProxy from 'http-proxy';

const nextPort = Number(process.env.NEXT_DEV_PORT || 3001);
const wranglerPort = Number(process.env.WRANGLER_DEV_PORT || 8787);
const proxyPort = Number(process.env.PROXY_DEV_PORT || 3100);

const nextTarget = `http://localhost:${nextPort}`;
const wranglerTarget = `http://localhost:${wranglerPort}`;

function spawnCommand(command, args, { name }) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });
  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
  });
  return child;
}

const wranglerProcess = spawnCommand(
  'wrangler',
  ['dev', '-c', 'wrangler.jsonc', '--local', '--port', String(wranglerPort)],
  { name: 'wrangler dev' }
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

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

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

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const target =
    req.url && (
      req.url.startsWith('/ws/') ||
      req.url.startsWith('/client/v4/') ||
      req.url.startsWith('/api/sandbox/preview') ||
      req.url.startsWith('/preview/')
    )
      ? wranglerTarget
      : nextTarget;
  proxy.web(req, res, { target });
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => {
    console.error('[dev-proxy] socket error:', err.message);
  });
  const target =
    req.url && (
      req.url.startsWith('/ws/') ||
      req.url.startsWith('/client/v4/') ||
      req.url.startsWith('/api/sandbox/preview') ||
      req.url.startsWith('/preview/')
    )
      ? wranglerTarget
      : nextTarget;
  console.log('[dev-proxy] WebSocket upgrade:', req.url, '->', target);
  proxy.ws(req, socket, head, { target });
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.listen(proxyPort, () => {
  console.log(`[dev-proxy] next dev -> ${nextTarget}`);
  console.log(`[dev-proxy] wrangler dev -> ${wranglerTarget}`);
  console.log(`[dev-proxy] proxy listening on http://localhost:${proxyPort}`);
});

function shutdown() {
  server.close();
  if (nextProcess?.pid) process.kill(-nextProcess.pid, 'SIGINT');
  if (wranglerProcess?.pid) process.kill(-wranglerProcess.pid, 'SIGINT');
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
process.on('exit', () => {
  shutdown();
});
