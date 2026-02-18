import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.billing';
import { requireAuthContext } from '@/lib/auth.server';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';

export function meta() {
  return [
    { title: 'Billing - Settings - camelAI' },
    { name: 'description', content: 'Manage billing and subscription' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  return {
    org: authContext.currentOrg,
  };
}

export default function BillingPage() {
  const { org } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Billing"
        description="Manage your subscription and payment methods."
      />
      <Separator />
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Current plan</span>
          <Badge variant={org.billing_status === 'paying' ? 'default' : 'secondary'}>
            {org.billing_status === 'paying' ? 'Pro' : 'Free'}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">Billing settings will be available soon.</p>
      </div>
    </div>
  );
}
