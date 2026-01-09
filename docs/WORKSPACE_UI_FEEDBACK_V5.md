# Workspace UI Implementation Feedback - V5

## Summary

This feedback addresses three issues: workspace switcher layout, settings page refresh on workspace switch, and a critical bug when archiving workspaces.

---

## 1. Workspace Switcher Layout - Cramped Submenu

### Problem
The workspace switcher dropdown menu is cramped. The workspace name and org tag badge are on the same line, causing text truncation and a cluttered appearance.

### Current Layout (line 116-131 of `src/components/sidebar/workspace-switcher.tsx`)
```tsx
<div className="flex min-w-0 flex-1 items-center gap-2">
  <span className="truncate">{workspace.name}</span>
  {orgName ? (
    <Badge variant="outline" className="max-w-[140px] shrink-0 truncate text-[10px] text-muted-foreground">
      {orgName}
    </Badge>
  ) : null}
  {workspace.access_level === "read_only" ? (
    <Badge variant="secondary" className="shrink-0 text-[10px]">
      Read-only
    </Badge>
  ) : null}
</div>
```

### Required Layout
Move the org tag to a new line. Structure should be:
- Left: Avatar (already correct)
- Right: Two lines
  - Line 1: Workspace name
  - Line 2: Org tag badge (smaller, muted)

### Fix
```tsx
<DropdownMenuItem
  key={workspace.id}
  onClick={() => switchWorkspace(workspace.id)}
  className="gap-2 p-2"
>
  <Avatar className="h-6 w-6 shrink-0">
    <AvatarFallback
      style={{
        backgroundColor: workspace.avatar.color,
        color: getContrastTextColor(workspace.avatar.color),
      }}
    >
      {workspace.avatar.content}
    </AvatarFallback>
  </Avatar>
  <div className="flex min-w-0 flex-1 flex-col">
    <span className="truncate text-sm">{workspace.name}</span>
    <div className="flex items-center gap-1">
      {orgName ? (
        <span className="truncate text-xs text-muted-foreground">
          {orgName}
        </span>
      ) : null}
      {workspace.access_level === "read_only" ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          Read-only
        </Badge>
      ) : null}
    </div>
  </div>
  {workspace.id === currentWorkspace.id ? (
    <Check className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : null}
</DropdownMenuItem>
```

Key changes:
- `flex-col` on the content div to stack lines vertically
- Org name as plain text (not badge) with `text-xs text-muted-foreground`
- Read-only badge stays as badge but on the second line
- Added `shrink-0` to Avatar and Check icon to prevent squishing

### File to modify
- `src/components/sidebar/workspace-switcher.tsx`

---

## 2. Settings Pages Don't Refresh on Workspace Switch

### Problem
When a user switches workspaces using the sidebar workspace switcher while on a settings page, the settings content doesn't update to reflect the new workspace/org.

### How Other Pages Handle This
The connections page (`src/app/(app)/connections/connections-client.tsx`) demonstrates the pattern:

```tsx
const [activeOrgId, setActiveOrgId] = useState(orgId);

useEffect(() => {
  if (currentOrg?.id && currentOrg.id !== activeOrgId) {
    setActiveOrgId(currentOrg.id);
    refreshConnections(currentOrg.id);
  }
}, [currentOrg?.id, activeOrgId, refreshConnections]);
```

This pattern:
1. Tracks the "active" org/workspace ID in local state
2. Watches for changes in `currentOrg` or `currentWorkspace` from AuthContext
3. Refreshes data when a change is detected

### Required Changes

**Option A: Convert settings pages to client components with refresh logic**

For each settings page that depends on org/workspace context, add the refresh pattern:

```tsx
// Example for organization settings pages
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/contexts/AuthContext"

export function OrgSettingsContent({ initialOrgId, initialData }) {
  const router = useRouter()
  const { currentOrg } = useAuth()
  const [activeOrgId, setActiveOrgId] = useState(initialOrgId)

  useEffect(() => {
    if (currentOrg?.id && currentOrg.id !== activeOrgId) {
      setActiveOrgId(currentOrg.id)
      router.refresh() // Triggers server component re-render
    }
  }, [currentOrg?.id, activeOrgId, router])

  // ... rest of component
}
```

**Option B: Create a wrapper component for settings routes**

Create a single client component that wraps all settings pages and handles the refresh:

```tsx
// src/components/settings/settings-refresh-wrapper.tsx
"use client"

import { useEffect, useRef } from "react"
import { useRouter, usePathname } from "next/navigation"
import { useAuth } from "@/contexts/AuthContext"

export function SettingsRefreshWrapper({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { currentOrg, currentWorkspace } = useAuth()

  const prevOrgRef = useRef(currentOrg?.id)
  const prevWorkspaceRef = useRef(currentWorkspace?.id)

  useEffect(() => {
    const orgChanged = currentOrg?.id && currentOrg.id !== prevOrgRef.current
    const workspaceChanged = currentWorkspace?.id && currentWorkspace.id !== prevWorkspaceRef.current

    if (orgChanged || workspaceChanged) {
      prevOrgRef.current = currentOrg?.id
      prevWorkspaceRef.current = currentWorkspace?.id
      router.refresh()
    }
  }, [currentOrg?.id, currentWorkspace?.id, router])

  return <>{children}</>
}
```

