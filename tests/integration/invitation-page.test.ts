import { describe, expect, it } from 'vitest';
import { createInvitation, serverFetch, signupUser } from './test-utils';

const PASSWORD = 'testpass123';

describe('invitation page integration', () => {
  it('GET /invitations/:orgId/:invitationId returns 200 for valid invitation', async () => {
    const owner = await signupUser({ password: PASSWORD });
    const inviteeEmail = `invitee-${Date.now()}@example.com`;
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, inviteeEmail, 'member');

    const response = await serverFetch(`/invitations/${owner.orgId}/${invitation.id}`, {
      redirect: 'manual',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('accepts invitation when logged in with matching email', async () => {
    const owner = await signupUser({ password: PASSWORD });
    const invitee = await signupUser({ password: PASSWORD });
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, invitee.email, 'member');

    const response = await serverFetch(`/api/invitations/${owner.orgId}/${invitation.id}`, {
      method: 'POST',
      headers: { Cookie: invitee.sessionCookie },
    });

    expect(response.ok).toBe(true);
    const payload = await response.json() as { success: boolean };
    expect(payload.success).toBe(true);
  });

  it('shows error when logged in with wrong email', async () => {
    const owner = await signupUser({ password: PASSWORD });
    const invitee = await signupUser({ password: PASSWORD });
    const wrongUser = await signupUser({ password: PASSWORD });
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, invitee.email, 'member');

    const response = await serverFetch(`/api/invitations/${owner.orgId}/${invitation.id}`, {
      method: 'POST',
      headers: { Cookie: wrongUser.sessionCookie },
    });

    expect(response.status).toBe(403);
  });

  it('shows error for expired invitation', async () => {
    const owner = await signupUser({ password: PASSWORD });
    const inviteeEmail = `expired-${Date.now()}@example.com`;
    const invitation = await createInvitation(owner.sessionCookie, owner.orgId, inviteeEmail, 'member');

    const deleteResponse = await serverFetch(`/api/orgs/${owner.orgId}/invite`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Cookie: owner.sessionCookie,
      },
      body: JSON.stringify({ invitation_id: invitation.id }),
    });

    expect(deleteResponse.ok).toBe(true);

    const response = await serverFetch(`/api/invitations/${owner.orgId}/${invitation.id}`);
    expect(response.status).toBe(404);
  });
});
