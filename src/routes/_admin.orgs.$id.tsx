import { Link, useLoaderData, redirect, useFetcher } from 'react-router';
import type { Route } from './+types/_admin.orgs.$id';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as adminDO from '@/lib/auth-do.server';
import { adminTransferOrgOwnership, updateOrgMemberRole, getOrg, getOrgMembers, getOrgInvitations } from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AddOrgMemberDialog } from '@/components/admin/add-org-member-dialog';
import { OrgDangerZone } from '@/components/admin/org-danger-zone';
import { OrgMemberRoleSelect } from '@/components/admin/org-member-role-select';
import { OrgEditForm } from '@/components/admin/org-edit-form';
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
    { title: data?.org ? `${data.org.name} - Admin - Chiridion` : 'Organization - Admin - Chiridion' },
    { name: 'description', content: 'View organization details' },
  ];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;
  const authEnv = getAuthEnv(getEnv(context));

  // Fetch org first to check existence, then fetch related data in parallel
  const org = await getOrg(authEnv, id);
  if (!org) {
    throw redirect('/qaml-backdoor/orgs');
  }

  const [members, invitations, workspacePage] = await Promise.all([
    getOrgMembers(authEnv, id),
    getOrgInvitations(authEnv, id),
    adminDO.adminGetWorkspacesPaginated(context, { offset: 0, limit: 500 }),
  ]);
  const workspaces = workspacePage.items.filter((workspace) => workspace.org_id === id);

  // Create plain object for Client Component
  const safeOrg = {
    id: org.id,
    name: org.name,
    created_by: org.created_by,
    created_at: org.created_at,
    billing_status: org.billing_status,
    archived: org.archived,
    archived_at: org.archived_at,
    archived_by: org.archived_by ?? null,
  };

  const memberOptions = members.map((member) => ({
    id: member.user.id,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
  }));

  return {
    org: safeOrg,
    members,
    invitations,
    workspaces,
    memberOptions,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get('intent');
  const { id: orgId } = params;
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === 'reset-containers') {
    await adminDO.resetAdminOrgContainers(context, orgId);
    return { success: true };
  }

  if (intent === 'addMember') {
    const userId = formData.get('userId') as string;
    const role = formData.get('role') as 'admin' | 'member';
    if (!userId || !role) {
      return { error: 'User ID and role are required' };
    }
    await adminDO.addAdminOrgMember(context, orgId, userId, role);
    return { success: true };
  }

  if (intent === 'updateMemberRole') {
    const userId = formData.get('userId') as string;
    const role = formData.get('role') as 'admin' | 'member' | 'viewer' | 'owner';
    if (!userId || !role) {
      return { error: 'User ID and role are required' };
    }
    await updateOrgMemberRole(authEnv, orgId, userId, role, 'system-admin');
    return { success: true };
  }

  if (intent === 'transferOwnership') {
    const newOwnerId = formData.get('newOwnerId') as string;
    if (!newOwnerId) {
      return { error: 'New owner ID is required' };
    }
    await adminTransferOrgOwnership(authEnv, orgId, newOwnerId, 'system-admin');
    return { success: true };
  }

  if (intent === 'archiveOrg') {
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.archiveOrg('system-admin');
    return { success: true };
  }

  if (intent === 'updateOrg') {
    const name = formData.get('name') as string;
    if (!name?.trim()) {
      return { error: 'Organization name is required' };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.updateName(name.trim(), 'system-admin');
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export default function AdminOrgDetailPage() {
  const { org, members, invitations, workspaces, memberOptions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Organizations', href: '/qaml-backdoor/orgs' },
          { label: org.name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Organization Details</CardTitle>
                <CardDescription>View and edit organization information</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">ID</dt>
                    <dd className="font-mono text-sm">{org.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Name</dt>
                    <dd className="text-sm">{org.name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Billing</dt>
                    <dd>
                      <Badge variant={org.billing_status === 'paying' ? 'default' : 'outline'}>
                        {org.billing_status === 'paying' ? 'Paying' : 'Free'}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={org.archived ? 'secondary' : 'outline'}>
                        {org.archived ? 'Archived' : 'Active'}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(org.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created By</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/users/${org.created_by}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {org.created_by.slice(0, 8)}...
                      </Link>
                    </dd>
                  </div>
                  {org.archived && org.archived_at ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Archived At</dt>
                      <dd className="text-sm">{formatTimestamp(org.archived_at)}</dd>
                    </div>
                  ) : null}
                  {org.archived && org.archived_by ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Archived By</dt>
                      <dd>
                        <Link
                          to={`/qaml-backdoor/users/${org.archived_by}`}
                          className="text-sm font-mono hover:underline"
                        >
                          {org.archived_by.slice(0, 8)}...
                        </Link>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit Organization</CardTitle>
                <CardDescription>Update organization settings</CardDescription>
              </CardHeader>
              <CardContent>
                <OrgEditForm org={org} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Workspace Containers</CardTitle>
                <CardDescription>
                  Restart all workspace containers to pick up new secrets or code.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'} attached
                </p>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="reset-containers" />
                  <Button variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
                    {fetcher.state !== 'idle' ? 'Resetting...' : 'Reset Workspace Containers'}
                  </Button>
                </fetcher.Form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Workspaces</CardTitle>
                <CardDescription>
                  {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {workspaces.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No workspaces</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Threads</TableHead>
                        <TableHead>Integrations</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaces.map((workspace) => (
                        <TableRow key={workspace.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${workspace.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar size="default">
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
                              <div>
                                <div className="font-medium">{workspace.name}</div>
                                <div className="text-xs text-muted-foreground font-mono">
                                  {workspace.id.slice(0, 8)}...
                                </div>
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{workspace.thread_count}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{workspace.integration_count}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={workspace.archived ? 'secondary' : 'outline'}>
                              {workspace.archived ? 'Archived' : 'Active'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Members</CardTitle>
                  <CardDescription>
                    {members.length} {members.length === 1 ? 'member' : 'members'}
                  </CardDescription>
                </div>
                <AddOrgMemberDialog orgId={org.id} />
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Member</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((member) => (
                        <TableRow key={member.user.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/users/${member.user.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar size="default">
                                <AvatarFallback
                                  content={member.user.avatar.content}
                                  style={{
                                    backgroundColor: member.user.avatar.color,
                                    color: getContrastTextColor(member.user.avatar.color),
                                  }}
                                >
                                  {member.user.avatar.content}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="font-medium">
                                  {member.user.name || member.user.email}
                                </div>
                                {member.user.name ? (
                                  <div className="text-xs text-muted-foreground">
                                    {member.user.email}
                                  </div>
                                ) : null}
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={cn(roleBadgeClasses[member.role] || '')}
                            >
                              {member.role}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(member.joined_at)}
                          </TableCell>
                          <TableCell>
                            <OrgMemberRoleSelect
                              orgId={org.id}
                              userId={member.user.id}
                              currentRole={member.role}
                              disabled={member.role === 'owner'}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {invitations.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Pending Invitations</CardTitle>
                  <CardDescription>
                    {invitations.length} pending {invitations.length === 1 ? 'invitation' : 'invitations'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Expires</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invitations.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell>
                            <div className="font-medium">{inv.email}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {inv.id.slice(0, 8)}...
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{inv.role}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(inv.expires_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Audit Log</CardTitle>
                <CardDescription>Track recent organization changes</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <Link to={`/qaml-backdoor/orgs/${org.id}/audit-log`}>
                    View Audit Log
                  </Link>
                </Button>
              </CardContent>
            </Card>

            <OrgDangerZone
              orgId={org.id}
              orgName={org.name}
              archived={org.archived}
              members={memberOptions}
            />
          </div>
        </div>
      </div>
    </>
  );
}
