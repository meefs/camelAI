/**
 * Global setup for integration tests
 *
 * Starts the dev server (wrangler + next) before all tests run.
 * Tests can then make real HTTP requests to the server.
 *
 * The server URL is written to a temp file so tests can read it.
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';

const SERVER_URL_FILE = path.join(__dirname, '.server-url');
const DEFAULT_PORT = 3100;
const STARTUP_TIMEOUT = 120000; // 2 minutes for server to start

let serverProcess: ChildProcess | null = null;

async function waitForServer(url: string, timeout: number): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok || response.status === 404) {
        // Server is responding (404 is fine, just means no route)
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = process.env.INTEGRATION_TEST_PORT || DEFAULT_PORT;
  const serverUrl = `http://localhost:${port}`;

  console.log(`\n[Integration Tests] Starting dev server on port ${port}...`);

  // Start the dev server
  serverProcess = spawn('npm', ['run', 'dev'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXY_DEV_PORT: String(port),
      // Disable color output for cleaner logs
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  // Log server output for debugging
  serverProcess.stdout?.on('data', (data: Buffer) => {
    const output = data.toString();
    // Only log important lines to reduce noise
    if (
      output.includes('Ready') ||
      output.includes('ready') ||
      output.includes('Error') ||
      output.includes('error')
    ) {
      console.log(`[Server] ${output.trim()}`);
    }
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const output = data.toString();
    // Filter out noise
    if (!output.includes('ExperimentalWarning') && !output.includes('punycode')) {
      console.error(`[Server Error] ${output.trim()}`);
    }
  });

  serverProcess.on('error', (err) => {
    console.error(`[Integration Tests] Failed to start server:`, err);
  });

  // Wait for server to be ready
  console.log(`[Integration Tests] Waiting for server at ${serverUrl}...`);
  const isReady = await waitForServer(serverUrl, STARTUP_TIMEOUT);

  if (!isReady) {
    serverProcess?.kill('SIGTERM');
    throw new Error(
      `[Integration Tests] Server failed to start within ${STARTUP_TIMEOUT / 1000}s`
    );
  }

  console.log(`[Integration Tests] Server is ready at ${serverUrl}`);

  // Write server URL to file so tests can read it
  writeFileSync(SERVER_URL_FILE, serverUrl);

  // Return teardown function
  return async () => {
    console.log('\n[Integration Tests] Shutting down server...');

    if (serverProcess) {
      // Kill the process tree (npm spawns child processes)
      serverProcess.kill('SIGTERM');

      // Give it a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Force kill if still running
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }

    // Clean up the URL file
    if (existsSync(SERVER_URL_FILE)) {
      unlinkSync(SERVER_URL_FILE);
    }

    console.log('[Integration Tests] Server stopped');
  };
}
