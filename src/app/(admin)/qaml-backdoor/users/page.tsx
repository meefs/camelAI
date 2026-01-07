import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { requireSuperuser } from '@/lib/server-guards';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
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

interface Props {
  searchParams: Promise<{ offset?: string }>;
}

export default async function AdminUsersPage({ searchParams }: Props) {
  await requireSuperuser();

  const params = await searchParams;
  const offset = parseInt(params.offset || '0', 10);

  const { items: users, total } = await authDO.adminGetUsersPaginated({
    offset,
    limit: LIMIT,
  });

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
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Users</h1>
              <p className="text-sm text-muted-foreground">
                {total} total users
              </p>
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Orgs</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <Link
                        href={`/qaml-backdoor/users/${user.id}`}
                        className="block hover:underline"
                      >
                        <div className="font-medium text-foreground">
                          {user.name || user.email}
                        </div>
                        {user.name && (
                          <div className="text-xs text-muted-foreground">{user.email}</div>
                        )}
                        <div className="text-xs text-muted-foreground font-mono">
                          {user.id.slice(0, 8)}...
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {user.org_count} {user.org_count === 1 ? 'org' : 'orgs'}
                      </Badge>
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
            baseUrl="/qaml-backdoor/users"
          />
        </div>
      </div>
    </>
  );
}
