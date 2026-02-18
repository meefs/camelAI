import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.team';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { createInvitation, removeOrgMember, updateOrgMemberRole, transferOrgOwnership, setWorkspaceAccess, updateInvitationWorkspaceAccess, getOrgMembersWithWorkspaceAccess, getOrgInvitations, listOrgWorkspaces } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { TeamTable } from '@/components/settings/team-table';
import type { OrgRole, WorkspaceAccessLevel } from '@/types';
import {
  buildInvitationUrl,
  resolveAppBaseUrl,
  sendOrgInvitationEmail,
} from '@/lib/email.server';

export function meta() {
  return [
    { title: 'Team - Settings - camelAI' },
    { name: 'description', content: 'Manage team members' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = authContext.currentOrg!.id;
  const actorId = authContext.user!.id;

  // Members can only leave (remove themselves) — all other actions require admin
  if (intent === 'removeOrgMember') {
    const userId = formData.get('userId') as string;
    if (!userId) {
      return { error: 'User ID is required' };
    }
    // Non-admins can only remove themselves (leave org)
    if (userId !== actorId) {
      await requireOrgAdmin(request, context, orgId);
    }
    await removeOrgMember(authEnv, orgId, userId, actorId);
    return { success: true };
  }

  // All remaining actions require admin/owner
  await requireOrgAdmin(request, context, orgId);

  if (intent === 'createInvitation') {
    const email = formData.get('email') as string;
    const role = formData.get('role') as OrgRole;
    if (!email || !email.includes('@')) {
      return { error: 'Valid email is required' };
    }
    const normalizedEmail = email.toLowerCase().trim();
    const invitation = await createInvitation(
      authEnv,
      orgId,
      normalizedEmail,
      role || 'member',
      actorId
    );
    const baseUrl = resolveAppBaseUrl(env, new URL(request.url));
    const invitationUrl = buildInvitationUrl(baseUrl, orgId, invitation.id);
    const emailDelivery = await sendOrgInvitationEmail({
      env,
      to: normalizedEmail,
      orgName: authContext.currentOrg.name,
      inviterName: authContext.user.name ?? authContext.user.email,
      role: role || 'member',
      invitationUrl,
      expiresAt: invitation.expires_at,
    });

    if (emailDelivery.status === 'sent') {
      return { success: true };
    }

    const warning =
      emailDelivery.status === 'failed'
        ? 'Invitation created, but email delivery failed. Share the invitation link manually.'
        : 'Invitation created, but email delivery is not configured yet. Share the invitation link manually.';

    return {
      success: true,
      warning,
      invitation_url: invitationUrl,
      email_delivery: emailDelivery.status,
      email_delivery_reason: emailDelivery.reason ?? null,
    };
  }

  if (intent === 'updateOrgMemberRole') {
    const userId = formData.get('userId') as string;
    const role = formData.get('role') as OrgRole;
    if (!userId || !role) {
      return { error: 'User ID and role are required' };
    }
    await updateOrgMemberRole(authEnv, orgId, userId, role, actorId);
    return { success: true };
  }

  if (intent === 'transferOrgOwnership') {
    const newOwnerId = formData.get('newOwnerId') as string;
    if (!newOwnerId) {
      return { error: 'New owner ID is required' };
    }
    // Only the current owner can transfer ownership (not just any admin)
    const currentUserOrg = authContext.orgs.find((o) => o.org_id === orgId);
    if (currentUserOrg?.role !== 'owner') {
      return { error: 'Only the organization owner can transfer ownership' };
    }
    await transferOrgOwnership(authEnv, orgId, newOwnerId, actorId);
    return { success: true };
  }

  if (intent === 'deleteInvitation') {
    const invitationId = formData.get('invitationId') as string;
    if (!invitationId) {
      return { error: 'Invitation ID is required' };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.deleteInvitation(invitationId);
    return { success: true };
  }

  if (intent === 'updateWorkspaceAccess') {
    const userId = formData.get('userId') as string;
    const workspaceId = formData.get('workspaceId') as string;
    const access = formData.get('access') as WorkspaceAccessLevel;
    if (!userId || !workspaceId || !access) {
      return { error: 'User ID, workspace ID, and access level are required' };
    }
    await setWorkspaceAccess(authEnv, workspaceId, userId, access, actorId);
    return { success: true };
  }

  if (intent === 'updateInvitationWorkspaceAccess') {
    const invitationId = formData.get('invitationId') as string;
    const workspaceId = formData.get('workspaceId') as string;
    const access = formData.get('access') as WorkspaceAccessLevel;
    if (!invitationId || !workspaceId || !access) {
      return { error: 'Invitation ID, workspace ID, and access level are required' };
    }
    await updateInvitationWorkspaceAccess(authEnv, orgId, invitationId, workspaceId, access);
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const [members, invitations, workspaces] = await Promise.all([
    getOrgMembersWithWorkspaceAccess(authEnv, authContext.currentOrg.id),
    getOrgInvitations(authEnv, authContext.currentOrg.id),
    listOrgWorkspaces(authEnv, authContext.currentOrg.id),
  ]);

  // Determine current user's role in this org
  const currentMember = members.find((m) => m.user.id === authContext.user.id);
  const currentUserRole = currentMember?.role ?? 'member';
  const canManageMembers = currentUserRole === 'owner' || currentUserRole === 'admin';

  return {
    org: authContext.currentOrg,
    members,
    invitations,
    workspaces,
    currentUserId: authContext.user.id,
    canManageMembers,
  };
}

export default function TeamPage() {
  const { org, members, invitations, workspaces, currentUserId, canManageMembers } =
    useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Team"
        description="Invite and manage team members."
      />
      <Separator />
      <TeamTable
        currentUserId={currentUserId}
        canManageMembers={canManageMembers}
        members={members}
        invitations={invitations}
        workspaces={workspaces}
      />
    </div>
  );
}
