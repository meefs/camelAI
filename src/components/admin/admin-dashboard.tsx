'use client';

import { Form, Link, useActionData, useNavigation } from 'react-router';
import { useMemo, useState, useEffect } from 'react';
import { Building2, FolderKanban, Mail, MessageSquare, Plug, Rocket, UserX, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminOverview } from '@/types';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getContrastTextColor } from '@/lib/avatar';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

interface AdminDashboardProps {
  overview: AdminOverview;
  threadCount?: number;
  appCount?: number;
}

type EmailDeliveryStatus = 'sent' | 'skipped' | 'failed';

interface EmailDeliveryResult {
  status: EmailDeliveryStatus;
  reason?: string;
}

interface ActionData {
  intent?: string;
  emailResult?: EmailDeliveryResult;
}

export function AdminDashboard({ overview, threadCount = 0, appCount = 0 }: AdminDashboardProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const isSendingEmail = navigation.state === 'submitting' && navigation.formData?.get('intent') === 'testEmail';

  useEffect(() => {
    if (actionData?.intent === 'testEmail' && actionData.emailResult) {
      const result = actionData.emailResult;
      if (result.status === 'sent') {
        toast.success('Test email sent successfully');
      } else if (result.status === 'skipped') {
        toast.warning(`Email skipped: ${result.reason}`);
      } else {
        toast.error(`Email failed: ${result.reason}`);
      }
    }
  }, [actionData]);

  const filteredUsers = useMemo(() => {
    if (!normalizedQuery) return overview.users.slice(0, 10);
    return overview.users.filter((user) => {
      const haystack = `${user.name ?? ''} ${user.email} ${user.id}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, overview.users]);

  const superuserCount = useMemo(
    () => overview.users.filter((user) => user.is_superuser).length,
    [overview.users]
  );
  const orphanedCount = overview.orphaned_users ?? overview.users.filter((user) => user.is_orphaned).length;

  return (
    <>
      <AdminPageHeader breadcrumbs={[{ label: 'Admin Panel' }]} />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="mb-6 flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">QAML Backdoor</h1>
              <p className="text-sm text-muted-foreground">
                Superuser-only admin surface for camelAI.
              </p>
            </div>
            <div className="flex gap-2">
              <Form method="post">
                <input type="hidden" name="intent" value="testEmail" />
                <Button type="submit" variant="outline" size="sm" disabled={isSendingEmail}>
                  <Mail className="h-4 w-4 mr-1.5" />
                  {isSendingEmail ? 'Sending...' : 'Test Email'}
                </Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="restartOwnOnboarding" />
                <Button type="submit" variant="outline" size="sm">
                  Test Onboarding
                </Button>
              </Form>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Link to="/qaml-backdoor/users">
              <Card size="sm" className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Users</CardTitle>
                    <Users className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardDescription>Registered accounts</CardDescription>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{overview.total_users}</CardContent>
              </Card>
            </Link>
            <Link to="/qaml-backdoor/orgs">
              <Card size="sm" className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Organizations</CardTitle>
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardDescription>Teams and workspaces</CardDescription>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{overview.total_orgs}</CardContent>
              </Card>
            </Link>
            <Link to="/qaml-backdoor/workspaces">
              <Card size="sm" className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Workspaces</CardTitle>
                    <FolderKanban className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardDescription>Total workspaces</CardDescription>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{overview.total_workspaces}</CardContent>
              </Card>
            </Link>
            <Link to="/qaml-backdoor/threads">
              <Card size="sm" className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Threads</CardTitle>
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardDescription>Chat conversations</CardDescription>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{threadCount}</CardContent>
              </Card>
            </Link>
            <Link to="/qaml-backdoor/apps">
              <Card size="sm" className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Apps</CardTitle>
                    <Rocket className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardDescription>Deployed workers</CardDescription>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{appCount}</CardContent>
              </Card>
            </Link>
          </div>

          <div className="grid gap-3 mt-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Memberships</CardTitle>
                <CardDescription>User to org links</CardDescription>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{overview.total_memberships}</CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Superusers</CardTitle>
                <CardDescription>Admin access holders</CardDescription>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{superuserCount}</CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Orphaned Users</CardTitle>
                  <UserX className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Users without orgs</CardDescription>
              </CardHeader>
              <CardContent
                className={`text-2xl font-semibold ${orphanedCount > 0 ? 'text-destructive' : ''}`}
              >
                {orphanedCount}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Integrations</CardTitle>
                  <Plug className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Workspace integrations</CardDescription>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{overview.total_integrations}</CardContent>
            </Card>
          </div>

          <div className="mt-6 border border-border rounded-lg overflow-hidden bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Recent Users</span>
                <Link
                  to="/qaml-backdoor/users"
                  className="text-xs text-muted-foreground hover:underline"
                >
                  View all
                </Link>
              </div>
              <div className="w-48">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search users"
                  aria-label="Search users"
                  className="h-8 text-sm"
                />
              </div>
            </div>
            {filteredUsers.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted-foreground">No users match this search.</div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">User</th>
                      <th className="px-4 py-2 text-left font-medium">Orgs</th>
                      <th className="px-4 py-2 text-left font-medium">Created</th>
                      <th className="px-4 py-2 text-left font-medium">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <Link
                            to={`/qaml-backdoor/users/${user.id}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <Avatar size="default">
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
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-foreground">
                                  {user.name || user.email}
                                </span>
                                {user.is_orphaned ? (
                                  <Badge variant="destructive">Orphaned</Badge>
                                ) : null}
                              </div>
                              {user.name ? (
                                <span className="text-xs text-muted-foreground">{user.email}</span>
                              ) : null}
                              <span className="text-xs text-muted-foreground font-mono">
                                {user.id.slice(0, 8)}...
                              </span>
                            </div>
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">
                            {user.org_count} {user.org_count === 1 ? 'org' : 'orgs'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatTimestamp(user.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          {user.is_superuser ? (
                            <Badge>Superuser</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Standard</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
