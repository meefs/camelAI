import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { requireSuperuser } from '@/lib/server-guards';
import { getVanityDomain } from '@/lib/app-url.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AppEditForm } from '@/components/admin/app-edit-form';
import { AppDangerZone } from '@/components/admin/app-danger-zone';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ExternalLink } from 'lucide-react';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

interface Props {
  params: Promise<{ scriptName: string }>;
}

export default async function AdminAppDetailPage({ params }: Props) {
  await requireSuperuser();

  const { scriptName } = await params;
  const decodedScriptName = decodeURIComponent(scriptName);

  const app = await authDO.adminGetAppDetail(decodedScriptName);
  if (!app) {
    notFound();
  }

  // Create plain object for Client Component
  const safeApp = {
    script_name: app.script_name,
    workspace_id: app.workspace_id,
    workspace_name: app.workspace_name,
    org_id: app.org_id,
    org_name: app.org_name,
    created_by: app.created_by,
    created_by_name: app.created_by_name,
    created_by_email: app.created_by_email,
    created_at: app.created_at,
    updated_at: app.updated_at,
    is_public: app.is_public,
  };

  const vanityDomain = await getVanityDomain();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Apps', href: '/qaml-backdoor/apps' },
          { label: app.script_name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>App Details</CardTitle>
                <CardDescription>View and manage deployed app</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Script Name</dt>
                    <dd className="font-mono text-sm">{app.script_name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Live URL</dt>
                    <dd>
                      <a
                        href={`https://${app.script_name}.${vanityDomain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {app.script_name}.{vanityDomain}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/orgs/${app.org_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {app.org_name} ({app.org_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Workspace</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {app.workspace_name} ({app.workspace_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created By</dt>
                    <dd className="text-sm">
                      {app.created_by.startsWith('system:') ? (
                        <span className="font-mono text-muted-foreground">{app.created_by}</span>
                      ) : (
                        <Link
                          href={`/qaml-backdoor/users/${app.created_by}`}
                          className="hover:underline"
                        >
                          {app.created_by_name || app.created_by_email || `${app.created_by.slice(0, 8)}...`}
                        </Link>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={app.is_public ? 'default' : 'secondary'}>
                        {app.is_public ? 'Public' : 'Private'}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(app.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Updated</dt>
                    <dd className="text-sm">{formatTimestamp(app.updated_at)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit App</CardTitle>
                <CardDescription>Update app visibility</CardDescription>
              </CardHeader>
              <CardContent>
                <AppEditForm app={safeApp} />
              </CardContent>
            </Card>

            <AppDangerZone app={safeApp} />
          </div>
        </div>
      </div>
    </>
  );
}
