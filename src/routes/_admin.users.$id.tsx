import { Link, useLoaderData } from 'react-router';
import { redirect } from 'react-router';
import type { Route } from './+types/_admin.users.$id';
import { requireSuperuser } from '@/lib/auth.server';
import * as authDO from '@/lib/auth-do.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { UserAdminActions } from '@/components/admin/user-admin-actions';
import { UserEditForm } from '@/components/admin/user-edit-form';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

const roleBadgeClasses: Record<string, string> = {
  owner: 'border-amber-500/30 bg-amber-500/15 text-amber-700',
  admin: 'border-blue-500/30 bg-blue-500/15 text-blue-700',
  member: 'border-slate-500/30 bg-slate-500/10 text-slate-700',
  viewer: 'border-muted bg-muted text-muted-foreground',
};

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.user ? `${data.user.email} - Admin - Chiridion` : 'User - Admin - Chiridion' },
    { name: 'description', content: 'View user details' },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get('intent');
  const { id: userId } = params;

  if (intent === 'forceOrphan') {
    // TODO: Implement forceOrphanUser in auth-do.server.ts
    // This would remove the user from all organizations
    return { error: 'Force orphan not yet implemented' };
  }

  if (intent === 'updateUser') {
    const name = formData.get('name') as string;
    const isSuperuser = formData.get('isSuperuser') === 'true';
    const avatarColor = formData.get('avatarColor') as string;
    const avatarContent = formData.get('avatarContent') as string;
    // TODO: Implement adminUpdateUser in auth-do.server.ts
    return { error: 'Update user not yet implemented' };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;

  // Fetch user and orgs in parallel
  const [user, orgs] = await Promise.all([
    authDO.getUserById(context, id),
    authDO.getUserOrgs(context, id),
  ]);

  if (!user) {
    throw redirect('/qaml-backdoor/users');
  }

  // Create plain object for Client Component
  const safeUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
    avatar: {
      color: user.avatar_color,
      content: user.avatar_content,
    },
    is_orphaned: user.is_orphaned,
    orphaned_at: user.orphaned_at,
  };

  const workspaces = await authDO.listUserWorkspacesAcrossOrgs(context, id, orgs);
  const workspacesByOrg = new Map<string, typeof workspaces>();
  for (const workspace of workspaces) {
    const list = workspacesByOrg.get(workspace.org_id) ?? [];
    list.push(workspace);
    workspacesByOrg.set(workspace.org_id, list);
  }
  const orgNameById = new Map(orgs.map((org) => [org.org_id, org.org_name]));

  return {
    user: safeUser,
    orgs,
    workspaces,
    workspacesByOrg: Object.fromEntries(workspacesByOrg),
    orgNameById: Object.fromEntries(orgNameById),
  };
}

export default function AdminUserDetailPage() {
  const { user, orgs, workspaces, workspacesByOrg, orgNameById } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Users', href: '/qaml-backdoor/users' },
          { label: user.email },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>User Details</CardTitle>
                <CardDescription>View and edit user information</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">ID</dt>
                    <dd className="font-mono text-sm">{user.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Avatar</dt>
                    <dd className="mt-1">
                      <Avatar size="xl">
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
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Email</dt>
                    <dd className="text-sm">{user.email}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(user.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Role</dt>
                    <dd>
                      {user.is_superuser ? (
                        <Badge>Superuser</Badge>
                      ) : (
                        <Badge variant="outline">Standard</Badge>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Orphaned</dt>
                    <dd>
                      {user.is_orphaned ? (
                        <Badge variant="destructive">Yes</Badge>
                      ) : (
                        <Badge variant="outline">No</Badge>
                      )}
                    </dd>
                  </div>
                  {user.orphaned_at ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Orphaned At</dt>
                      <dd className="text-sm">{formatTimestamp(user.orphaned_at)}</dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit User</CardTitle>
                <CardDescription>Update user name, avatar, and permissions</CardDescription>
              </CardHeader>
              <CardContent>
                <UserEditForm user={user} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Organization Memberships</CardTitle>
                <CardDescription>
                  {orgs.length} {orgs.length === 1 ? 'organization' : 'organizations'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {orgs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No organizations</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organization</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Workspace Access</TableHead>
                        <TableHead>Joined</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orgs.map((org) => {
                        const orgWorkspaces = workspacesByOrg[org.org_id] ?? [];
                        return (
                          <TableRow key={org.org_id}>
                            <TableCell>
                              <Link
                                to={`/qaml-backdoor/orgs/${org.org_id}`}
                                className="hover:underline"
                              >
                                <div className="font-medium">{org.org_name}</div>
                                <div className="text-xs text-muted-foreground font-mono">
                                  {org.org_id.slice(0, 8)}...
                                </div>
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn(roleBadgeClasses[org.role] || '')}
                              >
                                {org.role}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {orgWorkspaces.length === 0 ? (
                                <span className="text-xs text-muted-foreground">None</span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {orgWorkspaces.map((workspace: { id: string; name: string; access_level: string }) => (
                                    <Badge
                                      key={workspace.id}
                                      variant="secondary"
                                      className={
                                        workspace.access_level === 'read_only'
                                          ? 'border border-dashed border-border text-muted-foreground'
                                          : ''
                                      }
                                    >
                                      {workspace.name}
                                      {workspace.access_level === 'read_only' ? ' (read)' : ''}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatTimestamp(org.joined_at)}
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
                <CardTitle>Workspace Access</CardTitle>
                <CardDescription>
                  {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {workspaces.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No workspace access</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Organization</TableHead>
                        <TableHead>Access Level</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaces.map((workspace) => (
                        <TableRow key={workspace.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${workspace.id}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">{workspace.name}</div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {workspace.id.slice(0, 8)}...
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/orgs/${workspace.org_id}`}
                              className="text-sm hover:underline"
                            >
                              {orgNameById[workspace.org_id] ?? workspace.org_id}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {workspace.access_level === 'read_only' ? 'Read only' : 'Full'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <UserAdminActions
              userId={user.id}
              userEmail={user.email}
              hasMemberships={orgs.length > 0}
              isOrphaned={user.is_orphaned}
            />
          </div>
        </div>
      </div>
    </>
  );
}
