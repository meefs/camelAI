import { redirect } from 'next/navigation';
import ConnectionsClient from './connections-client';
import { getAuthContextLite } from '@/lib/auth-context';
import { getIntegrationTypes } from '@/lib/server-actions/integrations';
import { getOrgIntegrations } from '@/lib/server-actions/org';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const authContext = await getAuthContextLite();
  if (!authContext) {
    redirect('/login');
  }

  const [{ integrations, categories }, connections] = await Promise.all([
    getIntegrationTypes(),
    getOrgIntegrations(authContext.currentOrg.id),
  ]);

  return (
    <ConnectionsClient
      initialConnections={connections}
      connectionTypes={integrations}
      categories={categories ?? []}
      orgId={authContext.currentOrg.id}
    />
  );
}
