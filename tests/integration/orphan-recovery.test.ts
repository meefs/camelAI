/**
 * Integration tests for orphan recovery entrypoints (HTTP surface)
 */

import { describe, it, expect } from 'vitest';
import {
  acceptInvitation,
  createInvitation,
  extractSessionCookie,
  serverFetch,
  signupUser,
  uniqueEmail,
} from './test-utils';

const PASSWORD = 'testpass123';

async function loginUser(email: string, password: string) {
  const response = await serverFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.ok).toBe(true);
  const payload = await response.json() as {
    user: { id: string; is_orphaned: boolean };
    currentOrg: { id: string };
    currentWorkspace: { id: string } | null;
  };
  return {
    payload,
    sessionCookie: extractSessionCookie(response),
  };
}

describe('orphan recovery', () => {
  it('orphaned user login creates new org and workspace', async () => {
    const user = await signupUser({ email: uniqueEmail(), password: PASSWORD, name: 'Orphan Recovery Tester' });

    const archiveResponse = await serverFetch(`/api/orgs/${user.orgId}`, {
      method: 'DELETE',
      headers: { Cookie: user.sessionCookie },
    });
    expect(archiveResponse.ok).toBe(true);

    const meResponse = await serverFetch('/api/auth/me', {
      headers: { Cookie: user.sessionCookie },
    });
    expect(meResponse.status).toBe(401);

    const { payload } = await loginUser(user.email, user.password);
    expect(payload.currentOrg.id).toBeTruthy();
    expect(payload.currentOrg.id).not.toBe(user.orgId);
    expect(payload.currentWorkspace?.id).toBeTruthy();
    expect(payload.user.is_orphaned).toBe(false);
  });

  it('orphaned user accepting invite joins existing org', async () => {
    const owner = await signupUser({ password: PASSWORD, name: 'Inviter' });
    const invitee = await signupUser({ password: PASSWORD, name: 'Invitee' });

    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, invitee.email, 'member');

    const archiveResponse = await serverFetch(`/api/orgs/${invitee.orgId}`, {
      method: 'DELETE',
      headers: { Cookie: invitee.sessionCookie },
    });
    expect(archiveResponse.ok).toBe(true);

    const { sessionCookie } = await loginUser(invitee.email, invitee.password);

    const acceptResponse = await acceptInvitation(sessionCookie, owner.orgId, invitation.id);
    expect(acceptResponse.success).toBe(true);

    const meResponse = await serverFetch('/api/auth/me', {
      headers: { Cookie: sessionCookie },
    });
    expect(meResponse.ok).toBe(true);
    const payload = await meResponse.json() as {
      user: { is_orphaned: boolean };
      currentOrg: { id: string };
    };
    expect(payload.user.is_orphaned).toBe(false);
    expect(payload.currentOrg.id).toBe(owner.orgId);
  });
});
