#!/usr/bin/env node
/**
 * Vite Build Daemon
 *
 * Keeps one Vite builder warm in memory. Starts on first build, stays alive.
 *
 * Start:    yarn node /app/vite-daemon.mjs [project-path]
 * Build:    yarn node /app/vite-build.mjs
 * Warmup:   yarn node /app/vite-build.mjs --warmup
 */

import { createServer } from 'net';
import { resolve } from 'path';
import { unlinkSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const SOCKET = '/tmp/vite-build.sock';
const STATE = '/tmp/vite-build.state';
const BUILD_TIMEOUT = 180_000; // 3 minutes max

const projectPath = process.argv[2] || process.cwd();

// Load vite from project's node_modules (uses CJS require for Yarn PnP compatibility)
const require = createRequire(resolve(projectPath, 'package.json'));
const { createBuilder } = require('vite');

let builder = null;
let building = false;

// Write state file so clients know what project we're serving
function writeState() {
  writeFileSync(STATE, JSON.stringify({ projectPath, pid: process.pid }));
}

// Initialize builder
async function init() {
  const start = Date.now();
  console.log(`[daemon] Initializing for ${projectPath}`);

  builder = await createBuilder({
    configFile: resolve(projectPath, 'vite.config.ts'),
    root: projectPath,
    logLevel: 'info',
  });

  console.log(`[daemon] Ready in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  writeState();
}

// Run build with timeout
async function build() {
  if (!builder) throw new Error('Builder not initialized');
  if (building) throw new Error('Build already in progress');

  building = true;
  const start = Date.now();

  try {
    await Promise.race([
      builder.buildApp(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Build timed out after 3 minutes')), BUILD_TIMEOUT)
      ),
    ]);
    return { ok: true, duration: Date.now() - start };
  } finally {
    building = false;
  }
}

// Clean up old socket
if (existsSync(SOCKET)) unlinkSync(SOCKET);

const server = createServer(async (socket) => {
  socket.setTimeout(BUILD_TIMEOUT + 10_000);
  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => {});

  // Read request (newline-delimited)
  let data = '';
  let processed = false;

  socket.on('data', async (chunk) => {
    data += chunk;
    if (processed || !data.includes('\n')) return;
    processed = true;
    const line = data.split('\n')[0];

    try {
      const req = JSON.parse(line || '{}');

      const sendResponse = (result) => {
        socket.write(JSON.stringify(result) + '\n', () => socket.end());
      };

      if (req.action === 'warmup') {
        sendResponse({ ok: true, projectPath });
      } else if (req.action === 'status') {
        sendResponse({ ok: true, projectPath, building, pid: process.pid });
      } else {
        // Default: build
        const result = await build();
        sendResponse(result);
      }
    } catch (err) {
      try {
        socket.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
        socket.end();
      } catch {}
    }
  });
});

// Graceful shutdown
function shutdown() {
  console.log('[daemon] Shutting down...');
  server.close();
  try { unlinkSync(SOCKET); unlinkSync(STATE); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize first, then start listening
init()
  .then(() => {
    server.listen(SOCKET, () => console.log(`[daemon] Listening on ${SOCKET}`));
  })
  .catch(err => {
    console.error('[daemon] Init failed:', err);
    process.exit(1);
  });
