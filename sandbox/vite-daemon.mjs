#!/usr/bin/env node
/**
 * Vite Build Daemon (per-project)
 *
 * Run with: yarn node /app/vite-daemon.mjs
 * Caches Vite builder in memory for fast subsequent builds (~2s vs ~19s cold).
 */

import { createServer } from 'net';
import { resolve } from 'path';
import { unlinkSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';

const SOCKET_PATH = '/tmp/vite-build.sock';
const STATE_PATH = '/tmp/vite-build.state';
const projectPath = process.cwd();

// Use createRequire to resolve vite from the PROJECT's dependencies (works with PnP)
const require = createRequire(resolve(projectPath, 'package.json'));
const { createBuilder } = require('vite');

let builder = null;
let configHash = null;

// Mutable socket for shared logger
let currentSocket = null;

// Write state so clients know which project we're serving
writeFileSync(STATE_PATH, JSON.stringify({ projectPath, pid: process.pid }));
console.log('[vite-daemon] Started for: ' + projectPath);

function getConfigHash() {
  const hash = createHash('md5');
  // Include all files that affect the build output
  const files = ['vite.config.ts', 'wrangler.toml', 'wrangler.jsonc', 'wrangler.json', 'package.json', 'yarn.lock'];
  for (const file of files) {
    const path = resolve(projectPath, file);
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  return hash.digest('hex').slice(0, 12);
}

async function getBuilder() {
  const newHash = getConfigHash();

  if (configHash === newHash && builder) {
    return { builder, cacheHit: true };
  }

  if (builder) {
    console.log('[vite-daemon] Config changed, rebuilding...');
    await builder.close?.().catch(() => {});
  }

  console.log('[vite-daemon] Loading builder...');
  const start = Date.now();

  builder = await createBuilder({
    configFile: resolve(projectPath, 'vite.config.ts'),
    root: projectPath,
    logLevel: 'info',
    customLogger: sharedLogger,
  });

  configHash = newHash;
  console.log('[vite-daemon] Ready in ' + (Date.now() - start) + 'ms');
  return { builder, cacheHit: false };
}

// Shared logger that writes to currentSocket (set per-request)
const sharedLogger = {
  info: msg => sendLog('info', msg),
  warn: msg => sendLog('warn', msg),
  error: msg => sendLog('error', msg),
  warnOnce: msg => sendLog('warn', msg),
  clearScreen: () => {},
  hasWarned: false,
  hasErrorLogged: () => false,
};

function sendLog(level, msg) {
  if (currentSocket) {
    try { currentSocket.write(JSON.stringify({ type: 'log', level, message: msg }) + '\n'); } catch {}
  }
}

// Clean up old socket
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

const server = createServer(socket => {
  let data = '';
  socket.on('data', chunk => {
    data += chunk;
    const lines = data.split('\n');
    data = lines.pop();
    lines.filter(l => l.trim()).forEach(line => handleRequest(socket, line));
  });
  socket.on('error', () => {});
});

async function handleRequest(socket, message) {
  currentSocket = socket;

  try {
    const { action } = JSON.parse(message);

    if (action === 'ping') {
      socket.write(JSON.stringify({ success: true, projectPath }) + '\n');
    } else if (action === 'warmup') {
      const start = Date.now();
      await getBuilder();
      socket.write(JSON.stringify({ success: true, action: 'warmup', duration: Date.now() - start }) + '\n');
    } else {
      const start = Date.now();
      const { builder: b, cacheHit } = await getBuilder();
      await b.buildApp();
      const total = Date.now() - start;
      socket.write(JSON.stringify({ success: true, duration: total, cacheHit }) + '\n');
    }
  } catch (err) {
    console.error('[vite-daemon] Error:', err.message);
    socket.write(JSON.stringify({ success: false, error: err.message }) + '\n');
  } finally {
    currentSocket = null;
  }
  socket.end();
}

server.listen(SOCKET_PATH, () => console.log('[vite-daemon] Listening'));
server.on('error', err => { console.error('[vite-daemon] Server error:', err.message); process.exit(1); });

async function shutdown() {
  console.log('[vite-daemon] Shutting down...');
  await builder?.close?.().catch(() => {});
  server.close(() => {
    try { unlinkSync(SOCKET_PATH); unlinkSync(STATE_PATH); } catch {}
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
