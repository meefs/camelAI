import { notFound } from 'next/navigation';
import * as authDO from '@/lib/auth-do';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { UserEditForm } from '@/components/admin/user-edit-form';
import { Badge } from '@/components/ui/badge';
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

export default async function AdminUserDetailPage({ params }: Props) {
  const { id } = await params;

  // Fetch user and orgs in parallel
  const [user, orgs] = await Promise.all([
    authDO.getUserById(id),
    authDO.getUserOrgs(id),
  ]);

  if (!user) {
    notFound();
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
  };

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
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit User</CardTitle>
                <CardDescription>Update user name and permissions</CardDescription>
              </CardHeader>
              <CardContent>
                <UserEditForm user={safeUser} />
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
                  <ul className="divide-y divide-border">
                    {orgs.map((org) => (
                      <li key={org.org_id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium">{org.org_name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {org.org_id.slice(0, 8)}...
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{org.role}</Badge>
                            <span className="text-xs text-muted-foreground">
                              Joined {formatTimestamp(org.joined_at)}
                            </span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
