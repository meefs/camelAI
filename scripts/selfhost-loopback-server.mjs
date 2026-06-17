#!/usr/bin/env node

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, Log, LogLevel } from 'miniflare';

const DEFAULT_BROWSER_VERSION = '126.0.6478.182';

/**
 * Minimal Miniflare loopback surface for local Browser Rendering.
 * workerd forwards MINIFLARE_LOOPBACK fetches here via --external-addr=loopback=...
 */
export async function startSelfhostLoopbackServer(options = {}) {
  if (process.env.SELFHOST_BROWSER_NO_SANDBOX === '1') {
    process.env.CI = '1';
  }

  const hostname = options.hostname ?? '127.0.0.1';
  const tmpPath = options.tmpPath ?? path.join(os.tmpdir(), 'camelai-selfhost-loopback');
  const browserVersion = options.browserVersion
    ?? process.env.SELFHOST_BROWSER_VERSION
    ?? DEFAULT_BROWSER_VERSION;
  const log = options.log ?? new Log(LogLevel.WARN);
  const browserProcesses = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/browser/launch' && req.method === 'GET') {
        const headful = process.env.SELFHOST_BROWSER_HEADFUL === '1';
        const { sessionId, browserProcess, startTime, wsEndpoint } = await launchBrowser({
          browserVersion,
          headful,
          log,
          tmpPath,
        });
        browserProcess.nodeProcess.on('exit', () => {
          browserProcesses.delete(sessionId);
        });
        browserProcesses.set(sessionId, browserProcess);
        writeJson(res, 200, { wsEndpoint, sessionId, startTime });
        return;
      }

      if (url.pathname === '/browser/status' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          writeText(res, 400, 'Missing sessionId query parameter');
          return;
        }
        const browserProcess = browserProcesses.get(sessionId);
        res.writeHead(browserProcess ? 200 : 410);
        res.end();
        return;
      }

      if (url.pathname === '/browser/close' && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          writeText(res, 400, 'Missing sessionId query parameter');
          return;
        }
        const browserProcess = browserProcesses.get(sessionId);
        if (!browserProcess) {
          writeText(res, 404, 'Session not found');
          return;
        }
        browserProcesses.delete(sessionId);
        await browserProcess.close().catch(() => {});
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === '/browser/sessionIds' && req.method === 'GET') {
        writeJson(res, 200, Array.from(browserProcesses.keys()));
        return;
      }

      writeText(res, 404, 'Not found');
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error('[selfhost-loopback]', message);
      writeText(res, 500, message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, hostname, resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve self-host loopback listen port');
  }

  return {
    server,
    hostname,
    port: address.port,
    async close() {
      await Promise.all(
        [...browserProcesses.values()].map((browserProcess) => browserProcess.close().catch(() => {})),
      );
      browserProcesses.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const loopback = await startSelfhostLoopbackServer();
  console.log(`Self-host loopback listening on http://${loopback.hostname}:${loopback.port}`);
  const shutdown = async () => {
    await loopback.close().catch((error) => {
      console.error(error);
      process.exit(1);
    });
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown();
    });
  }
}
