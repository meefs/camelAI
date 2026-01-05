import ConnectionsClient from './connections-client';
import { requireAuthContextLite } from '@/lib/server-guards';
import { getIntegrationTypes } from '@/lib/server-actions/integrations';
import { getOrgIntegrations } from '@/lib/server-actions/org';

export default async function ConnectionsPage() {
  const authContext = await requireAuthContextLite();

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
