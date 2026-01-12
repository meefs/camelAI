# Admin Panel: Apps Tab Implementation Plan

This document outlines the implementation plan for adding the Apps (WorkerScript) tab to the QAML Backdoor admin panel. The implementation follows the existing patterns established by Users, Organizations, Workspaces, Threads, and Invitations.

## Overview

Apps (internally called `WorkerScript`) are deployed Cloudflare Workers that users have published from their workspaces. Each app belongs to a workspace, which belongs to an organization.

### WorkerScript Schema
```typescript
interface WorkerScript {
  script_name: string;    // Primary key - unique worker name
  workspace_id: string;   // Belongs to a workspace
  created_by: string;     // User ID or 'system:deploy'
  created_at: number;     // Timestamp
  updated_at: number;     // Timestamp
  is_public: boolean;     // Visibility flag
}
```

---

## Implementation Tasks

### 1. Add Navigation Item to Sidebar

**File:** `src/components/admin/admin-sidebar.tsx`

Add Apps to the `modelRoutes` array:

```typescript
import { Rocket } from 'lucide-react'; // or AppWindow, Globe, etc.

const modelRoutes = [
  // ... existing routes ...
  {
    label: 'Apps',
    href: '/qaml-backdoor/apps',
    icon: Rocket,
  },
];
```

**Position:** Add after Threads, before Invitations (or at the end of models).

---

### 2. Add App Count to Dashboard

**File:** `src/app/(admin)/qaml-backdoor/page.tsx`

Fetch app count and pass to dashboard component:

```typescript
const appCount = await authDO.adminGetAppCount();
```

**File:** `src/components/admin/admin-dashboard.tsx`

Add Apps metric card to the first grid row:

```typescript
<Link href="/qaml-backdoor/apps">
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
```

---

### 3. Backend: Add Paginated Admin RPC Methods

#### 3.1 Add Type Definitions

**File:** `src/types.ts`

Add admin app summary type:

```typescript
export interface AdminAppSummary {
  script_name: string;
  workspace_id: string;
  workspace_name: string;
  org_id: string;
  org_name: string;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: number;
  updated_at: number;
  is_public: boolean;
}

export interface AdminAppDetail extends AdminAppSummary {
  // Additional fields for detail view if needed
}
```

#### 3.2 Add OrgDO Methods

**File:** `workers/main/src/auth.ts`

Add method to list apps with pagination in OrgDO:

```typescript
async listWorkerScriptsPaginated(
  offset: number,
  limit: number,
  search?: string
): Promise<{ items: WorkerScript[]; total: number }> {
  // Implement with SQL LIKE search on script_name
  // Return paginated results
}
```

#### 3.3 Add RPC Service Methods

**File:** `workers/main/src/rpc-service.ts`

Add admin methods:

```typescript
async adminGetAppsPaginated(params: PaginationParams): Promise<PaginatedResult<AdminAppSummary>> {
  // 1. Get all org IDs
  // 2. For each org, get paginated apps
  // 3. Join with workspace/org names
  // 4. Join with user info for created_by
  // 5. Sort by updated_at DESC
  // 6. Apply offset/limit across all results
}

async adminGetAppDetail(scriptName: string): Promise<AdminAppDetail | null> {
  // 1. Look up script in KV index to get orgId
  // 2. Get full script details from OrgDO
  // 3. Join with workspace/org/user info
}

async adminGetAppCount(): Promise<number> {
  // Sum of all apps across all orgs
}
```

#### 3.4 Add Frontend RPC Wrappers

**File:** `src/lib/auth-do.ts`

Add wrapper functions:

```typescript
export async function adminGetAppsPaginated(
  params: PaginationParams
): Promise<PaginatedResult<AdminAppSummary>> {
  return withRpc((rpc) => rpc.adminGetAppsPaginated(params));
}

export async function adminGetAppDetail(scriptName: string): Promise<AdminAppDetail | null> {
  return withRpc((rpc) => rpc.adminGetAppDetail(scriptName));
}

export async function adminGetAppCount(): Promise<number> {
  return withRpc((rpc) => rpc.adminGetAppCount());
}
```

