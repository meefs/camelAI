import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.general';
import { requireAuthContext } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { OrgGeneralForm } from '@/components/settings/org-general-form';

export function meta() {
  return [
    { title: 'Organization General - Settings - Chiridion' },
    { name: 'description', content: 'Manage organization settings' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  return {
    org: authContext.currentOrg,
  };
}

export default function OrganizationGeneralPage() {
  const { org } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organization"
        description="Manage your organization settings."
      />
      <Separator />
      <OrgGeneralForm org={org} canEdit={true} />
    </div>
  );
}
