import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
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

export const dynamic = 'force-dynamic';

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

export default async function AdminThreadsPage({ searchParams }: Props) {
  const params = await searchParams;
  const offset = parseInt(params.offset || '0', 10);

  const { items: threads, total } = await authDO.adminGetThreadsPaginated({
    offset,
    limit: LIMIT,
  });

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Threads' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Threads</h1>
              <p className="text-sm text-muted-foreground">
                {total} total threads
              </p>
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Thread</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {threads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No threads found
                    </TableCell>
                  </TableRow>
                ) : (
                  threads.map((thread) => (
                    <TableRow key={thread.id}>
                      <TableCell>
                        <Link
                          href={`/qaml-backdoor/threads/${thread.id}`}
                          className="block hover:underline"
                        >
                          <div className="font-medium text-foreground">{thread.title}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {thread.id.slice(0, 8)}...
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/qaml-backdoor/orgs/${thread.org_id}`}
                          className="hover:underline"
                        >
                          <Badge variant="outline">
                            {thread.org_id.slice(0, 8)}...
                          </Badge>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/qaml-backdoor/projects/${thread.project_id}`}
                          className="text-xs text-muted-foreground font-mono hover:underline"
                        >
                          {thread.project_id.slice(0, 8)}...
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(thread.updated_at)}
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
            baseUrl="/qaml-backdoor/threads"
          />
        </div>
      </div>
    </>
  );
}
