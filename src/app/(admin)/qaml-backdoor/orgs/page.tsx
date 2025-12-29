import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

export default async function AdminOrgsPage() {
  const orgs = await authDO.adminGetAllOrgs();

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
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Organizations</h1>
              <p className="text-sm text-muted-foreground">
                {orgs.length} total organizations
              </p>
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Created By</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((org) => (
                  <TableRow key={org.id}>
                    <TableCell>
                      <Link
                        href={`/qaml-backdoor/orgs/${org.id}`}
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
                      <Link
                        href={`/qaml-backdoor/users/${org.created_by}`}
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
        </div>
      </div>
    </>
  );
}
