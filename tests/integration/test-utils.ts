/**
 * Test utilities for integration tests
 */

import { readFileSync } from 'fs';
import path from 'path';
import type { OrgRole } from '@/types';

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

export function extractSessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Missing set-cookie header');
  }
  const match = setCookie.match(/chiridion_session_v2=([^;]+)/);
  if (!match) {
    throw new Error('Missing chiridion_session_v2 cookie');
  }
  return `chiridion_session_v2=${match[1] ?? ''}`;
}

/**
 * Generate a unique email for testing
 */
export function uniqueEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

export async function signupUser(options: {
  email?: string;
  password?: string;
  name?: string;
} = {}) {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? 'testpass123';
  const name = options.name ?? 'Test User';

  const response = await serverFetch('/api/test/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'signup', email, password, name }),
  });

  if (!response.ok) {
    throw new Error(`Signup failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    user: { id: string };
    currentOrg: { id: string };
    currentWorkspace: { id: string } | null;
  };

  return {
    email,
    password,
    sessionCookie: extractSessionCookie(response),
    userId: payload.user.id,
    orgId: payload.currentOrg.id,
    workspaceId: payload.currentWorkspace?.id ?? null,
  };
}

export async function loginUser(options: { email: string; password: string }) {
  const response = await serverFetch('/api/test/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: options.email, password: options.password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    user: { id: string; is_orphaned: boolean };
    currentOrg: { id: string };
    currentWorkspace: { id: string } | null;
  };

  return {
    sessionCookie: extractSessionCookie(response),
    userId: payload.user.id,
    orgId: payload.currentOrg.id,
    workspaceId: payload.currentWorkspace?.id ?? null,
    isOrphaned: payload.user.is_orphaned,
  };
}

export async function getAuthState(sessionCookie: string) {
  const response = await serverFetch('/api/test/auth', {
    method: 'GET',
    headers: { Cookie: sessionCookie },
  });
  return response;
}

export async function switchWorkspace(sessionCookie: string, workspaceId: string | null) {
  const response = await serverFetch('/api/test/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ action: 'switch-workspace', workspace_id: workspaceId }),
  });
  return response;
}

export async function createInvitation(
  sessionCookie: string,
  orgId: string,
  email: string,
  role: OrgRole = 'member'
) {
  const response = await serverFetch(`/api/orgs/${orgId}/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ email, role }),
  });

  if (!response.ok) {
    throw new Error(`Create invitation failed: ${response.status}`);
  }

  return response.json() as Promise<{ id: string; email: string; role: string; expires_at: number }>;
}

export async function createTestInvitation(
  orgId: string,
  email: string,
  role: OrgRole = 'member',
  sessionCookie: string
): Promise<{ id: string; expires_at: number }> {
  const invitation = await createInvitation(sessionCookie, orgId, email, role);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function acceptInvitation(
  sessionCookie: string,
  orgId: string,
  invitationId: string
) {
  const response = await serverFetch(`/api/invitations/${orgId}/${invitationId}`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  });

  if (!response.ok) {
    throw new Error(`Accept invitation failed: ${response.status}`);
  }

  return response.json() as Promise<{
    success: boolean;
    org: { id: string };
    workspace: { id: string } | null;
  }>;
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