Then update the settings layout:

```tsx
// src/app/(app)/settings/layout.tsx
import { SettingsRefreshWrapper } from "@/components/settings/settings-refresh-wrapper"

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  await requireSession()

  return (
    <div className="flex h-full flex-col md:flex-row overflow-hidden">
      <Suspense fallback={<SettingsNavSkeleton />}>
        <SettingsNav />
      </Suspense>
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <SettingsRefreshWrapper>
          <Suspense fallback={<SettingsContentSkeleton />}>
            {children}
          </Suspense>
        </SettingsRefreshWrapper>
      </main>
    </div>
  )
}
```

**Recommendation:** Option B is cleaner and applies to all settings pages automatically.

### Files to create/modify
- `src/components/settings/settings-refresh-wrapper.tsx` (new)
- `src/app/(app)/settings/layout.tsx`

---

## 3. CRITICAL: Archive Workspace Breaks App State

### Problem
When archiving a workspace (especially the current/default workspace):
1. User gets redirected to home screen
2. Workspace switcher disappears from sidebar
3. Attempting to chat shows "Workspace not found" error
4. The org becomes broken - switching to it fails

### Root Cause Analysis

**Issue A: WorkspaceSwitcher returns null when currentWorkspace is null**

In `src/components/sidebar/workspace-switcher.tsx` (line 53-55):
```tsx
if (!currentOrg || !currentWorkspace) {
  return null
}
```

If the session's `workspace_id` points to an archived workspace, `getAuthContextLite` (line 76-78) can't find it in the workspace list, so `currentWorkspace` becomes `null`, hiding the switcher entirely.

**Issue B: Session workspace_id not cleared when archiving**

The archive flow in `workspaces-list.tsx`:
```tsx
const handleArchive = async (workspaceId: string) => {
  const fallback = workspaceList.find((workspace) => workspace.id !== workspaceId)

  await archiveWorkspace(workspaceId)

  if (workspaceId === currentWorkspaceId) {
    if (fallback) {
      await switchWorkspace(fallback.id)  // This should update the session
    } else {
      await refreshAuth()  // This doesn't update session.workspace_id
    }
  }

  router.refresh()
}
```

The problem: `refreshAuth()` re-fetches auth state but the session in the backend still has `workspace_id` pointing to the archived workspace.

**Issue C: last_workspace_id on membership not updated**

When a user switches to an org, `switchOrg` uses `last_workspace_id`:
```tsx
const preferredWorkspaceId = membership?.last_workspace_id ?? null;
const nextWorkspace = workspaces.find((workspace) => workspace.id === preferredWorkspaceId) || workspaces[0] || null;
```

If `last_workspace_id` points to an archived workspace, `find` returns undefined, and `workspaces[0]` should be used. BUT if there are no workspaces (all archived), `nextWorkspace` is null.

### Required Fixes

**Fix A: Handle null currentWorkspace gracefully in WorkspaceSwitcher**

```tsx
// src/components/sidebar/workspace-switcher.tsx
if (!currentOrg) {
  return null
}

// If no workspace, show a "select workspace" state instead of hiding
if (!currentWorkspace) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" disabled>
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarFallback className="rounded-lg bg-muted">?</AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium text-muted-foreground">No workspace</span>
            <span className="truncate text-xs text-muted-foreground">
              {currentOrg.name}
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
```

**Fix B: Update archiveWorkspace to handle session cleanup**

In `src/lib/server-actions/workspace.ts`:

```tsx
export async function archiveWorkspace(workspaceId: string) {
  const session = await requireSession()
  const workspace = await authDO.getWorkspace(workspaceId)
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found")
  }

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id)
  if (!isAdmin) {
    throw new Error("Only admins can archive workspaces")
  }

  const workspaces = await authDO.listOrgWorkspaces(session.org_id)
  const activeWorkspaces = workspaces.filter((entry) => !entry.archived && entry.id !== workspaceId)

  if (activeWorkspaces.length === 0) {
    throw new Error("Cannot archive the only workspace in an organization")
  }

  // Archive the workspace
  const archived = await authDO.archiveWorkspace(workspaceId, session.user_id)
  if (!archived) {
    throw new Error("Workspace not found")
  }

  // IMPORTANT: If this was the current workspace, switch to a fallback
  if (session.workspace_id === workspaceId) {
    const fallback = activeWorkspaces[0]
    await authDO.switchSessionWorkspace(session.session_id, fallback.id)
  }

  return toSafeWorkspace(archived)
}
```

