import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organizations';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { OrgMembershipsList } from '@/components/settings/org-memberships-list';

export function meta() {
  return [
    { title: 'Organizations - Settings - camelAI' },
    { name: 'description', content: 'Manage your organizations' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const actorId = authContext.user!.id;

  if (intent === 'createOrg') {
    const name = formData.get('name') as string;
    if (!name?.trim()) {
      return { error: 'Organization name is required' };
    }
    const { org } = await authDO.createOrg(authEnv, name.trim(), actorId);
    return { success: true, orgId: org.id };
  }

  if (intent === 'leaveOrg') {
    const orgId = formData.get('orgId') as string;
    if (!orgId) {
      return { error: 'Organization ID is required' };
    }
    await authDO.removeOrgMember(authEnv, orgId, actorId, actorId);
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  // Fetch member counts, workspace counts, and billing status for each org in parallel
  const orgSummaries = await Promise.all(
    authContext.orgs.map(async (org) => {
      const [members, workspaces, orgInfo] = await Promise.all([
        authDO.getOrgMembers(authEnv, org.org_id),
        authDO.listOrgWorkspaces(authEnv, org.org_id),
        authDO.getOrg(authEnv, org.org_id),
      ]);

      return {
        org_id: org.org_id,
        org_name: org.org_name,
        role: org.role,
        joined_at: org.joined_at,
        billing_status: orgInfo?.billing_status ?? 'free',
        member_count: members.length,
        workspace_count: workspaces.length,
      };
    })
  );

  return {
    orgs: orgSummaries,
    currentOrgId: authContext.currentOrg.id,
    currentUserId: authContext.user.id,
  };
}

export default function OrganizationsPage() {
  const { orgs, currentOrgId, currentUserId } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organizations"
        description="Switch between or manage your organizations."
      />
      <Separator />
      <OrgMembershipsList orgs={orgs} currentUserId={currentUserId} />
    </div>
  );
}
