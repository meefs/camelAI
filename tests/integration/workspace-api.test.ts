/**
 * Integration tests for workspace API routes
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { acceptInvitation, createInvitation, serverFetch, signupUser, uniqueEmail } from './test-utils';

const PASSWORD = 'testpass123';

function extractSessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const match = setCookie?.match(/chiridion_session=([^;]+)/);
  expect(match).toBeTruthy();
  return `chiridion_session=${match?.[1] ?? ''}`;
}

async function signupAndGetSession() {
  const response = await serverFetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: uniqueEmail(),
      password: PASSWORD,
      name: 'Workspace Tester',
    }),
  });

  expect(response.ok).toBe(true);
  const payload = await response.json() as {
    user: { id: string };
    currentOrg: { id: string };
    currentWorkspace: { id: string } | null;
  };

  return {
    sessionCookie: extractSessionCookie(response),
    userId: payload.user.id,
    orgId: payload.currentOrg.id,
    workspaceId: payload.currentWorkspace?.id ?? null,
  };
}

async function createWorkspace(sessionCookie: string, name: string) {
  const response = await serverFetch('/api/workspaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ name }),
  });

  expect(response.ok).toBe(true);
  return response.json() as Promise<{ id: string; name: string }>;
}

describe('workspace API', () => {
  let sessionCookie = '';
  let baseWorkspaceId: string | null = null;

  beforeAll(async () => {
    const session = await signupAndGetSession();
    sessionCookie = session.sessionCookie;
    baseWorkspaceId = session.workspaceId;
  });

  it('GET /api/workspaces lists user workspaces', async () => {
    const response = await serverFetch('/api/workspaces', {
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
    const workspaces = await response.json() as Array<{ id: string }>;
    expect(workspaces.length).toBeGreaterThan(0);
    if (baseWorkspaceId) {
      expect(workspaces.some((entry) => entry.id === baseWorkspaceId)).toBe(true);
    }
  });

  it('POST /api/workspaces creates workspace (admin)', async () => {
    const workspace = await createWorkspace(sessionCookie, 'API Workspace');
    expect(workspace.id).toBeTruthy();
  });

  it('POST /api/workspaces rejects non-admin', async () => {
    const owner = await signupUser({ name: 'Workspace Owner' });
    const member = await signupUser({ name: 'Workspace Member' });
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, member.email, 'member');
    await acceptInvitation(member.sessionCookie, owner.orgId, invitation.id);

    const response = await serverFetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: member.sessionCookie,
      },
      body: JSON.stringify({ name: 'Forbidden Workspace' }),
    });

    expect(response.status).toBe(403);
  });

  it('GET /api/workspaces/[id] returns workspace details', async () => {
    const workspace = await createWorkspace(sessionCookie, 'Details Workspace');

    const response = await serverFetch(`/api/workspaces/${workspace.id}`, {
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
    const payload = await response.json() as { id: string; name: string };
    expect(payload.id).toBe(workspace.id);
    expect(payload.name).toBe('Details Workspace');
  });

  it('PUT /api/workspaces/[id] updates workspace (admin)', async () => {
    const workspace = await createWorkspace(sessionCookie, 'Update Workspace');

    const response = await serverFetch(`/api/workspaces/${workspace.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ name: 'Updated Workspace', description: 'New description' }),
    });

    expect(response.ok).toBe(true);
    const payload = await response.json() as { id: string; name: string; description: string | null };
    expect(payload.name).toBe('Updated Workspace');
    expect(payload.description).toBe('New description');
  });

  it('DELETE /api/workspaces/[id] archives workspace (admin)', async () => {
    const workspace = await createWorkspace(sessionCookie, 'Archive Workspace');

    const response = await serverFetch(`/api/workspaces/${workspace.id}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
    const payload = await response.json() as { archived: boolean };
    expect(payload.archived).toBe(true);

    const listResponse = await serverFetch('/api/workspaces', {
      headers: { Cookie: sessionCookie },
    });
    const workspaces = await listResponse.json() as Array<{ id: string }>;
    expect(workspaces.some((entry) => entry.id === workspace.id)).toBe(false);
  });

  it('POST /api/auth/switch-workspace switches active workspace', async () => {
    const workspace = await createWorkspace(sessionCookie, 'Switch Workspace');

    const response = await serverFetch('/api/auth/switch-workspace', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });

    expect(response.ok).toBe(true);
    const payload = await response.json() as { workspace: { id: string } | null };
    expect(payload.workspace?.id).toBe(workspace.id);
  });
});
