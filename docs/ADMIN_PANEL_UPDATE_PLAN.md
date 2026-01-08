# Admin Panel (qaml-backdoor) Update Plan

**Status:** Draft
**Date:** 2026-01-08
**Reference:** `WORKSPACE_ORG_SCHEMA_PLAN.md`, `WORKSPACE_IMPLEMENTATION_FEEDBACK.md`

---

## Executive Summary

This document outlines the changes needed to update the admin panel (`/qaml-backdoor`) to support the new workspace architecture. The admin panel follows Django admin conventions and provides superuser-only access to manage users, organizations, workspaces, threads, and audit logs.

---

## Table of Contents

1. [Current State](#current-state)
2. [Target State](#target-state)
3. [Dashboard Updates](#dashboard-updates)
4. [New Workspaces Section](#new-workspaces-section)
5. [Organizations Updates](#organizations-updates)
6. [Users Updates](#users-updates)
7. [Threads Updates](#threads-updates)
8. [New Audit Logs Section](#new-audit-logs-section)
9. [Admin Actions](#admin-actions)
10. [Backend API Additions](#backend-api-additions)
11. [Implementation Phases](#implementation-phases)
12. [File Structure](#file-structure)

---

## Current State

### Existing Admin Panel Structure

```
/qaml-backdoor/
├── page.tsx                  # Dashboard with stats + recent users
├── layout.tsx                # Auth check (superuser only) + sidebar
├── loading.tsx               # Loading skeleton
├── users/
│   ├── page.tsx              # Paginated users list
│   ├── loading.tsx
│   └── [id]/page.tsx         # User detail + edit form + org memberships
├── orgs/
│   ├── page.tsx              # Paginated orgs list
│   ├── loading.tsx
│   └── [id]/page.tsx         # Org detail + members + invitations + integrations
└── threads/
    ├── page.tsx              # Paginated threads list
    ├── loading.tsx
    └── [id]/page.tsx         # Thread detail + messages + preview workers
```

### Current Limitations

| Area | Current | Issue |
|------|---------|-------|
| Dashboard | Shows users, orgs, threads, memberships | Missing workspace count, orphaned user count |
| Users | Shows name, email, org memberships | Missing avatar, orphan status, workspace access |
| Orgs | Shows members, invitations, integrations (from first workspace) | Missing workspaces list, billing status, archived status, audit log |
| Threads | Shows org_id | Missing workspace_id, workspace name |
| Workspaces | N/A | Entirely missing - no way to browse workspaces |
| Audit Logs | N/A | No audit log viewing capability |
| Admin Actions | Reset sandbox container | Missing ownership transfer, archive, orphan management |

---

## Target State

### New Admin Panel Structure

```
/qaml-backdoor/
├── page.tsx                  # Dashboard (updated with workspace stats)
├── layout.tsx                # Auth check + sidebar (updated with new nav)
├── loading.tsx
├── users/
│   ├── page.tsx              # Users list (updated with avatar, orphan badge)
│   ├── loading.tsx
│   └── [id]/page.tsx         # User detail (updated with workspace access)
├── orgs/
│   ├── page.tsx              # Orgs list (updated with workspace count, status)
│   ├── loading.tsx
│   └── [id]/
│       ├── page.tsx          # Org detail (updated with workspaces, audit log link)
│       └── audit-log/page.tsx # Org audit log (NEW)
├── workspaces/               # NEW
│   ├── page.tsx              # Paginated workspaces list
│   ├── loading.tsx
│   └── [id]/
│       ├── page.tsx          # Workspace detail
│       └── audit-log/page.tsx # Workspace audit log
└── threads/
    ├── page.tsx              # Threads list (updated with workspace column)
    ├── loading.tsx
    └── [id]/page.tsx         # Thread detail (updated with workspace info)
```

---

## Dashboard Updates

### Current Dashboard Stats

```
Users | Organizations | Threads
Memberships | Superusers
+ Recent Users table with search
```

### Updated Dashboard Stats

```
Users | Organizations | Workspaces | Threads
Memberships | Superusers | Orphaned Users | Integrations
+ Recent Users table (with avatar, orphan badge)
+ Recent Activity table (from audit logs) [optional - phase 2]
```

### Implementation

**File:** `src/app/(admin)/qaml-backdoor/page.tsx`

**Changes:**
1. Update `getAdminOverview()` call or add new fields
2. Add workspace count stat card linking to `/qaml-backdoor/workspaces`
3. Add orphaned users count stat card (with danger color if > 0)
4. Add integrations count stat card
5. Update Recent Users table to show avatar and orphan badge

**New Admin Overview Fields Needed:**
```typescript
interface AdminOverview {
  // Existing
  users: AdminUserSummary[];
  total_users: number;
  total_orgs: number;
  total_memberships: number;

  // NEW
  total_workspaces: number;
  total_integrations: number;
  orphaned_users: number;
}
```

---

## New Workspaces Section

### Workspaces List Page

**Route:** `/qaml-backdoor/workspaces`

**Columns:**
| Column | Description |
|--------|-------------|
| Workspace | Name, ID (truncated), avatar |
| Organization | Org name with link to org detail |
| Threads | Thread count badge |
| Integrations | Integration count badge |
| Status | Active / Archived badge |
| Created | Timestamp |

**Filters (future):**
- By organization
- By status (active/archived)

### Workspace Detail Page

**Route:** `/qaml-backdoor/workspaces/[id]`

**Cards:**

1. **Workspace Details** (read-only info)
   - ID (full, monospace)
   - Name
   - Description
   - Organization (link)
   - Created by (link to user)
   - Created at
   - Status (Active/Archived)
   - Avatar (color + content preview)

2. **Edit Workspace** (admin form)
   - Name input
   - Description textarea
   - Avatar picker (color + content)
   - Save button

3. **Sandbox Container**
   - Reset container button (destructive)
   - Shows container ID (`ws-{workspaceId}`)

4. **Member Access** (table)
   - Lists users with explicit access restrictions
   - Columns: User, Access Level, Granted By, Granted At
   - Empty state: "No explicit restrictions. All org members have full access."

5. **Integrations** (table)
   - Lists workspace integrations
   - Columns: Name, Type, Category, Enabled, Created
   - Link to each integration (or inline expand)

6. **Threads** (table with pagination or "View all" link)
   - Lists workspace threads
   - Columns: Title, Created By, Updated
   - Links to thread detail

7. **Danger Zone**
   - Archive Workspace button (if active)
   - Unarchive Workspace button (if archived) [optional]

### Workspace Audit Log Page

**Route:** `/qaml-backdoor/workspaces/[id]/audit-log`

**Display:** Paginated table of audit log entries
- Columns: Action, Actor, Target, Details (JSON), Timestamp
- Actor/Target are links to user detail pages

---

## Organizations Updates

### Orgs List Page Updates

**Route:** `/qaml-backdoor/orgs`

**Updated Columns:**
| Column | Current | Updated |
|--------|---------|---------|
| Organization | Name, ID | Name, ID, Avatar (optional) |
| Members | Count badge | Count badge (unchanged) |
| Workspaces | N/A | NEW: Count badge |
| Status | N/A | NEW: Active/Archived badge |
| Billing | N/A | NEW: Free/Paying badge |
| Created By | User ID link | User ID link (unchanged) |
| Created | Timestamp | Timestamp (unchanged) |

### Org Detail Page Updates

**Route:** `/qaml-backdoor/orgs/[id]`

**Updated Cards:**

1. **Organization Details** (add new fields)
   - Billing Status: `free` | `paying` badge
   - Status: Active/Archived badge
   - Archived At (if archived)
   - Archived By (if archived, link to user)

2. **Edit Organization** (unchanged)
   - Name input
   - Save button

3. **Workspaces** (NEW card)
   - Lists all org workspaces
   - Columns: Name, Avatar, Threads, Integrations, Status
   - Links to workspace detail
   - "Create Workspace" button (optional for admin)

4. **Sandbox Container** → Update description
   - Change from "org container" to "workspace containers"
   - Option: Reset all workspace containers, or show list of containers

5. **Members** (updated)
   - Add role column showing `owner` | `admin` | `member` | `viewer`
   - Show role badge with color coding (owner=gold, admin=blue, etc.)
   - Add "Change Role" action for admins (dropdown menu)
   - Add "Transfer Ownership" action for owner (moves to Danger Zone)

6. **Pending Invitations** (add role column)
   - Show the invited role

7. **Integrations** (REMOVE or update)
   - Integrations are now per-workspace, not per-org
   - Option A: Remove this card entirely
   - Option B: Show aggregate of all workspace integrations with workspace name

8. **Audit Log** (NEW - link or inline preview)
   - Link to `/qaml-backdoor/orgs/[id]/audit-log`
   - Or: Show last 10 entries inline with "View all" link

9. **Danger Zone** (NEW card)
   - Transfer Ownership: Select dropdown + confirm
   - Archive Organization: Confirm dialog with org name input
   - Only enabled for appropriate conditions (e.g., not already archived)

### Org Audit Log Page

**Route:** `/qaml-backdoor/orgs/[id]/audit-log`

**Display:** Same format as workspace audit log

---

## Users Updates

### Users List Page Updates

**Route:** `/qaml-backdoor/users`

**Updated Columns:**
| Column | Current | Updated |
|--------|---------|---------|
| User | Name/Email, ID | Avatar + Name/Email, ID |
| Orgs | Count badge | Count badge (unchanged) |
| Status | N/A | NEW: Orphaned badge (if orphaned) |
| Created | Timestamp | Timestamp (unchanged) |
| Role | Superuser badge | Superuser badge (unchanged) |

**Avatar Display:**
- Small avatar circle (24x24) with user's avatar color and content
- Falls back to initials if no avatar set

**Orphaned Badge:**
- Show red "Orphaned" badge if `is_orphaned === true`
- Could add filter to show only orphaned users

### User Detail Page Updates

**Route:** `/qaml-backdoor/users/[id]`

**Updated Cards:**

1. **User Details** (add new fields)
   - Avatar: Large preview (64x64) with color and content
   - Is Orphaned: Yes/No with badge
   - Orphaned At: Timestamp (if orphaned)

2. **Edit User** (add avatar editing)
   - Name input
   - Is Superuser toggle
   - Avatar picker (color + content)
   - Save button

3. **Organization Memberships** (updated)
   - Add workspace access column
   - Show all workspaces user can access per org
   - Role displayed as badge with color coding

4. **Workspace Access** (NEW card)
   - Flattened view: All workspaces user can access across all orgs
   - Columns: Workspace, Organization, Access Level
   - Links to workspace and org detail pages

5. **Admin Actions** (NEW card)
   - Force Orphan: Remove user from all orgs (makes them orphaned)
   - Only show if user has org memberships
   - Requires confirmation dialog

---

## Threads Updates

### Threads List Page Updates

**Route:** `/qaml-backdoor/threads`

**Updated Columns:**
| Column | Current | Updated |
|--------|---------|---------|
| Thread | Title, ID | Title, ID (unchanged) |
| Organization | Org ID link | KEEP but add org name |
| Workspace | N/A | NEW: Workspace name + ID link |
| Updated | Timestamp | Timestamp (unchanged) |

### Thread Detail Page Updates

**Route:** `/qaml-backdoor/threads/[id]`

**Updated Cards:**

1. **Thread Details** (add workspace info)
   - Workspace: Name + ID with link to workspace detail
   - Organization: Name + ID with link (not just ID)

2. **Preview Workers** (unchanged)

3. **Edit Thread** (unchanged)

4. **Messages** (unchanged)

---

## New Audit Logs Section

### Option A: Dedicated Section (Recommended for discoverability)

Add new sidebar item under "Models":

```
Models
├── Users
├── Organizations
├── Workspaces
├── Threads
└── Audit Logs  ← NEW
```

**Route:** `/qaml-backdoor/audit-logs`

**Features:**
- Global audit log search across all orgs and workspaces
- Filter by:
  - Organization
  - Workspace
  - Action type (member_added, workspace_created, etc.)
  - Actor (user ID)
  - Date range
- Pagination
- Links to related entities (org, workspace, user)

### Option B: Contextual Only (Simpler)

Only show audit logs within org and workspace detail pages:
- `/qaml-backdoor/orgs/[id]/audit-log`
- `/qaml-backdoor/workspaces/[id]/audit-log`

No dedicated section in sidebar.

### Recommendation

Start with **Option B** (contextual only) for Phase 1, add **Option A** in Phase 2 if needed.

---

## Admin Actions

### Summary of Admin Actions by Page

| Page | Action | Description | Danger Level |
|------|--------|-------------|--------------|
| Org Detail | Transfer Ownership | Move owner role to another member | High |
| Org Detail | Archive Organization | Soft-delete org and all workspaces | High |
| Org Detail | Change Member Role | Update role for any member | Medium |
| Org Detail | Remove Member | Kick member from org | Medium |
| Org Detail | Reset All Containers | Restart all workspace containers | Medium |
| Workspace Detail | Archive Workspace | Soft-delete workspace | High |
| Workspace Detail | Reset Container | Restart workspace container | Medium |
| User Detail | Force Orphan | Remove from all orgs | High |
| User Detail | Toggle Superuser | Grant/revoke admin access | High |

### Action Button Styling

- **High Danger:** Red destructive button with confirmation dialog
- **Medium Danger:** Outline button with confirmation dialog
- **Low Danger:** Regular button (may need confirmation for side effects)

### Confirmation Dialogs

For high-danger actions, require typing the entity name to confirm:

```tsx
<AlertDialog>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Archive Organization</AlertDialogTitle>
      <AlertDialogDescription>
        This will archive the organization and all its workspaces.
        Members will lose access. This action is reversible by a superuser.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <div className="py-4">
      <Label>Type "{org.name}" to confirm</Label>
      <Input value={confirmText} onChange={...} />
    </div>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction disabled={confirmText !== org.name}>
        Archive
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

---

## Backend API Additions

### New RPC Methods Needed

```typescript
// Admin overview enhancements
interface AdminOverview {
  // ... existing fields
  total_workspaces: number;
  total_integrations: number;
  orphaned_users: number;
}

// Paginated workspaces for admin
adminGetWorkspacesPaginated(params: PaginationParams): Promise<PaginatedResult<
  Workspace & {
    org_id: string;
    org_name: string;
    thread_count: number;
    integration_count: number;
  }
>>

// Get workspace with related data for admin detail page
adminGetWorkspaceDetail(workspaceId: string): Promise<{
  workspace: Workspace;
  org: Organization;
  threads: Thread[];
  integrations: Integration[];
  members: WorkspaceMember[];
} | null>

// Admin workspace update (bypass permission checks)
adminUpdateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string; avatar?: { color: string; content: string } }
): Promise<Workspace | null>

// Admin workspace archive/unarchive
adminArchiveWorkspace(workspaceId: string, actorId: string): Promise<Workspace | null>
adminUnarchiveWorkspace(workspaceId: string, actorId: string): Promise<Workspace | null>

// Admin org archive
adminArchiveOrg(orgId: string, actorId: string): Promise<void>

// Admin force orphan user
adminForceOrphanUser(userId: string, actorId: string): Promise<void>

// Admin get all integrations across workspaces (for dashboard count)
adminGetIntegrationCount(): Promise<number>

// Admin transfer ownership (bypass normal permission checks, but still validate)
adminTransferOrgOwnership(orgId: string, newOwnerId: string, actorId: string): Promise<void>

// Get orphaned users list
adminGetOrphanedUsers(): Promise<UserProfile[]>
```

### Update Existing RPC Methods

```typescript
// Add workspace_id to thread list results (already done per auth-do.ts)
adminGetThreadsPaginated(params): Promise<PaginatedResult<Thread & { org_id: string; workspace_id: string }>>

// Add org_name to thread results for display
adminGetThreadWithMessages(threadId): Promise<{
  // ... existing
  org_name: string;      // NEW
  workspace_name: string; // NEW
}>
```

---

## Implementation Phases

### Phase 1: Dashboard & Workspaces (Foundation)

**Priority:** High - Establishes workspace visibility in admin

**Tasks:**
1. Update `adminGetOverview` RPC to include new stats
2. Update Dashboard page with new stat cards
3. Add Workspaces to sidebar navigation
4. Create workspaces list page with pagination
5. Create workspace detail page with all cards
6. Add `adminGetWorkspacesPaginated` RPC method
7. Add `adminGetWorkspaceDetail` RPC method

**Files to Create:**
- `src/app/(admin)/qaml-backdoor/workspaces/page.tsx`
- `src/app/(admin)/qaml-backdoor/workspaces/loading.tsx`
- `src/app/(admin)/qaml-backdoor/workspaces/[id]/page.tsx`
- `src/components/admin/workspace-edit-form.tsx`

**Files to Modify:**
- `src/app/(admin)/qaml-backdoor/page.tsx` (dashboard)
- `src/components/admin/admin-sidebar.tsx` (add workspaces nav)
- `src/components/admin/admin-dashboard.tsx` (new stats)
- `workers/main/src/rpc-service.ts` (new methods)
- `src/lib/auth-do.ts` (expose new methods)

### Phase 2: Organization Updates

**Priority:** High - Workspaces are children of orgs

**Tasks:**
1. Update orgs list to show workspace count and status
2. Update org detail with workspaces card
3. Add billing status and archived status display
4. Update members card with role badges
5. Add danger zone with archive and transfer ownership
6. Create org audit log page

**Files to Create:**
- `src/app/(admin)/qaml-backdoor/orgs/[id]/audit-log/page.tsx`
- `src/components/admin/org-danger-zone.tsx`
- `src/components/admin/transfer-ownership-dialog.tsx`
- `src/components/admin/archive-org-dialog.tsx`

**Files to Modify:**
- `src/app/(admin)/qaml-backdoor/orgs/page.tsx`
- `src/app/(admin)/qaml-backdoor/orgs/[id]/page.tsx`
- `src/components/admin/org-edit-form.tsx`

### Phase 3: User Updates

**Priority:** Medium - Visibility into user state

**Tasks:**
1. Update users list with avatar and orphan badge
2. Update user detail with avatar display
3. Add workspace access card
4. Add admin actions (force orphan, toggle superuser)
5. Update edit form with avatar picker

**Files to Create:**
- `src/components/admin/user-admin-actions.tsx`
- `src/components/admin/force-orphan-dialog.tsx`

**Files to Modify:**
- `src/app/(admin)/qaml-backdoor/users/page.tsx`
- `src/app/(admin)/qaml-backdoor/users/[id]/page.tsx`
- `src/components/admin/user-edit-form.tsx`

### Phase 4: Thread Updates

**Priority:** Medium - Context clarity

**Tasks:**
1. Update threads list with workspace column
2. Update thread detail with workspace info
3. Add org name display (not just ID)

**Files to Modify:**
- `src/app/(admin)/qaml-backdoor/threads/page.tsx`
- `src/app/(admin)/qaml-backdoor/threads/[id]/page.tsx`

### Phase 5: Audit Logs & Polish

**Priority:** Low - Nice to have

**Tasks:**
1. Create workspace audit log page
2. (Optional) Create global audit logs section
3. Add filters and search to list pages
4. Polish loading states and error handling

**Files to Create:**
- `src/app/(admin)/qaml-backdoor/workspaces/[id]/audit-log/page.tsx`
- `src/components/admin/audit-log-table.tsx` (shared component)

---

## File Structure

### New Files to Create

```
src/app/(admin)/qaml-backdoor/
├── workspaces/
│   ├── page.tsx                    # Workspaces list
│   ├── loading.tsx                 # Loading skeleton
│   └── [id]/
│       ├── page.tsx                # Workspace detail
│       └── audit-log/
│           └── page.tsx            # Workspace audit log
└── orgs/
    └── [id]/
        └── audit-log/
            └── page.tsx            # Org audit log

src/components/admin/
├── workspace-edit-form.tsx         # Workspace edit form
├── org-danger-zone.tsx             # Org danger zone actions
├── workspace-danger-zone.tsx       # Workspace danger zone actions
├── transfer-ownership-dialog.tsx   # Transfer ownership confirmation
├── archive-org-dialog.tsx          # Archive org confirmation
├── archive-workspace-dialog.tsx    # Archive workspace confirmation
├── user-admin-actions.tsx          # User admin action buttons
├── force-orphan-dialog.tsx         # Force orphan confirmation
└── audit-log-table.tsx             # Reusable audit log table
```

### Files to Modify

```
src/app/(admin)/qaml-backdoor/
├── page.tsx                        # Dashboard updates
└── ...

src/components/admin/
├── admin-sidebar.tsx               # Add workspaces nav item
├── admin-dashboard.tsx             # New stats cards
├── org-edit-form.tsx               # (minor updates)
└── user-edit-form.tsx              # Add avatar picker

workers/main/src/
└── rpc-service.ts                  # New admin RPC methods

src/lib/
└── auth-do.ts                      # Expose new RPC methods
```

---

## UI Component Requirements

### Existing Components (Already Installed)

From `components.json` and current usage:
- Badge, Button, Card, Dialog, DropdownMenu
- Input, Label, Select, Table, Tooltip
- Avatar, ScrollArea, Separator, Skeleton

### Components to Potentially Install

```bash
# Only if not already present
npx shadcn@latest add alert-dialog  # For confirmation dialogs (may already exist)
```

### Custom Components Needed

1. **Avatar Display** - Show user/workspace avatar with color background
2. **Role Badge** - Colored badge for owner/admin/member/viewer
3. **Status Badge** - Active/Archived badge
4. **Audit Log Table** - Reusable table for audit entries
5. **Confirmation Dialog** - Type-to-confirm pattern

---

## Type Updates

### Add Admin Types

```typescript
// src/types.ts additions

export interface AdminWorkspaceSummary extends Workspace {
  org_id: string;
  org_name: string;
  thread_count: number;
  integration_count: number;
}

export interface AdminWorkspaceDetail {
  workspace: Workspace;
  org: Organization;
  threads: Thread[];
  integrations: Integration[];
  members: WorkspaceMember[];
}

export interface AdminThreadWithContext extends Thread {
  org_id: string;
  org_name: string;
  workspace_id: string;
  workspace_name: string;
}
```

---

## Success Criteria

### Must Have
- [ ] Workspaces list and detail pages functional
- [ ] Dashboard shows workspace, orphan, and integration counts
- [ ] Org detail shows all workspaces
- [ ] User detail shows avatar and orphan status
- [ ] Thread list shows workspace context
- [ ] Container reset works per-workspace
- [ ] Archive org/workspace actions work
- [ ] Transfer ownership action works

### Should Have
- [ ] Audit log viewing at org and workspace level
- [ ] Role change actions for org members
- [ ] Force orphan action for users
- [ ] Avatar editing for users and workspaces

### Nice to Have
- [ ] Global audit logs section with filters
- [ ] Search/filter on list pages
- [ ] Unarchive actions
- [ ] Bulk actions

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-08 | 1.0 | Initial draft |
