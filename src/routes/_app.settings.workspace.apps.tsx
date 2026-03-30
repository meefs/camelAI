import { useState } from 'react';
import { useLoaderData, useSearchParams, useFetcher } from 'react-router';
import type { Route } from './+types/_app.settings.workspace.apps';
import { requireAuthContext, requireOrgAdmin } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import {
  getWorkerScript,
  deleteWorkerScript,
  getOrgCustomDomain,
} from '@/lib/auth-do';
import { deleteDispatchScript } from '../../workers/main/src/cf-api-proxy';
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
import { ExternalLink, Trash2 } from 'lucide-react';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import { getPreferredAppUrl } from '@/lib/app-url';
import { refreshWorkerScriptCustomDomainStates } from '@/lib/custom-domain.server';
import type { WorkerScriptWithCreator } from '@/types';

interface AppRow extends WorkerScriptWithCreator {
  workspace_name: string;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString();
}

function getAuthEnvFromCloudflare(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,

  };
}

export function meta() {
  return [
    { title: 'Apps - Workspace Settings - camelAI' },
    { name: 'description', content: 'Manage workspace apps' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnvFromCloudflare(env);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'deleteApp') {
    const scriptName = formData.get('scriptName') as string;

    if (!scriptName) {
      return { error: 'Script name is required' };
    }

    const accountId = env.CF_ACCOUNT_ID;
    const dispatchNamespace = env.CF_DISPATCH_NAMESPACE;
    const apiToken = env.CF_API_TOKEN;

    if (!accountId || !dispatchNamespace || !apiToken) {
      return { error: 'Server configuration error: Missing Cloudflare credentials' };
    }

    try {
      // Verify the script belongs to the current org
      const script = await getWorkerScript(
        authEnv,
        authContext.currentOrg.id,
        scriptName
      );

      if (!script) {
        return { error: 'App not found or you do not have permission to delete it' };
      }

      // Delete from Cloudflare first
      const cfDeleteSuccess = await deleteDispatchScript(
        accountId,
        dispatchNamespace,
        scriptName,
        apiToken
      );

      if (!cfDeleteSuccess) {
        return { error: 'Failed to delete app from Cloudflare. Please try again.' };
      }

      // Delete from database and KV index
      await deleteWorkerScript(
        authEnv,
        authContext.currentOrg.id,
        scriptName,
        authContext.user.id
      );

      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete app' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnvFromCloudflare(env);

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';
  const workspaceId = authContext.currentWorkspace?.id;

  const orgSlug = authContext.currentOrg.slug;

  if (!workspaceId) {
    return { apps: [] as AppRow[], hasWorkspace: false, filter, orgSlug, orgCustomDomain: null };
  }

  const workspaces = authContext.workspaces ?? [];
  const workspaceNameMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

  // Fetch all scripts from OrgDO
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id));
  const [scripts, customDomain] = await Promise.all([
    orgStub.listWorkerScripts(),
    getOrgCustomDomain(authEnv, authContext.currentOrg.id),
  ]);
  const orgCustomDomain = customDomain?.domain ?? null;
  const refreshedScripts = await refreshWorkerScriptCustomDomainStates(
    env,
    authContext.currentOrg.id,
    scripts,
    orgCustomDomain
  );

  // Filter based on scope
  const filteredScripts = filter === 'all-workspaces'
    ? refreshedScripts
    : refreshedScripts.filter((s) => s.workspace_id === workspaceId);

  // Hydrate creators
  const creatorIds = Array.from(
    new Set(filteredScripts.map((s) => s.created_by).filter(Boolean))
  );
  const creatorProfiles = await Promise.all(
    creatorIds.map(async (id) => {
      const profile = await authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile();
      return [id, profile] as const;
    })
  );
  const creatorMap = new Map(creatorProfiles.filter(([, p]) => p !== null));

  const apps: AppRow[] = filteredScripts.map((script) => {
    const creator = creatorMap.get(script.created_by);
    return {
      ...script,
      workspace_name: workspaceNameMap.get(script.workspace_id) ?? script.workspace_id,
      creator: creator
        ? {
            id: creator.id,
            name: creator.name,
            email: creator.email,
            avatar: creator.avatar,
          }
        : undefined,
    };
  });

  return { apps, hasWorkspace: true, filter, orgSlug, orgCustomDomain };
}

export default function WorkspaceAppsPage() {
  const { apps, hasWorkspace, filter, orgSlug, orgCustomDomain } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [deleteTarget, setDeleteTarget] = useState<AppRow | null>(null);

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

  const handleDelete = (app: AppRow) => {
    fetcher.submit(
      {
        intent: 'deleteApp',
        scriptName: app.script_name,
      },
      { method: 'POST' }
    );
    setDeleteTarget(null);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Apps"
        description="View and manage deployed apps across workspaces."
      />
      <Separator />

      <Tabs value={currentFilter} onValueChange={handleFilterChange}>
        <TabsList variant="line">
          <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
          <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
        </TabsList>
      </Tabs>

      {apps.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No apps found.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              {showWorkspaceColumn ? <TableHead>Workspace</TableHead> : null}
              <TableHead>Created By</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Modified</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={app.script_name}>
                <TableCell className="font-medium font-mono text-sm">
                  <a
                    href={getPreferredAppUrl(app, { orgSlug, orgCustomDomain })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {app.script_name}
                  </a>
                </TableCell>
                {showWorkspaceColumn ? (
                  <TableCell className="text-muted-foreground text-sm">
                    {app.workspace_name}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground text-sm">
                  {app.creator?.name ?? app.creator?.email ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(app.created_at)}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(app.updated_at)}
                </TableCell>
                <TableCell>
                  <Badge variant={app.is_public ? 'secondary' : 'outline'}>
                    {app.is_public ? 'Public' : 'Private'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      asChild
                    >
                      <a
                        href={getPreferredAppUrl(app, { orgSlug, orgCustomDomain })}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in new tab"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(app)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
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
        title="Delete app?"
        description={`This will permanently delete "${deleteTarget?.script_name}". The app will be taken offline immediately. This action cannot be undone.`}
        confirmLabel="Delete app"
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
        }}
      />
    </div>
  );
}
