import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { ThreadEditForm } from '@/components/admin/thread-edit-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

export const dynamic = 'force-dynamic';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminThreadDetailPage({ params }: Props) {
  const { id } = await params;

  const result = await authDO.adminGetThreadWithMessages(id);
  if (!result) {
    notFound();
  }

  const { thread, messages, org_id } = result;

  // Create plain object for Client Component
  const safeThread = {
    id: thread.id,
    title: thread.title,
    project_id: thread.project_id,
    created_by: thread.created_by,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
  };

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Threads', href: '/qaml-backdoor/threads' },
          { label: thread.title },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Thread Details</CardTitle>
                <CardDescription>View and edit thread information</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">ID</dt>
                    <dd className="font-mono text-sm">{thread.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Title</dt>
                    <dd className="text-sm">{thread.title}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/orgs/${org_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {org_id.slice(0, 8)}...
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Project</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/projects/${thread.project_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {thread.project_id.slice(0, 8)}...
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(thread.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Updated</dt>
                    <dd className="text-sm">{formatTimestamp(thread.updated_at)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit Thread</CardTitle>
                <CardDescription>Update thread title</CardDescription>
              </CardHeader>
              <CardContent>
                <ThreadEditForm thread={safeThread} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Messages</CardTitle>
                <CardDescription>
                  {messages.length} {messages.length === 1 ? 'message' : 'messages'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No messages</p>
                ) : (
                  <ScrollArea className="h-[400px] pr-4">
                    <div className="space-y-4">
                      {messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`rounded-lg p-3 ${
                            msg.role === 'user'
                              ? 'bg-primary/10 ml-8'
                              : 'bg-muted mr-8'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <Badge variant={msg.role === 'user' ? 'default' : 'secondary'}>
                              {msg.role}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatTimestamp(msg.created_at)}
                            </span>
                          </div>
                          <div className="text-sm whitespace-pre-wrap break-words">
                            {msg.content.length > 1000
                              ? msg.content.slice(0, 1000) + '...'
                              : msg.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
