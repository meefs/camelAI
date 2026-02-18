import { Link, useLoaderData } from 'react-router';
import type { Route } from './+types/_admin.orgs';
import { requireSuperuser } from '@/lib/auth.server';
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
    { title: 'Organizations - Admin - camelAI' },
    { name: 'description', content: 'Manage organizations' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search')?.trim() || '';

  const { items: orgs, total } = await authDO.adminGetOrgsPaginated(context, {
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/orgs?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/orgs';

  return { orgs, total, offset, search, baseUrl };
}

export default function AdminOrgsPage() {
  const { orgs, total, offset, baseUrl } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Organizations' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Organizations</h1>
              <p className="text-sm text-muted-foreground">
                {total} total organizations
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search organizations" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Workspaces</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead>Created By</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((org) => (
                  <TableRow key={org.id}>
                    <TableCell>
                      <Link
                        to={`/qaml-backdoor/orgs/${org.id}`}
                        className="block hover:underline"
                      >
                        <div className="font-medium text-foreground">{org.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {org.id.slice(0, 8)}...
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {org.member_count} {org.member_count === 1 ? 'member' : 'members'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {org.workspace_count} {org.workspace_count === 1 ? 'workspace' : 'workspaces'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={org.archived ? 'secondary' : 'outline'}>
                        {org.archived ? 'Archived' : 'Active'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={org.billing_status === 'paying' ? 'default' : 'outline'}>
                        {org.billing_status === 'paying' ? 'Paying' : 'Free'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/qaml-backdoor/users/${org.created_by}`}
                        className="text-xs text-muted-foreground font-mono hover:underline"
                      >
                        {org.created_by.slice(0, 8)}...
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(org.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
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
