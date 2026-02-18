import { useLoaderData, redirect } from 'react-router';
import type { Route } from './+types/_admin.workspaces.$id.audit-log';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as adminDO from '@/lib/auth-do.server';
import { getWorkspaceAuditLog, getUsersByIds } from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AuditLogTable } from '@/components/admin/audit-log-table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.workspace ? `Audit Log - ${data.workspace.name} - Admin - camelAI` : 'Audit Log - Admin - camelAI' },
    { name: 'description', content: 'Workspace audit log' },
  ];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;
  const authEnv = getAuthEnv(getEnv(context));
  const detail = await adminDO.adminGetWorkspaceDetail(context, id);
  if (!detail) {
    throw redirect('/qaml-backdoor/workspaces');
  }

  const { workspace, org } = detail;

  const entries = await getWorkspaceAuditLog(authEnv, id, 100, 0);
  const userIds = new Set<string>();
  for (const entry of entries) {
    userIds.add(entry.actor_id);
    if (entry.target_id) {
      userIds.add(entry.target_id);
    }
  }
  const users = userIds.size > 0 ? await getUsersByIds(authEnv, Array.from(userIds)) : [];

  return { workspace, org, entries, users };
}

export default function WorkspaceAuditLogPage() {
  const { workspace, org, entries, users } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Workspaces', href: '/qaml-backdoor/workspaces' },
          { label: workspace.name, href: `/qaml-backdoor/workspaces/${workspace.id}` },
          { label: 'Audit Log' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <Card>
            <CardHeader>
              <CardTitle>Workspace Audit Log</CardTitle>
              <CardDescription>Recent activity for {workspace.name} in {org.name}</CardDescription>
            </CardHeader>
            <CardContent>
              <AuditLogTable entries={entries} users={users} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
