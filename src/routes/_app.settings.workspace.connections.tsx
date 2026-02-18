import { useState } from 'react';
import { useLoaderData, useSearchParams, useFetcher } from 'react-router';
import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/_app.settings.workspace.connections';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { WorkspaceContainer, type WorkspaceContainerEnv } from '../../workers/main/src/workspace-container';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trash2 } from 'lucide-react';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Integration, User } from '@/types';

interface ConnectionRow extends Integration {
  workspace_id: string;
  workspace_name: string;
  creator?: Pick<User, 'id' | 'name' | 'email'> | null;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString();
}

function getWorkspaceStub(env: CloudflareEnv, workspaceId: string) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
}

function recordToIntegration(record: {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string;
  credentials_encrypted: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}): Integration {
  return {
    id: record.id,
    integration_type: record.integration_type,
    name: record.name,
    category: record.category as Integration['category'],
    auth_method: record.auth_method as Integration['auth_method'],
    config: JSON.parse(record.config) as Record<string, unknown>,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
    has_credentials: Boolean(record.credentials_encrypted),
  };
}

export function meta() {
  return [
    { title: 'Connections - Workspace Settings - camelAI' },
    { name: 'description', content: 'Manage workspace connections' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'deleteIntegration') {
    const integrationId = formData.get('integrationId') as string;
    const workspaceId = formData.get('workspaceId') as string;

    if (!integrationId || !workspaceId) {
      return { error: 'Integration ID and workspace ID are required' };
    }

    try {
      const stub = getWorkspaceStub(env, workspaceId);
      await stub.deleteIntegration(integrationId, authContext.user.id);
      waitUntil(
        new WorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId, authContext.currentOrg.id)
          .refreshIntegrationEnvVars()
          .catch(() => {})
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete connection' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';
  const workspaceId = authContext.currentWorkspace?.id;

  if (!workspaceId) {
    return { connections: [] as ConnectionRow[], hasWorkspace: false, filter };
  }

  const workspaces = authContext.workspaces ?? [];
  const workspaceNameMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

  // Fetch connections from relevant workspaces
  const targetWorkspaces = filter === 'all-workspaces'
    ? workspaces
    : workspaces.filter((ws) => ws.id === workspaceId);

  const allRecords: Array<Integration & { workspace_id: string; workspace_name: string }> = [];
  await Promise.all(
    targetWorkspaces.map(async (ws) => {
      const stub = getWorkspaceStub(env, ws.id);
      const records = await stub.getIntegrations();
      for (const record of records) {
        allRecords.push({
          ...recordToIntegration(record),
          workspace_id: ws.id,
          workspace_name: ws.name,
        });
      }
    })
  );

  // Sort by most recently updated
  allRecords.sort((a, b) => b.updated_at - a.updated_at);

  // Hydrate creators
  const creatorIds = Array.from(new Set(allRecords.map((r) => r.created_by).filter(Boolean)));
  const creatorProfiles = await Promise.all(
    creatorIds.map(async (id) => {
      const profile = await authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile();
      return [id, profile] as const;
    })
  );
  const creatorMap = new Map(creatorProfiles.filter(([, p]) => p !== null));

  const connections: ConnectionRow[] = allRecords.map((record) => {
    const creator = creatorMap.get(record.created_by);
    return {
      ...record,
      creator: creator ? { id: creator.id, name: creator.name, email: creator.email } : null,
    };
  });

  return { connections, hasWorkspace: true, filter };
}

export default function WorkspaceConnectionsPage() {
  const { connections, hasWorkspace, filter } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRow | null>(null);

  if (!hasWorkspace) {
    return <NoWorkspacesError />;
  }

  const currentFilter = searchParams.get('filter') || 'this-workspace';
  const showWorkspaceColumn = currentFilter === 'all-workspaces';

  const handleFilterChange = (value: string) => {
    setSearchParams((prev) => {
      prev.set('filter', value);
      return prev;
    });
  };

  const handleDelete = (connection: ConnectionRow) => {
    fetcher.submit(
      {
        intent: 'deleteIntegration',
        integrationId: connection.id,
        workspaceId: connection.workspace_id,
      },
      { method: 'POST' }
    );
    setDeleteTarget(null);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Connections"
        description="View and manage connections across workspaces."
      />
      <Separator />

      <Tabs value={currentFilter} onValueChange={handleFilterChange}>
        <TabsList variant="line">
          <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
          <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
        </TabsList>
      </Tabs>

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No connections found.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              {showWorkspaceColumn ? <TableHead>Workspace</TableHead> : null}
              <TableHead>Created By</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Modified</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow key={`${connection.workspace_id}-${connection.id}`}>
                <TableCell className="font-medium">{connection.name}</TableCell>
                <TableCell>
                  <Badge variant="outline">{connection.integration_type}</Badge>
                </TableCell>
                {showWorkspaceColumn ? (
                  <TableCell className="text-muted-foreground text-sm">
                    {connection.workspace_name}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground text-sm">
                  {connection.creator?.name ?? connection.creator?.email ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(connection.created_at)}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(connection.updated_at)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteTarget(connection)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete connection?"
        description={`This will permanently delete "${deleteTarget?.name}". This action cannot be undone.`}
        confirmLabel="Delete connection"
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
        }}
      />
    </div>
  );
}
