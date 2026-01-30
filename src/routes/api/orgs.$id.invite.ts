import type { Route } from './+types/orgs.$id.invite';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getSessionIdFromRequest } from '@/lib/cookies.server';
import {
  createInvitation,
  getInvitation,
  getSession,
  isOrgAdmin,
} from '@/lib/auth-do';
import { inviteMemberFormSchema } from '@/lib/schemas';

export async function action({ request, context, params }: Route.ActionArgs) {
  const orgId = params.id;
  if (!orgId) {
    return Response.json({ error: 'Organization ID is required' }, { status: 400 });
  }

  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const session = await getSession(authEnv, sessionId);
  if (!session) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const parsed = inviteMemberFormSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: 'Valid email and role are required' }, { status: 400 });
      }

      const isAdmin = await isOrgAdmin(authEnv, session.user_id, orgId);
      if (!isAdmin) {
        return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
      }

      const email = parsed.data.email.toLowerCase().trim();
      const role = parsed.data.role;

      const invitation = await createInvitation(
        authEnv,
        orgId,
        email,
        role,
        session.user_id
      );

      return Response.json({
        id: invitation.id,
        email,
        role,
        expires_at: invitation.expires_at,
      });
    } catch (error) {
      console.error('Create invitation error:', error);
      return Response.json({ error: 'Failed to create invitation' }, { status: 500 });
    }
  }

  if (request.method === 'DELETE') {
    try {
      const body = await request.json().catch(() => null);
      const invitationId =
        body && typeof body === 'object'
          ? (body as { invitation_id?: string }).invitation_id
          : undefined;

      if (!invitationId) {
        return Response.json({ error: 'Invitation ID is required' }, { status: 400 });
      }

      const invitation = await getInvitation(authEnv, orgId, invitationId);
      if (!invitation) {
        return Response.json({ error: 'Invitation not found' }, { status: 404 });
      }

      const user = await authEnv.USER.get(
        authEnv.USER.idFromName(session.user_id)
      ).getProfile();
      if (!user) {
        return Response.json({ error: 'Not authenticated' }, { status: 401 });
      }

      const isAdmin = await isOrgAdmin(authEnv, session.user_id, orgId);
      const isInvitee = user.email.toLowerCase() === invitation.email.toLowerCase();
      if (!isAdmin && !isInvitee) {
        return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
      }

      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      await orgStub.deleteInvitation(invitationId);

      return Response.json({ success: true });
    } catch (error) {
      console.error('Delete invitation error:', error);
      return Response.json({ error: 'Failed to delete invitation' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
