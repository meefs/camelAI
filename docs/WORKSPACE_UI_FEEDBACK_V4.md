# Workspace UI Implementation Feedback - V4

## Summary

This feedback addresses UX polish issues, design consistency, and a backend invariant requirement.

---

## 1. Relocate "Create" Flows to Dedicated Tabs

### Problem
Currently, the "Create Workspace" and "Create Organization" actions appear on General settings pages. They should only appear on their respective list pages.

### Required Changes

**Create Workspace:**
- Remove from: `src/app/(app)/settings/organization/general/page.tsx` (if present)
- Keep in: `src/components/settings/workspaces-list.tsx` (already correct)
- The "Create workspace" button should only appear on the Organization > Workspaces tab

**Create Organization:**
- Remove from: `src/app/(app)/settings/user/general/page.tsx` (if present)
- Keep in: `src/components/settings/org-memberships-list.tsx` or the Organizations tab page
- Add a "Create organization" button to the User > Organizations tab if not already present

### Rationale
Users expect to find creation actions alongside the list of existing items, not on a general settings page.

---

## 2. Dropdown Menu Polish: Text Wrap and Avatars

### Problem
Dropdown menus have two issues:
1. Menu item text wraps to multiple lines instead of staying on one line
2. The "+ Add" workspace dropdown (in workspace access tags) shows workspace names without avatars

### Required Changes

**A) Prevent Text Wrap in All DropdownMenuContent:**

Add `whitespace-nowrap` and minimum width to dropdown menus:

```tsx
<DropdownMenuContent align="end" className="min-w-[180px]">
  <DropdownMenuItem className="whitespace-nowrap">
    Switch to this workspace
  </DropdownMenuItem>
</DropdownMenuContent>
```

**Files to update:**
- `src/components/settings/workspaces-list.tsx` (lines 197, 249)
- `src/components/settings/org-memberships-list.tsx` (lines 140, 194)
- `src/components/settings/team-table.tsx` (all DropdownMenuContent instances)

**B) Add Avatars to Workspace Access "+ Add" Dropdown:**

In `src/components/settings/workspace-access-tags.tsx`, update the dropdown items to include workspace avatars:

```tsx
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { getContrastTextColor } from "@/lib/avatar"

// In the DropdownMenuContent (around line 149):
<DropdownMenuContent align="start" className="min-w-[180px]">
  {hiddenWorkspaces.map((workspace) => (
    <DropdownMenuItem
      key={workspace.id}
      onClick={() => handleAdd(workspace.id)}
      className="whitespace-nowrap"
    >
      <Avatar className="h-5 w-5 mr-2">
        <AvatarFallback
          style={{
            backgroundColor: workspace.avatar.color,
            color: getContrastTextColor(workspace.avatar.color),
            fontSize: "0.625rem",
          }}
        >
          {workspace.avatar.content}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{workspace.name}</span>
    </DropdownMenuItem>
  ))}
</DropdownMenuContent>
```

Note: The `Workspace` type in the props may need to include the `avatar` field. Check if it's already there or add it:

```tsx
interface Workspace {
  id: string
  name: string
  avatar: {
    color: string
    content: string
  }
}
```

---

## 3. Replace Browser `confirm()` with shadcn AlertDialog

### Problem
The app uses the native browser `confirm()` dialog in 6 places. This looks inconsistent with the rest of the UI and doesn't match the design system.

### Required Changes

Replace all `confirm()` usages with shadcn's `AlertDialog` component.

**Locations to update:**

| File | Line | Action | Confirmation Message |
|------|------|--------|---------------------|
| `src/components/settings/workspaces-list.tsx` | 96 | Archive workspace | "Archive this workspace?" |
| `src/components/settings/team-table.tsx` | 159 | Remove member | "Remove this member from the organization?" |
| `src/components/settings/team-table.tsx` | 172 | Leave org | "Leave this organization?" |
| `src/components/settings/org-memberships-list.tsx` | 78 | Leave org | "Leave this organization?" |
| `src/app/(app)/connections/connections-client.tsx` | 101 | Delete connection | "Are you sure you want to delete {name}?" |
| `src/app/(app)/computer/[orgId]/computer-page-content.tsx` | 1930 | Reset container | "Reset the sandbox container?..." |

### Implementation Pattern

Create a reusable confirmation dialog or use AlertDialog inline. Here's the inline pattern:

