import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import * as computerDO from '@/lib/computer-do';
import { getSessionId } from '@/lib/auth';
import { requireSuperuser } from '@/lib/server-guards';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { OrgDangerZone } from '@/components/admin/org-danger-zone';
import { OrgMemberRoleSelect } from '@/components/admin/org-member-role-select';
import { OrgEditForm } from '@/components/admin/org-edit-form';
import { resetAdminOrgContainers } from '@/lib/server-actions/admin';
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

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminOrgDetailPage({ params }: Props) {
  await requireSuperuser();

  const { id } = await params;

  // Fetch org first to check existence, then fetch related data in parallel
  const org = await authDO.getOrg(id);
  if (!org) {
    notFound();
  }

  const [members, invitations, workspacePage] = await Promise.all([
    authDO.getOrgMembers(id),
    authDO.getOrgInvitations(id),
    authDO.adminGetWorkspacesPaginated({ offset: 0, limit: 500 }),
  ]);
  const workspaces = workspacePage.items.filter((workspace) => workspace.org_id === id);

  async function resetContainers() {
    'use server';
    await resetAdminOrgContainers(id);
  }

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
                        href={`/qaml-backdoor/users/${org.created_by}`}
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
                          href={`/qaml-backdoor/users/${org.archived_by}`}
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
                <OrgEditForm org={safeOrg} />
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
                <form action={resetContainers}>
                  <Button variant="outline" type="submit">
                    Reset Workspace Containers
                  </Button>
                </form>
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
                              href={`/qaml-backdoor/workspaces/${workspace.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar className="h-8 w-8">
                                <AvatarFallback
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
              <CardHeader>
                <CardTitle>Members</CardTitle>
                <CardDescription>
                  {members.length} {members.length === 1 ? 'member' : 'members'}
                </CardDescription>
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
                              href={`/qaml-backdoor/users/${member.user.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar className="h-8 w-8">
                                <AvatarFallback
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
                  <Link href={`/qaml-backdoor/orgs/${org.id}/audit-log`}>
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
