import { Link, useLoaderData } from 'react-router';
import type { Route } from './+types/_admin.threads';
import { requireSuperuser } from '@/lib/auth.server';
import * as authDO from '@/lib/auth-do.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { AdminSearch } from '@/components/admin/admin-search';
import { Button } from '@/components/ui/button';
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
    { title: 'Threads - Admin - camelAI' },
    { name: 'description', content: 'Manage threads' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search')?.trim() || '';

  const { items: threads, total } = await authDO.adminGetThreadsPaginated(context, {
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/threads?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/threads';

  return { threads, total, offset, search, baseUrl };
}

export default function AdminThreadsPage() {
  const { threads, total, offset, baseUrl } = useLoaderData<typeof loader>();

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
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Threads</h1>
              <p className="text-sm text-muted-foreground">
                {total} total threads
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search threads" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Thread</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {threads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No threads found
                    </TableCell>
                  </TableRow>
                ) : (
                  threads.map((thread) => (
                    <TableRow key={thread.id}>
                      <TableCell>
                        <Link
                          to={`/qaml-backdoor/threads/${thread.id}`}
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
                          to={`/qaml-backdoor/orgs/${thread.org_id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{thread.org_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {thread.org_id.slice(0, 8)}...
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/qaml-backdoor/workspaces/${thread.workspace_id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{thread.workspace_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {thread.workspace_id.slice(0, 8)}...
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(thread.updated_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="outline" size="sm">
                          <Link
                            to={`/chat/${thread.id}?adminReadonly=1`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View as User
                          </Link>
                        </Button>
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
