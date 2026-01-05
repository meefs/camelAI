import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import * as computerDO from '@/lib/computer-do';
import { getSessionId } from '@/lib/auth';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { OrgEditForm } from '@/components/admin/org-edit-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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

export default async function AdminOrgDetailPage({ params }: Props) {
  const { id } = await params;

  // Fetch org first to check existence, then fetch related data in parallel
  const org = await authDO.getOrg(id);
  if (!org) {
    notFound();
  }

  async function resetSandboxContainer() {
    'use server';

    const sessionId = await getSessionId();
    if (!sessionId) {
      redirect('/login');
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      redirect('/login');
    }

    const user = await authDO.getUserById(session.user_id);
    if (!user?.is_superuser) {
      throw new Error('Forbidden');
    }

    await computerDO.resetSandboxContainer(id);
  }

  const [members, invitations, integrations] = await Promise.all([
    authDO.getOrgMembers(id),
    authDO.getOrgInvitations(id),
    authDO.getOrgIntegrations(id),
  ]);

  // Create plain object for Client Component
  const safeOrg = {
    id: org.id,
    name: org.name,
    created_by: org.created_by,
    created_at: org.created_at,
  };

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
                <CardTitle>Sandbox Container</CardTitle>
                <CardDescription>
                  Terminate the org container to pick up new secrets or code.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={resetSandboxContainer}>
                  <Button variant="destructive" type="submit">
                    Reset Sandbox Container
                  </Button>
                </form>
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
                  <ul className="divide-y divide-border">
                    {members.map((member) => (
                      <li key={member.user.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between">
                          <Link
                            href={`/qaml-backdoor/users/${member.user.id}`}
                            className="hover:underline"
                          >
                            <div className="font-medium">
                              {member.user.name || member.user.email}
                            </div>
                            {member.user.name && (
                              <div className="text-xs text-muted-foreground">
                                {member.user.email}
                              </div>
                            )}
                          </Link>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{member.role}</Badge>
                            <span className="text-xs text-muted-foreground">
                              Joined {formatTimestamp(member.joined_at)}
                            </span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {invitations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Pending Invitations</CardTitle>
                  <CardDescription>
                    {invitations.length} pending {invitations.length === 1 ? 'invitation' : 'invitations'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y divide-border">
                    {invitations.map((inv) => (
                      <li key={inv.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium">{inv.email}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {inv.id.slice(0, 8)}...
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{inv.role}</Badge>
                            <span className="text-xs text-muted-foreground">
                              Expires {formatTimestamp(inv.expires_at)}
                            </span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {integrations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Integrations</CardTitle>
                  <CardDescription>
                    {integrations.length} {integrations.length === 1 ? 'integration' : 'integrations'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y divide-border">
                    {integrations.map((int) => (
                      <li key={int.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium">{int.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {int.integration_type} ({int.category})
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {int.enabled ? (
                              <Badge variant="default">Enabled</Badge>
                            ) : (
                              <Badge variant="outline">Disabled</Badge>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
