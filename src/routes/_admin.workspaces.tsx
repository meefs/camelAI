import { Link, useLoaderData } from 'react-router';
import type { Route } from './+types/_admin.workspaces';
import { requireSuperuser } from '@/lib/auth.server';
import * as authDO from '@/lib/auth-do.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { AdminSearch } from '@/components/admin/admin-search';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getContrastTextColor } from '@/lib/avatar';

const LIMIT = 50;

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

export function meta() {
  return [
    { title: 'Workspaces - Admin - camelAI' },
    { name: 'description', content: 'Manage workspaces' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search')?.trim() || '';

  const { items: workspaces, total } = await authDO.adminGetWorkspacesPaginated(context, {
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/workspaces?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/workspaces';

  return { workspaces, total, offset, search, baseUrl };
}

export default function AdminWorkspacesPage() {
  const { workspaces, total, offset, baseUrl } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Workspaces' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Workspaces</h1>
              <p className="text-sm text-muted-foreground">
                {total} total workspaces
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search workspaces" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Threads</TableHead>
                  <TableHead>Integrations</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspaces.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No workspaces found
                    </TableCell>
                  </TableRow>
                ) : (
                  workspaces.map((workspace) => (
                    <TableRow key={workspace.id}>
                      <TableCell>
                        <Link
                          to={`/qaml-backdoor/workspaces/${workspace.id}`}
                          className="flex items-center gap-3 hover:underline"
                        >
                          <Avatar size="default">
                            <AvatarFallback
                              content={workspace.avatar.content}
                              style={{
                                backgroundColor: workspace.avatar.color,
                                color: getContrastTextColor(workspace.avatar.color),
                              }}
                            >
                              {workspace.avatar.content}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-medium text-foreground">{workspace.name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {workspace.id.slice(0, 8)}...
                            </div>
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/qaml-backdoor/orgs/${workspace.org_id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{workspace.org_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {workspace.org_id.slice(0, 8)}...
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{workspace.thread_count}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{workspace.integration_count}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={workspace.archived ? 'secondary' : 'outline'}>
                          {workspace.archived ? 'Archived' : 'Active'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(workspace.created_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <AdminPagination
            total={total}
            offset={offset}
            limit={LIMIT}
            baseUrl={baseUrl}
          />
        </div>
      </div>
    </>
  );
}
