/**
 * Test utilities for integration tests
 */

import { readFileSync } from 'fs';
import path from 'path';

const SERVER_URL_FILE = path.join(__dirname, '.server-url');

/**
 * Get the base URL of the test server.
 * This is set by global-setup.ts when the server starts.
 */
export function getServerUrl(): string {
  try {
    return readFileSync(SERVER_URL_FILE, 'utf-8').trim();
  } catch {
    throw new Error(
      'Server URL not found. Make sure integration tests are run with vitest.integration.config.ts'
    );
  }
}

/**
 * Make a request to the test server
 */
export async function serverFetch(
  path: string,
  options?: RequestInit
): Promise<Response> {
  const baseUrl = getServerUrl();
  const url = new URL(path, baseUrl);
  return fetch(url.toString(), options);
}

/**
 * Generate a unique email for testing
 */
export function uniqueEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}
