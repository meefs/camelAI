import { Link } from 'react-router';
import type { Route } from './+types/_admin.logs';
import { requireSuperuser } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getVanityDomain } from '@/lib/app-url.server';
import * as authDO from '@/lib/auth-do.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { AdminSearch } from '@/components/admin/admin-search';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const APP_LIMIT = 50;
const LOG_LIMIT = 200;

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

type AdminLogEntry = {
  id: number;
  timestamp: number;
  level: string;
  message: string | null;
  exception: string | null;
  scriptVersion: string | null;
};

function formatTimestamp(value: number | null): string {
  if (!value) return 'Never';
  return timestampFormatter.format(new Date(value));
}

function getLevelVariant(level: string): 'destructive' | 'secondary' | 'outline' {
  const normalized = level.toLowerCase();
  if (
    normalized.includes('error') ||
    normalized.includes('exception') ||
    normalized.includes('fatal')
  ) {
    return 'destructive';
  }
  if (normalized.includes('warn')) {
    return 'secondary';
  }
  return 'outline';
}

function parseOffset(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '0', 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function meta() {
  return [
    { title: 'App Logs - Admin - camelAI' },
    { name: 'description', content: 'Inspect recent runtime logs for deployed apps' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parseOffset(url.searchParams.get('offset'));
  const search = url.searchParams.get('search')?.trim() ?? '';
  const selectedScript = url.searchParams.get('script')?.trim() ?? '';
  const selectedOrgId = url.searchParams.get('orgId')?.trim() ?? '';

  const { items: apps, total } = await authDO.adminGetAppsPaginated(context, {
    offset,
    limit: APP_LIMIT,
    search: search || undefined,
  });

  const baseParams = new URLSearchParams();
  if (search) baseParams.set('search', search);
  if (selectedScript) baseParams.set('script', selectedScript);
  if (selectedOrgId) baseParams.set('orgId', selectedOrgId);

  const query = baseParams.toString();
  const baseUrl = query ? `/qaml-backdoor/logs?${query}` : '/qaml-backdoor/logs';

  const env = getEnv(context);
  const vanityDomain = await getVanityDomain(request);

  let selectedApp:
    | {
      script_name: string;
      org_id: string;
      org_name: string;
      workspace_id: string;
      workspace_name: string;
      updated_at: number;
      dispatch_name: string;
    }
    | null = null;
  let selectedStorageKey: string | null = null;
  let logStats: { logCount: number; lastLogAt: number | null } | null = null;
  let logs: AdminLogEntry[] = [];
  let loadError: string | null = null;

  if (selectedScript && selectedOrgId) {
    const orgStub = env.ORG.get(env.ORG.idFromName(selectedOrgId));
    const [orgInfo, orgScripts, orgWorkspaces] = await Promise.all([
      orgStub.getInfo(),
      orgStub.listWorkerScripts(),
      orgStub.getWorkspaces(),
    ]);

    if (!orgInfo) {
      loadError = 'Organization not found for selected app.';
    } else {
      const script = orgScripts.find((entry) => entry.script_name === selectedScript);
      if (!script) {
        loadError = 'Selected app was not found in the selected organization.';
      } else {
        const workspaceName =
          orgWorkspaces.find((workspace) => workspace.id === script.workspace_id)?.name ?? 'Unknown';

        const dispatchName = orgInfo.slug
          ? `${script.script_name}--${orgInfo.slug}`
          : script.script_name;

        selectedApp = {
          script_name: script.script_name,
          org_id: orgInfo.id,
          org_name: orgInfo.name,
          workspace_id: script.workspace_id,
          workspace_name: workspaceName,
          updated_at: script.updated_at,
          dispatch_name: dispatchName,
        };

        // Security: do not fall back to unscoped legacy keys when an org slug exists.
        const storageKey = orgInfo.slug ? dispatchName : script.script_name;
        const logsStub = env.WORKER_LOGS.get(env.WORKER_LOGS.idFromName(storageKey));
        const [candidateLogs, candidateStats] = await Promise.all([
          logsStub.getLogs({ limit: LOG_LIMIT }),
          logsStub.getStats(),
        ]);

        selectedStorageKey = storageKey;
        logs = candidateLogs;
        logStats = candidateStats;
      }
    }
  }

  return {
    apps,
    total,
    offset,
    search,
    baseUrl,
    vanityDomain,
    selectedScript,
    selectedOrgId,
    selectedApp,
    selectedStorageKey,
    logStats,
    logs,
    loadError,
    logLimit: LOG_LIMIT,
  };
}

export default function AdminLogsPage({ loaderData }: Route.ComponentProps) {
  const {
    apps,
    total,
    offset,
    search,
    baseUrl,
    vanityDomain,
    selectedScript,
    selectedOrgId,
    selectedApp,
    selectedStorageKey,
    logStats,
    logs,
    loadError,
    logLimit,
  } = loaderData;

  const buildSelectionHref = (scriptName: string, orgId: string) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('script', scriptName);
    params.set('orgId', orgId);
    return `/qaml-backdoor/logs?${params.toString()}`;
  };

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'App Logs' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-7xl mx-auto w-full px-4 md:px-6 py-6 space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">App Logs</h1>
              <p className="text-sm text-muted-foreground">
                Pick an app to inspect the latest {logLimit} tail-captured entries.
              </p>
            </div>
            <div className="w-full sm:w-72">
              <AdminSearch placeholder="Search apps" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Logs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No apps found
                    </TableCell>
                  </TableRow>
                ) : (
                  apps.map((app) => {
                    const isSelected =
                      app.script_name === selectedScript && app.org_id === selectedOrgId;

                    return (
                      <TableRow key={`${app.org_id}:${app.script_name}`}>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-mono text-sm">{app.script_name}</div>
                            <a
                              href={`https://${app.script_name}.${vanityDomain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline font-mono"
                            >
                              {app.script_name}.{vanityDomain}
                            </a>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{app.org_name}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{app.workspace_name}</div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatTimestamp(app.updated_at)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            to={buildSelectionHref(app.script_name, app.org_id)}
                            className={
                              isSelected
                                ? 'text-sm font-medium text-foreground'
                                : 'text-sm text-primary hover:underline'
                            }
                          >
                            {isSelected ? 'Viewing' : 'View logs'}
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <AdminPagination
            total={total}
            offset={offset}
            limit={APP_LIMIT}
            baseUrl={baseUrl}
          />

          <div className="border border-border rounded-lg bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold tracking-tight">Recent Logs</h2>
            </div>

            {!selectedApp && !loadError ? (
              <div className="px-4 py-8 text-sm text-muted-foreground">
                Select an app from the list above to view logs.
              </div>
            ) : null}

            {loadError ? (
              <div className="px-4 py-8 text-sm text-destructive">{loadError}</div>
            ) : null}

            {selectedApp ? (
              <div className="px-4 py-4 border-b border-border space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-medium font-mono">{selectedApp.script_name}</div>
                  <Badge variant="outline">{selectedApp.org_name}</Badge>
                  <Badge variant="outline">{selectedApp.workspace_name}</Badge>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  Dispatch key: {selectedApp.dispatch_name}
                  {selectedStorageKey ? ` | Storage key: ${selectedStorageKey}` : ''}
                </div>
                <div className="text-xs text-muted-foreground">
                  {logStats
                    ? `${logStats.logCount} total entries${logStats.lastLogAt ? ` · last at ${formatTimestamp(logStats.lastLogAt)}` : ''}`
                    : 'No log stats available'}
                </div>
              </div>
            ) : null}

            {selectedApp && !loadError ? (
              logs.length === 0 ? (
                <div className="px-4 py-8 text-sm text-muted-foreground">
                  No logs captured yet for this app.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {logs.map((entry) => (
                    <div key={entry.id} className="px-4 py-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={getLevelVariant(entry.level)}>{entry.level}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                        {entry.scriptVersion ? (
                          <span className="text-xs text-muted-foreground font-mono">
                            v{entry.scriptVersion}
                          </span>
                        ) : null}
                      </div>
                      {entry.message ? (
                        <pre className="text-xs whitespace-pre-wrap break-words font-mono text-foreground m-0">
                          {entry.message}
                        </pre>
                      ) : null}
                      {entry.exception ? (
                        <pre className="text-xs whitespace-pre-wrap break-words font-mono text-destructive m-0">
                          {entry.exception}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
