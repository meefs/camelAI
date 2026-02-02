#!/usr/bin/env node
/**
 * Vite Build Client
 *
 * Usage: vite-build [build|warmup]
 * Starts daemon if needed, ensures only one daemon runs at a time.
 */

import { connect } from 'net';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';

const SOCKET_PATH = '/tmp/vite-build.sock';
const STATE_PATH = '/tmp/vite-build.state';
const projectPath = resolve(process.cwd());
const action = process.argv[2] || 'build';

const c = { reset: '\x1b[0m', dim: '\x1b[2m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m' };

function log(msg) { console.log(c.dim + '[vite]' + c.reset + ' ' + msg); }
function formatMs(ms) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`; }

function getDaemonProject() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    process.kill(state.pid, 0); // Check if alive
    return state.projectPath;
  } catch {
    return null;
  }
}

function killDaemon() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    process.kill(state.pid, 'SIGTERM');
  } catch {}
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(STATE_PATH); } catch {}
}

function startDaemon() {
  const child = spawn('yarn', ['node', '/app/vite-daemon.mjs'], {
    cwd: projectPath,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();

  return new Promise(resolve => {
    let attempts = 0;
    const check = () => {
      if (existsSync(SOCKET_PATH)) resolve(true);
      else if (attempts++ < 50) setTimeout(check, 100);
      else resolve(false);
    };
    setTimeout(check, 100);
  });
}

function fallbackBuild() {
  log(c.yellow + 'Falling back to yarn build...' + c.reset);
  const child = spawn('yarn', ['react-router', 'build'], { cwd: projectPath, stdio: 'inherit' });
  child.on('close', code => process.exit(code || 0));
  child.on('error', () => process.exit(1));
}

function sendRequest() {
  const client = connect(SOCKET_PATH, () => {
    client.write(JSON.stringify({ action }) + '\n');
  });

  let buffer = '';
  let done = false;

  client.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'log') {
          const color = msg.level === 'error' ? c.red : msg.level === 'warn' ? c.yellow : '';
          console.log(c.dim + '[vite]' + c.reset + ' ' + color + msg.message + c.reset);
          continue;
        }
        done = true;
        if (msg.success) {
          const cached = msg.cacheHit ? c.dim + ' (cached)' + c.reset : '';
          console.log(c.green + '✓ Built in ' + formatMs(msg.duration) + cached + c.reset);
          process.exit(0);
        } else {
          log(c.red + 'Failed: ' + msg.error + c.reset);
          fallbackBuild();
        }
      } catch {}
    }
  });

  client.on('error', () => fallbackBuild());
  client.on('close', () => { if (!done) fallbackBuild(); });
  setTimeout(() => { client.destroy(); fallbackBuild(); }, 5 * 60 * 1000);
}

async function main() {
  const daemonProject = getDaemonProject();

  if (daemonProject === projectPath) {
    sendRequest();
  } else {
    if (daemonProject) {
      log('Switching from ' + daemonProject);
      killDaemon();
    }
    if (await startDaemon()) {
      sendRequest();
    } else {
      fallbackBuild();
    }
  }
}

main();
