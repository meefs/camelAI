import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.connections';
import { requireAuthContext } from '@/lib/auth.server';
import { INTEGRATION_REGISTRY } from '@/lib/integration-registry';
import ConnectionsClient from '@/components/pages/connections/connections-client';
import type { Integration } from '@/types';

export function meta() {
  return [
    { title: 'Connections - Chiridion' },
    { name: 'description', content: 'Manage integrations and connections' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = authContext.currentWorkspace?.id;

  // Get integration types
  const integrations = Object.values(INTEGRATION_REGISTRY);
  const categories = Array.from(
    new Set(integrations.map((i) => i.category))
  ) as string[];

  // Get workspace integrations
  // TODO: Implement getWorkspaceIntegrations once INTEGRATION_SECRET_KEY is available
  const connections: Integration[] = [];

  return {
    connections,
    integrations,
    categories,
    orgId: authContext.currentOrg.id,
    workspaceId: workspaceId ?? null,
  };
}

export default function ConnectionsPage() {
  const { connections, integrations, categories, orgId } =
    useLoaderData<typeof loader>();

  return (
    <ConnectionsClient
      initialConnections={connections}
      connectionTypes={integrations}
      categories={categories}
      orgId={orgId}
    />
  );
}
