/**
 * Integration tests for workspace integrations
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { serverFetch, signupUser } from './test-utils';

describe('workspace integrations', () => {
  let sessionCookie = '';
  let workspaceId: string | null = null;

  beforeAll(async () => {
    const session = await signupUser({ name: 'Integration Tester' });
    sessionCookie = session.sessionCookie;
    workspaceId = session.workspaceId;
    if (!workspaceId) {
      throw new Error('Missing workspace ID for integration tests');
    }
  });

  it('GET /api/workspaces/[id]/integrations lists integrations', async () => {
    const response = await serverFetch(`/api/workspaces/${workspaceId}/integrations`, {
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
    const list = await response.json() as Array<{ id: string }>;
    expect(Array.isArray(list)).toBe(true);
  });

  it('POST /api/workspaces/[id]/integrations creates integration', async () => {
    const response = await serverFetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        integration_type: 'airtable',
        name: 'Airtable',
        config: {},
        credentials: { api_key: 'pat-test' },
      }),
    });

    expect(response.ok).toBe(true);
    const integration = await response.json() as { id: string; has_credentials: boolean };
    expect(integration.id).toBeTruthy();
    expect(integration.has_credentials).toBe(true);
  });

  it('PUT /api/workspaces/[id]/integrations/[iid] updates integration', async () => {
    const createResponse = await serverFetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        integration_type: 'airtable',
        name: 'Airtable Temp',
        config: {},
        credentials: { api_key: 'pat-test' },
      }),
    });
    const created = await createResponse.json() as { id: string };

    const response = await serverFetch(`/api/workspaces/${workspaceId}/integrations/${created.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ name: 'Airtable Updated' }),
    });

    expect(response.ok).toBe(true);
    const updated = await response.json() as { name: string };
    expect(updated.name).toBe('Airtable Updated');
  });

  it('DELETE /api/workspaces/[id]/integrations/[iid] deletes integration', async () => {
    const createResponse = await serverFetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        integration_type: 'airtable',
        name: 'Airtable Delete',
        config: {},
        credentials: { api_key: 'pat-test' },
      }),
    });
    const created = await createResponse.json() as { id: string };

    const response = await serverFetch(`/api/workspaces/${workspaceId}/integrations/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);

    const listResponse = await serverFetch(`/api/workspaces/${workspaceId}/integrations`, {
      headers: { Cookie: sessionCookie },
    });
    const list = await listResponse.json() as Array<{ id: string }>;
    expect(list.some((entry) => entry.id === created.id)).toBe(false);
  });
});
