import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.domains';
import { requireAuthContext } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';

export function meta() {
  return [
    { title: 'Domains - Settings - camelAI' },
    { name: 'description', content: 'Manage custom domains' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  return {
    org: authContext.currentOrg,
  };
}

export default function DomainsPage() {
  const { org } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Configure custom domains for your applications."
      />
      <Separator />
      <div className="text-sm text-muted-foreground">Custom domains coming soon.</div>
    </div>
  );
}
