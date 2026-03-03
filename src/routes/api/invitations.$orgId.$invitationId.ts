import type { Route } from './+types/invitations.$orgId.$invitationId';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getSignedSessionFromRequest, createSessionCookieHeader } from '@/lib/cookies.server';
import {
  acceptInvitation,
  getInvitation,
  listOrgWorkspaces,
  switchSessionOrg,
} from '@/lib/auth-do';

export async function loader({ params, context }: Route.LoaderArgs) {
  try {
    const orgId = params.orgId;
    const invitationId = params.invitationId;

    if (!orgId || !invitationId) {
      return Response.json({ error: 'Organization ID and invitation ID are required' }, { status: 400 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const invitation = await getInvitation(authEnv, orgId, invitationId);

    if (!invitation) {
      return Response.json({ error: 'Invitation not found' }, { status: 404 });
    }

    return Response.json({
      email: invitation.email,
      role: invitation.role,
      org: {
        id: invitation.org.id,
        name: invitation.org.name,
      },
    });
  } catch (error) {
    console.error('Load invitation error:', error);
    return Response.json({ error: 'Failed to load invitation' }, { status: 500 });
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const orgId = params.orgId;
    const invitationId = params.invitationId;

    if (!orgId || !invitationId) {
      return Response.json({ error: 'Organization ID and invitation ID are required' }, { status: 400 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    const session = await getSignedSessionFromRequest(request, env.TOKEN_SIGNING_SECRET);
    if (!session) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
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

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      return Response.json({ error: 'Invitation email does not match current user' }, { status: 403 });
    }

    const accepted = await acceptInvitation(authEnv, orgId, invitationId, session.user_id);
    if (!accepted) {
      return Response.json({ error: 'Invitation not found' }, { status: 404 });
    }

    const workspaces = await listOrgWorkspaces(authEnv, orgId);
    const workspaceId = workspaces[0]?.id ?? null;

    // Re-sign session with new org and return updated cookie
    const currentSessionData = {
      user_id: session.user_id,
      org_id: session.org_id,
      workspace_id: session.workspace_id,
      created_at: session.created_at,
      last_accessed: session.created_at,
      user_name: session.user_name,
      user_email: session.user_email,
    };
    const signedToken = await switchSessionOrg(authEnv, currentSessionData, orgId, workspaceId);

    return Response.json(
      {
        success: true,
        org: { id: invitation.org.id, name: invitation.org.name },
        workspace: workspaceId ? { id: workspaceId } : null,
      },
      { headers: { 'Set-Cookie': createSessionCookieHeader(signedToken, request) } }
    );
  } catch (error) {
    console.error('Accept invitation error:', error);
    return Response.json({ error: 'Failed to accept invitation' }, { status: 500 });
  }
}
