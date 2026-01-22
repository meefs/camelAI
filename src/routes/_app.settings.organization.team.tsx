import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.team';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getOrgStub } from '@/lib/auth-helpers';
import { createInvitation, removeOrgMember, updateOrgMemberRole, transferOrgOwnership, setWorkspaceAccess, getOrgMembers, getOrgInvitations } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { TeamTable } from '@/components/settings/team-table';
import type { OrgRole, WorkspaceAccessLevel } from '@/types';

export function meta() {
  return [
    { title: 'Team - Settings - Chiridion' },
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

  if (intent === 'createInvitation') {
    const email = formData.get('email') as string;
    const role = formData.get('role') as OrgRole;
    if (!email || !email.includes('@')) {
      return { error: 'Valid email is required' };
    }
    await createInvitation(authEnv, orgId, email.toLowerCase().trim(), role || 'member', actorId);
    return { success: true };
  }

  if (intent === 'removeOrgMember') {
    const userId = formData.get('userId') as string;
    if (!userId) {
      return { error: 'User ID is required' };
    }
    await removeOrgMember(authEnv, orgId, userId, actorId);
    return { success: true };
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
    await transferOrgOwnership(authEnv, orgId, newOwnerId, actorId);
    return { success: true };
  }

  if (intent === 'deleteInvitation') {
    const invitationId = formData.get('invitationId') as string;
    if (!invitationId) {
      return { error: 'Invitation ID is required' };
    }
    const stub = getOrgStub(authEnv, orgId);
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

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const [members, invitations] = await Promise.all([
    getOrgMembers(authEnv, authContext.currentOrg.id),
    getOrgInvitations(authEnv, authContext.currentOrg.id),
  ]);

  return {
    org: authContext.currentOrg,
    members,
    invitations,
    currentUserId: authContext.user.id,
  };
}

export default function TeamPage() {
  const { org, members, invitations, currentUserId } =
    useLoaderData<typeof loader>();

  // TODO: Get workspaces from loader
  const workspaces: never[] = [];
  // Admins and owners can manage members
  const canManageMembers = true; // TODO: Calculate based on user's role

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
        members={members as never[]}
        invitations={invitations as never[]}
        workspaces={workspaces}
      />
    </div>
  );
}
