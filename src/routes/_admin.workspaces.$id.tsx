import { Link, useLoaderData, redirect, useFetcher } from 'react-router';
import type { Route } from './+types/_admin.workspaces.$id';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as adminDO from '@/lib/auth-do.server';
import { getUsersByIds } from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { WorkspaceEditForm } from '@/components/admin/workspace-edit-form';
import { WorkspaceDangerZone } from '@/components/admin/workspace-danger-zone';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getContrastTextColor } from '@/lib/avatar';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.workspace ? `${data.workspace.name} - Admin - camelAI` : 'Workspace - Admin - camelAI' },
    { name: 'description', content: 'View workspace details' },
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

  const { workspace, org, threads, integrations, members } = detail;
  const userIds = new Set<string>([workspace.created_by]);
  for (const member of members) {
    userIds.add(member.user_id);
    userIds.add(member.granted_by);
  }
  const users = userIds.size > 0 ? await getUsersByIds(authEnv, Array.from(userIds)) : [];
  const userById = Object.fromEntries(users.map((user) => [user.id, user]));

  return {
    workspace,
    org,
    threads,
    integrations,
    members,
    userById,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get('intent');
  const { id: workspaceId } = params;
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === 'updateWorkspace') {
    const name = formData.get('name') as string;
    const description = formData.get('description') as string | null;
    const avatarColor = formData.get('avatarColor') as string;
    const avatarContent = formData.get('avatarContent') as string;

    if (!name?.trim()) {
      return { error: 'Workspace name is required' };
    }

    const stub = authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId));
    try {
      await stub.updateWorkspace({
        name: name.trim(),
        description: description?.trim() || null,
        avatar: { color: avatarColor, content: avatarContent },
      }, 'system-admin');
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) {
        return { error: 'A workspace with that name already exists in this organization' };
      }
      throw err;
    }
    return { success: true };
  }

  if (intent === 'archiveWorkspace') {
    const stub = authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId));
    await stub.archive('system-admin');
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export default function AdminWorkspaceDetailPage() {
  const { workspace, org, threads, integrations, members, userById } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Workspaces', href: '/qaml-backdoor/workspaces' },
          { label: workspace.name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Workspace Details</CardTitle>
                <CardDescription>Read-only workspace metadata</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">ID</dt>
                    <dd className="font-mono text-sm">{workspace.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Name</dt>
                    <dd className="text-sm">{workspace.name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/orgs/${org.id}`}
                        className="text-sm hover:underline"
                      >
                        {org.name}
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created By</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/users/${workspace.created_by}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {userById[workspace.created_by]?.name ||
                          userById[workspace.created_by]?.email ||
                          workspace.created_by.slice(0, 8) + '...'}
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(workspace.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={workspace.archived ? 'secondary' : 'outline'}>
                        {workspace.archived ? 'Archived' : 'Active'}
                      </Badge>
                    </dd>
                  </div>
                  {workspace.archived && workspace.archived_at ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Archived At</dt>
                      <dd className="text-sm">{formatTimestamp(workspace.archived_at)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Avatar</dt>
                    <dd className="flex items-center gap-3 mt-1">
                      <Avatar size="lg">
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
                      <span className="text-xs text-muted-foreground">
                        {workspace.avatar.color}
                      </span>
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Description</dt>
                    <dd className="text-sm">
                      {workspace.description || 'No description'}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/qaml-backdoor/workspaces/${workspace.id}/audit-log`}>
                      View Audit Log
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit Workspace</CardTitle>
                <CardDescription>Update workspace name, description, and avatar</CardDescription>
              </CardHeader>
              <CardContent>
                <WorkspaceEditForm workspace={workspace} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Member Access</CardTitle>
                <CardDescription>Explicit workspace access rules</CardDescription>
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No explicit restrictions. All org members have full access.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Access Level</TableHead>
                        <TableHead>Granted By</TableHead>
                        <TableHead>Granted At</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((member) => {
                        const memberUser = userById[member.user_id];
                        const granter = userById[member.granted_by];
                        const accessLabel =
                          member.access_level === 'none'
                            ? 'None'
                            : 'Full';
                        return (
                          <TableRow key={member.user_id}>
                            <TableCell>
                              <Link
                                to={`/qaml-backdoor/users/${member.user_id}`}
                                className="hover:underline"
                              >
                                <div className="font-medium">
                                  {memberUser?.name || memberUser?.email || member.user_id}
                                </div>
                                {memberUser?.email ? (
                                  <div className="text-xs text-muted-foreground">
                                    {memberUser.email}
                                  </div>
                                ) : null}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{accessLabel}</Badge>
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/qaml-backdoor/users/${member.granted_by}`}
                                className="text-xs font-mono hover:underline"
                              >
                                {granter?.name ||
                                  granter?.email ||
                                  member.granted_by.slice(0, 8) + '...'}
                              </Link>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatTimestamp(member.granted_at)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Integrations</CardTitle>
                <CardDescription>
                  {integrations.length} {integrations.length === 1 ? 'integration' : 'integrations'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {integrations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No integrations</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {integrations.map((integration) => (
                        <TableRow key={integration.id}>
                          <TableCell className="font-medium">{integration.name}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {integration.integration_type}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {integration.category}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(integration.created_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Threads</CardTitle>
                <CardDescription>
                  {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {threads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No threads</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Title</TableHead>
                        <TableHead>Created By</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {threads.map((thread) => (
                        <TableRow key={thread.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/threads/${thread.id}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">{thread.title}</div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {thread.id.slice(0, 8)}...
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/users/${thread.created_by}`}
                              className="text-xs font-mono hover:underline"
                            >
                              {thread.created_by.slice(0, 8)}...
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(thread.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <WorkspaceDangerZone
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              archived={workspace.archived}
            />
          </div>
        </div>
      </div>
    </>
  );
}