Note: This requires passing `session_id` from somewhere. Check if `requireSession` returns it or if the session context needs to be accessed differently.

**Fix C: Clear last_workspace_id when archiving**

When a workspace is archived, any memberships that have it as `last_workspace_id` should be updated.

Add a new RPC method to clear stale workspace references:

```typescript
// In workers/main/src/rpc-service.ts
async clearArchivedWorkspaceReferences(workspaceId: string): Promise<void> {
  // Clear from all memberships that reference this workspace
  // This would need to iterate through all orgs/users - may need a different approach
}
```

Or handle it lazily: when `switchOrg` tries to use a `last_workspace_id` that's archived, fall back gracefully and update the membership.

**Fix D: Redirect to workspaces list after archiving (not home)**

In `workspaces-list.tsx`, ensure the user stays on the workspaces page:

```tsx
const handleArchive = async (workspaceId: string) => {
  const fallback = workspaceList.find((workspace) => workspace.id !== workspaceId)

  try {
    await archiveWorkspace(workspaceId)
    setWorkspaceList((prev) =>
      prev.filter((workspace) => workspace.id !== workspaceId)
    )
    setArchiveTarget(null)

    if (workspaceId === currentWorkspaceId && fallback) {
      await switchWorkspace(fallback.id)
    }

    await refreshAuth()
    router.refresh()
    toast.success("Workspace archived")
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Failed to archive workspace"
    )
  }
}
```

### Required Tests

Add to `workers/main/tests/workspace-do.test.ts`:

```typescript
describe('Workspace archive edge cases', () => {
  it('should not allow archiving the last workspace', async () => {
    const { userId } = await rpc.createUser(testEmail(), 'password', 'Test')
    const org = await rpc.createOrg('Test Org', userId)

    const workspaces = await rpc.listOrgWorkspaces(org.id)
    expect(workspaces).toHaveLength(1) // Default workspace

    await expect(
      rpc.archiveWorkspace(workspaces[0].id, userId)
    ).rejects.toThrow(/cannot archive/i)
  })

  it('should switch session to fallback when current workspace is archived', async () => {
    const { userId } = await rpc.createUser(testEmail(), 'password', 'Test')
    const org = await rpc.createOrg('Test Org', userId)

    const workspace2 = await rpc.createWorkspace(org.id, 'Second', userId)
    const { sessionId } = await rpc.createSession(userId, org.id)

    let session = await rpc.getSession(sessionId)
    const defaultWorkspaceId = session!.workspace_id

    // Archive the default workspace (current)
    await rpc.archiveWorkspace(defaultWorkspaceId, userId)

    // Session should now point to workspace2
    session = await rpc.getSession(sessionId)
    expect(session!.workspace_id).toBe(workspace2.id)
  })

  it('should clear last_workspace_id when workspace is archived', async () => {
    const { userId } = await rpc.createUser(testEmail(), 'password', 'Test')
    const org = await rpc.createOrg('Test Org', userId)

    const workspace2 = await rpc.createWorkspace(org.id, 'Second', userId)
    const { sessionId } = await rpc.createSession(userId, org.id)

    // Switch to workspace2
    await rpc.switchSessionWorkspace(sessionId, workspace2.id)

    // Verify last_workspace_id is set
    let orgs = await rpc.getUserOrgs(userId)
    expect(orgs[0].last_workspace_id).toBe(workspace2.id)

    // Archive workspace2
    await rpc.archiveWorkspace(workspace2.id, userId)

    // last_workspace_id should be cleared or point to different workspace
    orgs = await rpc.getUserOrgs(userId)
    expect(orgs[0].last_workspace_id).not.toBe(workspace2.id)
  })
})
```

### Files to modify
- `src/components/sidebar/workspace-switcher.tsx` - Handle null currentWorkspace
- `src/lib/server-actions/workspace.ts` - Update session after archive
- `src/components/settings/workspaces-list.tsx` - Improve archive flow
- `workers/main/src/rpc-service.ts` - Add session update logic in archiveWorkspace
- `workers/main/tests/workspace-do.test.ts` - Add regression tests

---

## Implementation Priority

| Issue | Priority | Impact |
|-------|----------|--------|
| Archive workspace bug | CRITICAL | App becomes unusable |
| Settings refresh | High | Poor UX but not broken |
| Switcher layout | Medium | Visual polish |

Fix the archive bug first, as it can put users in an unrecoverable state without manual database intervention.

---

## Testing Checklist

- [ ] Workspace switcher shows two-line layout (name on top, org below)
- [ ] Settings page refreshes when workspace is switched via sidebar
- [ ] Settings page refreshes when org is switched via sidebar
- [ ] Archive workspace on non-current workspace works correctly
- [ ] Archive current workspace switches to fallback workspace
- [ ] Archive last-but-one workspace is blocked with error message
- [ ] Workspace switcher shows "No workspace" state instead of disappearing
- [ ] Switching to an org where last_workspace was archived works correctly
- [ ] All regression tests pass
