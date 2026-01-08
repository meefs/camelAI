import { Building2, FolderKanban, MessageSquare, Plug, UserX, Users } from 'lucide-react';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminLoading() {
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
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Users</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Registered accounts</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Organizations</CardTitle>
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Teams and workspaces</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Workspaces</CardTitle>
                  <FolderKanban className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Total workspaces</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Threads</CardTitle>
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Chat conversations</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-3 mt-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Memberships</CardTitle>
                <CardDescription>User to org links</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Superusers</CardTitle>
                <CardDescription>Admin access holders</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Orphaned Users</CardTitle>
                  <UserX className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardDescription>Users without orgs</CardDescription>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
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
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
          </div>

          <div className="mt-6 border border-border rounded-lg overflow-hidden bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Recent Users</span>
              </div>
              <Skeleton className="h-8 w-48" />
            </div>
            <div className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-48" />
                  <Skeleton className="h-6 w-16" />
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
