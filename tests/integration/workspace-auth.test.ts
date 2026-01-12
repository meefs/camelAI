/**
 * Integration tests for workspace access rules
 */

import { describe, it, expect } from 'vitest';
import { serverFetch, signupUser, switchWorkspace } from './test-utils';

async function setWorkspaceAccess(
  sessionCookie: string,
  workspaceId: string,
  userId: string,
  accessLevel: 'full' | 'read_only' | 'none'
) {
  const response = await serverFetch(`/api/workspaces/${workspaceId}/access/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ access_level: accessLevel }),
  });

  expect(response.ok).toBe(true);
}

describe('workspace auth', () => {
  it('requires workspace access for thread endpoints', async () => {
    const response = await serverFetch('/api/threads');
    expect(response.status).toBe(401);
  });

  it('returns 404 for workspace with none access', async () => {
    const { sessionCookie, userId, workspaceId } = await signupUser({ name: 'Workspace Auth Tester' });
    expect(workspaceId).toBeTruthy();

    await setWorkspaceAccess(sessionCookie, workspaceId!, userId, 'none');

    const response = await serverFetch('/api/threads', {
      headers: { Cookie: sessionCookie },
    });

    expect(response.status).toBe(404);
  });

  it('allows read for read_only access', async () => {
    const { sessionCookie, userId, workspaceId } = await signupUser({ name: 'Workspace Auth Tester' });
    expect(workspaceId).toBeTruthy();

    await setWorkspaceAccess(sessionCookie, workspaceId!, userId, 'read_only');

    const response = await serverFetch('/api/threads', {
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
  });

  it('denies write for read_only access', async () => {
    const { sessionCookie, userId, workspaceId } = await signupUser({ name: 'Workspace Auth Tester' });
    expect(workspaceId).toBeTruthy();

    await setWorkspaceAccess(sessionCookie, workspaceId!, userId, 'read_only');

    const response = await serverFetch('/api/threads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ title: 'Should Fail' }),
    });

    expect(response.status).toBe(403);
  });

  it('handles session with null workspace_id', async () => {
    const { sessionCookie } = await signupUser({ name: 'Workspace Auth Tester' });

    const switchResponse = await switchWorkspace(sessionCookie, null);
    expect(switchResponse.ok).toBe(true);

    const response = await serverFetch('/api/threads', {
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
  });

  it('handles session with archived workspace_id', async () => {
    const { sessionCookie, workspaceId } = await signupUser({ name: 'Workspace Auth Tester' });
    expect(workspaceId).toBeTruthy();

    const createResponse = await serverFetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ name: 'Secondary Workspace' }),
    });
    expect(createResponse.ok).toBe(true);

    const archiveResponse = await serverFetch(`/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    expect(archiveResponse.ok).toBe(true);

    const response = await serverFetch('/api/threads', {
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
  });
});
