'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Building2, FolderKanban, MessageSquare, Users } from 'lucide-react';
import type { AdminOverview } from '@/types';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

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
  projectCount?: number;
}

export function AdminDashboard({ overview, threadCount = 0, projectCount = 0 }: AdminDashboardProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

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

  return (
    <>
      <AdminPageHeader breadcrumbs={[{ label: 'Admin Panel' }]} />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="mb-6">
            <h1 className="text-lg font-semibold tracking-tight">QAML Backdoor</h1>
            <p className="text-sm text-muted-foreground">
              Superuser-only admin surface for Chiridion.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Link href="/qaml-backdoor/users">
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
            <Link href="/qaml-backdoor/orgs">
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
            <Link href="/qaml-backdoor/projects">
              <Card size="sm" className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Projects</CardTitle>
                    <FolderKanban className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardDescription>Code repositories</CardDescription>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{projectCount}</CardContent>
              </Card>
            </Link>
            <Link href="/qaml-backdoor/threads">
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
          </div>

          <div className="grid gap-3 mt-3 sm:grid-cols-2">
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
          </div>

          <div className="mt-6 border border-border rounded-lg overflow-hidden bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Recent Users</span>
                <Link
                  href="/qaml-backdoor/users"
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
                            href={`/qaml-backdoor/users/${user.id}`}
                            className="flex flex-col hover:underline"
                          >
                            <span className="font-medium text-foreground">
                              {user.name || user.email}
                            </span>
                            {user.name ? (
                              <span className="text-xs text-muted-foreground">{user.email}</span>
                            ) : null}
                            <span className="text-xs text-muted-foreground font-mono">
                              {user.id.slice(0, 8)}...
                            </span>
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
