'use client';

import { useMemo, useState } from 'react';
import type { AdminOverview } from '@/types';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SidebarTrigger } from '@/components/ui/sidebar';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

export function AdminDashboard({ overview }: { overview: AdminOverview }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

  const filteredUsers = useMemo(() => {
    if (!normalizedQuery) return overview.users;
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
      <header className="sticky top-0 z-30 shrink-0 bg-background">
        <div className="flex h-12 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <div
            data-orientation="vertical"
            role="none"
            className="bg-border shrink-0 w-px h-4 mr-2"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Admin Panel</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="max-w-6xl mx-auto w-full flex-1 min-h-0 flex flex-col px-4 md:px-6 pb-8">
          <div className="flex flex-wrap items-center justify-between gap-4 pt-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">QAML Backdoor</h1>
              <p className="text-sm text-muted-foreground">
                Superuser-only admin surface for Chiridion.
              </p>
            </div>
            <div className="w-full sm:w-64">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search users"
                aria-label="Search users"
              />
            </div>
          </div>

          <div className="grid gap-3 mt-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Total Users</CardTitle>
                <CardDescription>Accounts in the system</CardDescription>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{overview.total_users}</CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Total Orgs</CardTitle>
                <CardDescription>Unique organizations</CardDescription>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{overview.total_orgs}</CardContent>
            </Card>
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
                <CardDescription>Hardcoded bootstrap access</CardDescription>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{superuserCount}</CardContent>
            </Card>
          </div>

          <div className="mt-6 border border-border rounded-lg overflow-hidden bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <div className="text-sm font-medium">Users</div>
              <div className="text-xs text-muted-foreground">
                Showing {filteredUsers.length} of {overview.users.length}
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
                      <th className="px-4 py-2 text-left font-medium">Org Count</th>
                      <th className="px-4 py-2 text-left font-medium">Created</th>
                      <th className="px-4 py-2 text-left font-medium">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3">
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">
                              {user.name || user.email}
                            </span>
                            {user.name ? (
                              <span className="text-xs text-muted-foreground">{user.email}</span>
                            ) : null}
                            <span className="text-xs text-muted-foreground">ID: {user.id}</span>
                          </div>
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
