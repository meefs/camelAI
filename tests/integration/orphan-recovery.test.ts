/**
 * Integration tests for orphan recovery entrypoints (HTTP surface)
 */

import { describe, it, expect } from 'vitest';
import {
  acceptInvitation,
  createInvitation,
  getAuthState,
  loginUser,
  serverFetch,
  signupUser,
  uniqueEmail,
} from './test-utils';

const PASSWORD = 'testpass123';

describe('orphan recovery', () => {
  it('orphaned user login creates new org and workspace', async () => {
    const user = await signupUser({ email: uniqueEmail(), password: PASSWORD, name: 'Orphan Recovery Tester' });

    const archiveResponse = await serverFetch(`/api/orgs/${user.orgId}`, {
      method: 'DELETE',
      headers: { Cookie: user.sessionCookie },
    });
    expect(archiveResponse.ok).toBe(true);

    const meResponse = await getAuthState(user.sessionCookie);
    expect(meResponse.status).toBe(401);

    const loginResult = await loginUser({ email: user.email, password: user.password });
    expect(loginResult.orgId).toBeTruthy();
    expect(loginResult.orgId).not.toBe(user.orgId);
    expect(loginResult.workspaceId).toBeTruthy();
    expect(loginResult.isOrphaned).toBe(false);
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

    const { sessionCookie } = await loginUser({ email: invitee.email, password: invitee.password });

    const acceptResponse = await acceptInvitation(sessionCookie, owner.orgId, invitation.id);
    expect(acceptResponse.success).toBe(true);

    const meResponse = await getAuthState(sessionCookie);
    expect(meResponse.ok).toBe(true);
    const payload = await meResponse.json() as {
      user: { is_orphaned: boolean };
      currentOrg: { id: string };
    };
    expect(payload.user.is_orphaned).toBe(false);
    expect(payload.currentOrg.id).toBe(owner.orgId);
  });
});