---

### 4. Apps List Page

**File:** `src/app/(admin)/qaml-backdoor/apps/page.tsx`

Create the apps list page following the threads list pattern:

```typescript
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { requireSuperuser } from '@/lib/server-guards';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { AdminSearch } from '@/components/admin/admin-search';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const LIMIT = 50;

// ... date formatter ...

interface Props {
  searchParams: Promise<{ offset?: string; search?: string }>;
}

export default async function AdminAppsPage({ searchParams }: Props) {
  await requireSuperuser();

  const params = await searchParams;
  const offset = parseInt(params.offset || '0', 10);
  const search = typeof params.search === 'string' ? params.search.trim() : '';

  const { items: apps, total } = await authDO.adminGetAppsPaginated({
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/apps?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/apps';

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Apps' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Apps</h1>
              <p className="text-sm text-muted-foreground">
                {total} deployed {total === 1 ? 'app' : 'apps'}
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search apps" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No apps found
                    </TableCell>
                  </TableRow>
                ) : (
                  apps.map((app) => (
                    <TableRow key={app.script_name}>
                      <TableCell>
                        <Link
                          href={`/qaml-backdoor/apps/${encodeURIComponent(app.script_name)}`}
                          className="block hover:underline"
                        >
                          <div className="font-medium text-foreground font-mono">
                            {app.script_name}
                          </div>
                          <a
                            href={`https://${app.script_name}.chiridion.ai`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {app.script_name}.chiridion.ai
                          </a>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/qaml-backdoor/orgs/${app.org_id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{app.org_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {app.org_id.slice(0, 8)}...
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{app.workspace_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {app.workspace_id.slice(0, 8)}...
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={app.is_public ? 'default' : 'secondary'}>
                          {app.is_public ? 'Public' : 'Private'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(app.updated_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <AdminPagination
            total={total}
            offset={offset}
            limit={LIMIT}
            baseUrl={baseUrl}
          />
        </div>
      </div>
    </>
  );
}
```

---

### 5. App Detail Page

**File:** `src/app/(admin)/qaml-backdoor/apps/[scriptName]/page.tsx`

Create the app detail page:

```typescript
import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as authDO from '@/lib/auth-do';
import { requireSuperuser } from '@/lib/server-guards';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AppEditForm } from '@/components/admin/app-edit-form';
import { AppDangerZone } from '@/components/admin/app-danger-zone';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ExternalLink } from 'lucide-react';

// ... date formatter ...

interface Props {
  params: Promise<{ scriptName: string }>;
}

export default async function AdminAppDetailPage({ params }: Props) {
  await requireSuperuser();

  const { scriptName } = await params;
  const decodedScriptName = decodeURIComponent(scriptName);

  const app = await authDO.adminGetAppDetail(decodedScriptName);
  if (!app) {
    notFound();
  }

  // Create plain object for Client Component
  const safeApp = {
    script_name: app.script_name,
    workspace_id: app.workspace_id,
    workspace_name: app.workspace_name,
    org_id: app.org_id,
    org_name: app.org_name,
    created_by: app.created_by,
    created_by_name: app.created_by_name,
    created_by_email: app.created_by_email,
    created_at: app.created_at,
    updated_at: app.updated_at,
    is_public: app.is_public,
  };

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Apps', href: '/qaml-backdoor/apps' },
          { label: app.script_name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            {/* App Details Card */}
            <Card>
              <CardHeader>
                <CardTitle>App Details</CardTitle>
                <CardDescription>View and manage deployed app</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Script Name</dt>
                    <dd className="font-mono text-sm">{app.script_name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Live URL</dt>
                    <dd>
                      <a
                        href={`https://${app.script_name}.chiridion.ai`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {app.script_name}.chiridion.ai
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/orgs/${app.org_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {app.org_name} ({app.org_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Workspace</dt>
                    <dd>
                      <Link
                        href={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {app.workspace_name} ({app.workspace_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created By</dt>
                    <dd className="text-sm">
                      {app.created_by.startsWith('system:') ? (
                        <span className="font-mono text-muted-foreground">{app.created_by}</span>
                      ) : (
                        <Link
                          href={`/qaml-backdoor/users/${app.created_by}`}
                          className="hover:underline"
                        >
                          {app.created_by_name || app.created_by_email || app.created_by.slice(0, 8)}...
                        </Link>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={app.is_public ? 'default' : 'secondary'}>
                        {app.is_public ? 'Public' : 'Private'}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(app.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Updated</dt>
                    <dd className="text-sm">{formatTimestamp(app.updated_at)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {/* Edit App Card */}
            <Card>
              <CardHeader>
                <CardTitle>Edit App</CardTitle>
                <CardDescription>Update app visibility</CardDescription>
              </CardHeader>
              <CardContent>
                <AppEditForm app={safeApp} />
              </CardContent>
            </Card>

            {/* Danger Zone */}
            <AppDangerZone app={safeApp} />
          </div>
        </div>
      </div>
    </>
  );
}
```

---

### 6. App Edit Form Component

**File:** `src/components/admin/app-edit-form.tsx`

```typescript
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { updateAdminApp } from "@/lib/server-actions/admin"

interface AppEditFormProps {
  app: {
    script_name: string
    org_id: string
    is_public: boolean
  }
}

export function AppEditForm({ app }: AppEditFormProps) {
  const router = useRouter()
  const [isPublic, setIsPublic] = useState(app.is_public)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      await updateAdminApp(app.org_id, app.script_name, { is_public: isPublic })
      setSuccess(true)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>App updated successfully</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="is-public">Public Access</Label>
          <p className="text-sm text-muted-foreground">
            When enabled, anyone can access this app without authentication
          </p>
        </div>
        <Switch
          id="is-public"
          checked={isPublic}
          onCheckedChange={setIsPublic}
        />
      </div>

      <Button type="submit" disabled={loading || isPublic === app.is_public}>
        {loading ? "Saving..." : "Save Changes"}
      </Button>
    </form>
  )
}
```

---

### 7. App Danger Zone Component

**File:** `src/components/admin/app-danger-zone.tsx`

```typescript
"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { deleteAdminApp } from "@/lib/server-actions/admin"
import { toast } from "sonner"

interface AppDangerZoneProps {
  app: {
    script_name: string
    org_id: string
  }
}

export function AppDangerZone({ app }: AppDangerZoneProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const handleDelete = () => {
    startTransition(async () => {
      try {
        await deleteAdminApp(app.org_id, app.script_name)
        toast.success("App deleted successfully")
        router.push("/qaml-backdoor/apps")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete app")
        setOpen(false)
      }
    })
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Danger Zone</CardTitle>
        <CardDescription>Irreversible actions</CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 className="mr-2 h-4 w-4" />
              Delete App
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete App</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete <strong>{app.script_name}</strong>?
                This will remove the app record from the database. The actual worker
                script may need to be deleted separately from Cloudflare.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isPending ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}
```

---

### 8. Admin Server Actions

**File:** `src/lib/server-actions/admin.ts`

Add app-related admin actions:

```typescript
export async function updateAdminApp(
  orgId: string,
  scriptName: string,
  data: { is_public: boolean }
): Promise<void> {
  const sessionData = await getAuthState();
  if (!sessionData?.user?.is_superuser) {
    throw new Error('Unauthorized');
  }

  const result = await authDO.adminSetAppPublic(orgId, scriptName, data.is_public, sessionData.user.id);
  if (!result) {
    throw new Error('App not found');
  }
}

export async function deleteAdminApp(orgId: string, scriptName: string): Promise<void> {
  const sessionData = await getAuthState();
  if (!sessionData?.user?.is_superuser) {
    throw new Error('Unauthorized');
  }

  const result = await authDO.adminDeleteApp(orgId, scriptName, sessionData.user.id);
  if (!result) {
    throw new Error('App not found');
  }
}
```

Add corresponding wrapper functions in `src/lib/auth-do.ts`:

```typescript
export async function adminSetAppPublic(
  orgId: string,
  scriptName: string,
  isPublic: boolean,
  actorId: string
): Promise<WorkerScript | null> {
  return withRpc((rpc) => rpc.setWorkerScriptPublic(orgId, scriptName, isPublic, actorId));
}

export async function adminDeleteApp(
  orgId: string,
  scriptName: string,
  actorId: string
): Promise<boolean> {
  return withRpc((rpc) => rpc.deleteWorkerScript(orgId, scriptName, actorId));
}
```

---

### 9. Update AdminOverview Type (Optional)

**File:** `src/types.ts`

If you want to show app count on the dashboard, add to `AdminOverview`:

```typescript
export interface AdminOverview {
  // ... existing fields ...
  total_apps: number;
}
```

And update the `getAdminOverview()` RPC method to include app count.

---

## File Summary

### New Files to Create

| File | Purpose |
|------|---------|
| `src/app/(admin)/qaml-backdoor/apps/page.tsx` | Apps list page |
| `src/app/(admin)/qaml-backdoor/apps/[scriptName]/page.tsx` | App detail page |
| `src/components/admin/app-edit-form.tsx` | Edit form component |
| `src/components/admin/app-danger-zone.tsx` | Delete confirmation |

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/admin/admin-sidebar.tsx` | Add Apps nav item |
| `src/components/admin/admin-dashboard.tsx` | Add Apps metric card |
| `src/app/(admin)/qaml-backdoor/page.tsx` | Fetch app count |
| `src/types.ts` | Add `AdminAppSummary`, `AdminAppDetail` types |
| `src/lib/auth-do.ts` | Add admin app wrapper functions |
| `src/lib/server-actions/admin.ts` | Add app update/delete actions |
| `workers/main/src/rpc-service.ts` | Add paginated admin methods |
| `workers/main/src/auth.ts` | Add OrgDO pagination method (optional) |

---

## Implementation Order

1. **Types first** - Add `AdminAppSummary` and `AdminAppDetail` to `src/types.ts`
2. **RPC layer** - Add admin methods to `rpc-service.ts`
3. **Frontend wrappers** - Add functions to `auth-do.ts`
4. **List page** - Create `apps/page.tsx`
5. **Detail page** - Create `apps/[scriptName]/page.tsx`
6. **Components** - Create `app-edit-form.tsx` and `app-danger-zone.tsx`
7. **Server actions** - Add to `admin.ts`
8. **Navigation** - Add to sidebar
9. **Dashboard** - Add metric card

---

## UI/UX Considerations

### List View Columns
- **App** - Script name (monospace) + live URL link
- **Organization** - Linked to org detail
- **Workspace** - Linked to workspace detail
- **Status** - Public/Private badge
- **Updated** - Timestamp

### Detail View Sections
1. **App Details Card** - Read-only metadata
2. **Edit App Card** - Toggle public/private
3. **Danger Zone Card** - Delete app

### Badges
- **Public** - Default variant (primary color)
- **Private** - Secondary variant (muted)

### Special Handling
- Script names can contain special characters; use `encodeURIComponent`/`decodeURIComponent` for URL routing
- `created_by` may be `system:deploy` instead of a user ID - display differently
- Live URL should open in new tab with `target="_blank"`

---

## Testing Checklist

- [ ] Apps appear in sidebar navigation
- [ ] Apps count shows on dashboard
- [ ] Apps list loads with pagination
- [ ] Search filters apps by script name
- [ ] Clicking app row navigates to detail
- [ ] Detail page shows all metadata
- [ ] Public/Private toggle works
- [ ] Delete confirmation dialog works
- [ ] Delete redirects to list
- [ ] Links to org/workspace/user work correctly
- [ ] Live URL opens in new tab
