/**
 * Integration tests for ownership transfer route
 */

import { describe, it, expect } from 'vitest';
import { acceptInvitation, createInvitation, serverFetch, signupUser } from './test-utils';

const PASSWORD = 'testpass123';

async function listMembers(orgId: string, sessionCookie: string) {
  const response = await serverFetch(`/api/orgs/${orgId}/members`, {
    headers: { Cookie: sessionCookie },
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<Array<{ user: { id: string }; role: string }>>;
}

describe('ownership transfer', () => {
  it('POST /api/orgs/[id]/transfer-ownership succeeds for owner', async () => {
    const owner = await signupUser({ name: 'Owner', password: PASSWORD });
    const member = await signupUser({ name: 'Member', password: PASSWORD });
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, member.email, 'member');
    await acceptInvitation(member.sessionCookie, owner.orgId, invitation.id);

    const response = await serverFetch(`/api/orgs/${owner.orgId}/transfer-ownership`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: owner.sessionCookie,
      },
      body: JSON.stringify({ new_owner_id: member.userId }),
    });

    expect(response.ok).toBe(true);

    const members = await listMembers(owner.orgId, owner.sessionCookie);
    const newOwner = members.find((entry) => entry.user.id === member.userId);
    const oldOwner = members.find((entry) => entry.user.id === owner.userId);
    expect(newOwner?.role).toBe('owner');
    expect(oldOwner?.role).toBe('admin');
  });

  it('rejects transfer to non-member', async () => {
    const { sessionCookie, orgId } = await signupUser({ password: PASSWORD });

    const response = await serverFetch(`/api/orgs/${orgId}/transfer-ownership`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ new_owner_id: 'non-member' }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects transfer by non-owner', async () => {
    const owner = await signupUser({ password: PASSWORD });
    const member = await signupUser({ password: PASSWORD });
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, member.email, 'member');
    await acceptInvitation(member.sessionCookie, owner.orgId, invitation.id);

    const response = await serverFetch(`/api/orgs/${owner.orgId}/transfer-ownership`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: member.sessionCookie,
      },
      body: JSON.stringify({ new_owner_id: owner.userId }),
    });

    expect(response.status).toBe(403);
  });
});