```tsx
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

// State for the dialog
const [confirmOpen, setConfirmOpen] = useState(false)
const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null)

// Handler pattern
const handleArchive = (workspaceId: string) => {
  setPendingAction(() => async () => {
    // ... archive logic
  })
  setConfirmOpen(true)
}

// In JSX, add AlertDialog at component root:
<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Archive workspace?</AlertDialogTitle>
      <AlertDialogDescription>
        This action cannot be undone. The workspace will be archived.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onClick={() => {
          pendingAction?.()
          setPendingAction(null)
        }}
      >
        Archive
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Alternative: Create a reusable ConfirmDialog component:**

```tsx
// src/components/ui/confirm-dialog.tsx
interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  variant?: "default" | "destructive"
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "default",
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={variant === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

---

## 4. Settings Page Vertical Scroll Issue

### Problem
Settings pages don't scroll vertically when content exceeds the viewport height.

### Root Cause
In `src/app/(app)/settings/layout.tsx`, the layout uses `min-h-full` but doesn't establish proper overflow handling:

```tsx
<div className="flex min-h-full flex-col md:flex-row">
  <SettingsNav />
  <main className="flex-1 p-4 md:p-8">{children}</main>
</div>
```

### Required Changes

Update the layout to enable vertical scrolling:

```tsx
<div className="flex h-full flex-col md:flex-row overflow-hidden">
  <SettingsNav />
  <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
</div>
```

Key changes:
- `min-h-full` -> `h-full` (fixed height to viewport)
- Add `overflow-hidden` to parent (prevents body scroll)
- Add `overflow-y-auto` to main (enables scroll within content area)

Also check if the parent layout (`src/app/(app)/layout.tsx`) properly constrains height. It may need:

```tsx
<div className="h-screen flex flex-col">
  {/* ... */}
</div>
```

---

## 5. Backend Invariant: Organization Must Always Have an Owner

### Problem
There's a potential state where an org could have no owner if:
- The owner leaves the org (shouldn't be allowed)
- The owner is removed by another admin (shouldn't be allowed for owners)
- Data corruption or migration issues

### Required Backend Changes

**A) Prevent owner from leaving:**

In `workers/main/src/auth.ts` (OrgDO), add validation:

```typescript
async removeMember(userId: string): Promise<void> {
  const member = await this.getMember(userId)
  if (!member) throw new Error("User is not a member")
  if (member.role === "owner") {
    throw new Error("Cannot remove the organization owner. Transfer ownership first.")
  }
  // ... rest of removal logic
}
```

**B) Add ownership transfer capability:**

```typescript
async transferOwnership(fromUserId: string, toUserId: string): Promise<void> {
  const fromMember = await this.getMember(fromUserId)
  const toMember = await this.getMember(toUserId)

  if (!fromMember || fromMember.role !== "owner") {
    throw new Error("Only the owner can transfer ownership")
  }
  if (!toMember) {
    throw new Error("Target user is not a member")
  }

  // Atomic transaction
  await this.sql.exec(`
    UPDATE members SET role = 'admin' WHERE user_id = ?;
    UPDATE members SET role = 'owner' WHERE user_id = ?;
  `, fromUserId, toUserId)
}
```

**C) Add recovery/invariant check:**

If an org somehow ends up with no owner, have a recovery mechanism:

```typescript
async ensureOwnerExists(): Promise<void> {
  const owner = await this.sql.exec(
    `SELECT user_id FROM members WHERE role = 'owner' LIMIT 1`
  ).one()

  if (!owner) {
    // Promote oldest admin to owner, or oldest member if no admins
    const fallback = await this.sql.exec(`
      SELECT user_id FROM members
      ORDER BY
        CASE role WHEN 'admin' THEN 0 ELSE 1 END,
        joined_at ASC
      LIMIT 1
    `).one()

    if (fallback) {
      await this.sql.exec(
        `UPDATE members SET role = 'owner' WHERE user_id = ?`,
        fallback.user_id
      )
    }
  }
}
```

**D) Frontend: Hide "Leave" for owners:**

Already partially done in `org-memberships-list.tsx` line 144-151:
```tsx
{org.role !== "owner" ? (
  <DropdownMenuItem onClick={() => handleLeaveOrg(org.org_id)} ...>
    Leave organization
  </DropdownMenuItem>
) : null}
```

Verify this pattern exists in all places where leaving is an option.

---

## Testing Checklist

- [ ] Create Workspace only appears on Organization > Workspaces tab
- [ ] Create Organization only appears on User > Organizations tab
- [ ] Dropdown menus don't wrap text
- [ ] Workspace access "+ Add" dropdown shows avatars
- [ ] All 6 confirm() dialogs replaced with AlertDialog
- [ ] Settings pages scroll vertically when content is tall
- [ ] Owner cannot leave organization (backend rejects)
- [ ] Owner cannot be removed by admin (backend rejects)
- [ ] "Leave organization" option hidden for owners in UI
