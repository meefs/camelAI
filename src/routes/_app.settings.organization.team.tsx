import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.team';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { getOrgMembers, getOrgInvitations, type AuthEnv } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { TeamTable } from '@/components/settings/team-table';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
}

export function meta() {
  return [
    { title: 'Team - Settings - Chiridion' },
    { name: 'description', content: 'Manage team members' },
  ];
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
        orgId={org.id}
        currentUserId={currentUserId}
        canManageMembers={canManageMembers}
        members={members as never[]}
        invitations={invitations as never[]}
        workspaces={workspaces}
      />
    </div>
  );
}
