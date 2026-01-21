import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organizations';
import { requireAuthContext } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { OrgMembershipsList } from '@/components/settings/org-memberships-list';

export function meta() {
  return [
    { title: 'Organizations - Settings - Chiridion' },
    { name: 'description', content: 'Manage your organizations' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  // Map orgs to the summary format expected by the component
  const orgSummaries = authContext.orgs.map(org => ({
    org_id: org.org_id,
    org_name: org.org_name,
    role: org.role,
    joined_at: org.joined_at,
    billing_status: 'free' as const, // TODO: Get from org data
    member_count: 1, // TODO: Get actual count
    workspace_count: 1, // TODO: Get actual count
  }));

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
