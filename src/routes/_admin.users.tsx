import { Link, useLoaderData, useSearchParams } from 'react-router';
import type { Route } from './+types/_admin.users';
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
    { title: 'Users - Admin - camelAI' },
    { name: 'description', content: 'Manage users' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search')?.trim() || '';

  const { items: users, total } = await authDO.adminGetUsersPaginated(context, {
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/users?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/users';

  return { users, total, offset, search, baseUrl };
}

export default function AdminUsersPage() {
  const { users, total, offset, baseUrl } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Users' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Users</h1>
              <p className="text-sm text-muted-foreground">
                {total} total users
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search users" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Orgs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <Link
                        to={`/qaml-backdoor/users/${user.id}`}
                        className="flex items-center gap-3 hover:underline"
                      >
                        <Avatar size="default">
                          <AvatarFallback
                            content={user.avatar.content}
                            style={{
                              backgroundColor: user.avatar.color,
                              color: getContrastTextColor(user.avatar.color),
                            }}
                          >
                            {user.avatar.content}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-foreground">
                            {user.name || user.email}
                          </div>
                          {user.name && (
                            <div className="text-xs text-muted-foreground">{user.email}</div>
                          )}
                          <div className="text-xs text-muted-foreground font-mono">
                            {user.id.slice(0, 8)}...
                          </div>
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {user.org_count} {user.org_count === 1 ? 'org' : 'orgs'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {user.is_orphaned ? (
                        <Badge variant="destructive">Orphaned</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Active</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(user.created_at)}
                    </TableCell>
                    <TableCell>
                      {user.is_superuser ? (
                        <Badge>Superuser</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Standard</span>
                      )}
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
