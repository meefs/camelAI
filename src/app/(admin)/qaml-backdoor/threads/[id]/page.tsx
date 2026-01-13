import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { requireSuperuser } from '@/lib/server-guards';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { ThreadEditForm } from '@/components/admin/thread-edit-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

function getTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n');
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminThreadDetailPage({ params }: Props) {
  await requireSuperuser();

  const { id } = await params;

  const result = await authDO.adminGetThreadWithMessages(id);
  if (!result) {
    notFound();
  }

  const { thread, messages, org_id, org_name, workspace_id, workspace_name, preview_workers } = result;

  // Create plain object for Client Component
  const safeThread = {
    id: thread.id,
    title: thread.title,
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
                        {org_name} ({org_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Workspace</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/workspaces/${workspace_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {workspace_name} ({workspace_id.slice(0, 8)}...)
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
                <CardTitle>Preview Workers</CardTitle>
                <CardDescription>
                  {preview_workers.length} {preview_workers.length === 1 ? 'worker' : 'workers'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {preview_workers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No preview workers</p>
                ) : (
                  <div className="space-y-2">
                    {preview_workers.map((worker) => (
                      <div key={worker} className="flex items-center justify-between p-2 rounded-md bg-muted">
                        <code className="text-sm">{worker}</code>
                        <a
                          href={`https://${worker}.chiridion.app`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary hover:underline"
                        >
                          https://{worker}.chiridion.app
                        </a>
                      </div>
                    ))}
                  </div>
                )}
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
                            {(() => {
                              const text = getTextContent(msg.content);
                              return text.length > 1000 ? text.slice(0, 1000) + '...' : text;
                            })()}
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
