#!/usr/bin/env node
/**
 * Vite Build Client
 *
 * Usage: yarn node /app/vite-build.mjs [--warmup] [--no-snapshot]
 *
 * - Starts daemon if not running (or wrong project)
 * - Only one daemon at a time
 * - Falls back to regular build if daemon fails
 * - Creates instant JuiceFS snapshot after successful build
 */

import { connect } from 'net';
import { resolve, basename } from 'path';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';

const SOCKET = '/tmp/vite-build.sock';
const STATE = '/tmp/vite-build.state';
const DAEMON_TIMEOUT = 30_000; // 30s to start daemon
const BUILD_TIMEOUT = 200_000; // 3+ minutes for build
const MAX_SNAPSHOTS = 50; // Keep last N snapshots (CoW = metadata only, very cheap)

const projectPath = resolve(process.cwd());
const warmupOnly = process.argv.includes('--warmup');
const noSnapshot = process.argv.includes('--no-snapshot');

// Check if daemon is running for our project
function getDaemonState() {
  if (!existsSync(STATE)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE, 'utf-8'));
    process.kill(state.pid, 0); // throws if not running
    return state;
  } catch {
    // Stale state file
    try { unlinkSync(STATE); } catch {}
    try { unlinkSync(SOCKET); } catch {}
    return null;
  }
}

// Kill existing daemon
function killDaemon(state) {
  try { process.kill(state.pid, 'SIGTERM'); } catch {}
  try { unlinkSync(SOCKET); } catch {}
  try { unlinkSync(STATE); } catch {}
  // Wait a moment for cleanup
  execSync('sleep 0.5');
}

// Start daemon in background
function startDaemon() {
  return new Promise((resolve) => {
    console.log(`[build] Starting daemon for ${projectPath}...`);

    const child = spawn('yarn', ['node', '/app/vite-daemon.mjs', projectPath], {
      cwd: projectPath,
      stdio: 'inherit', // Show daemon output during startup
      detached: true,
    });

    // Wait for socket to appear
    const start = Date.now();
    const check = setInterval(() => {
      if (existsSync(SOCKET) && existsSync(STATE)) {
        clearInterval(check);
        child.unref();
        resolve(true);
      } else if (Date.now() - start > DAEMON_TIMEOUT) {
        clearInterval(check);
        child.kill();
        resolve(false);
      }
    }, 200);

    child.on('error', () => {
      clearInterval(check);
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearInterval(check);
        resolve(false);
      }
    });
  });
}

// Send build request to daemon
function sendBuild() {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET);
    let response = '';

    socket.setTimeout(BUILD_TIMEOUT);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ action: warmupOnly ? 'warmup' : 'build' }) + '\n');
    });

    socket.on('data', (chunk) => {
      response += chunk;
    });

    socket.on('close', () => {
      try {
        const result = JSON.parse(response.trim());
        resolve(result);
      } catch {
        reject(new Error('Invalid response from daemon'));
      }
    });

    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Build timed out'));
    });
  });
}

// Fallback to regular build
function fallbackBuild() {
  console.log('[build] Falling back to yarn build...');
  try {
    execSync('yarn react-router build', { cwd: projectPath, stdio: 'inherit' });
  } catch {
    process.exit(1);
  }
}

// Create instant JuiceFS snapshot of the project
function createSnapshot() {
  if (noSnapshot) return;

  const homeDir = process.env.HOME || '/home/claude';
  const projectName = basename(projectPath);
  const snapshotDir = resolve(homeDir, '.chiridion', 'snapshots', projectName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = resolve(snapshotDir, timestamp);

  try {
    // Ensure snapshot directory exists
    mkdirSync(snapshotDir, { recursive: true });

    // Create instant copy-on-write snapshot using juicefs clone
    console.log(`[build] Creating snapshot...`);
    execSync(`juicefs clone "${projectPath}" "${snapshotPath}"`, {
      stdio: 'pipe',
      timeout: 10_000, // 10s timeout (should be instant)
    });
    console.log(`[build] ✓ Snapshot: ${timestamp}`);

    // Clean up old snapshots (keep only MAX_SNAPSHOTS)
    cleanupOldSnapshots(snapshotDir);
  } catch (err) {
    // Snapshot failure is non-fatal
    console.log(`[build] Snapshot failed: ${err.message}`);
  }
}

// Remove old snapshots, keeping only the most recent MAX_SNAPSHOTS
function cleanupOldSnapshots(snapshotDir) {
  try {
    const entries = readdirSync(snapshotDir)
      .map(name => ({
        name,
        path: resolve(snapshotDir, name),
        mtime: statSync(resolve(snapshotDir, name)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    // Remove oldest snapshots beyond limit
    for (const entry of entries.slice(MAX_SNAPSHOTS)) {
      rmSync(entry.path, { recursive: true, force: true });
      console.log(`[build] Removed old snapshot: ${entry.name}`);
    }
  } catch {
    // Cleanup failure is non-fatal
  }
}

async function main() {
  const state = getDaemonState();

  // Check if daemon is running for correct project
  if (state && state.projectPath === projectPath) {
    // Daemon ready, send request
  } else {
    // Need to start (or restart) daemon
    if (state) {
      console.log(`[build] Switching from ${state.projectPath}`);
      killDaemon(state);
    }

    const started = await startDaemon();
    if (!started) {
      console.log('[build] Daemon failed to start');
      if (!warmupOnly) {
        fallbackBuild();
        createSnapshot();
      }
      return;
    }
  }

  // Send request to daemon
  try {
    const result = await sendBuild();

    if (result.ok) {
      if (warmupOnly) {
        console.log(`[build] Daemon warm for ${result.projectPath}`);
      } else {
        console.log(`[build] ✓ Built in ${(result.duration / 1000).toFixed(1)}s`);
        createSnapshot();
      }
    } else {
      console.log(`[build] Daemon error: ${result.error}`);
      if (!warmupOnly) {
        fallbackBuild();
        createSnapshot();
      }
    }
  } catch (err) {
    console.log(`[build] Error: ${err.message}`);
    if (!warmupOnly) {
      fallbackBuild();
      createSnapshot();
    }
  }
}

main();
