# Workspace UI Implementation Feedback v2

**Date:** 2026-01-07
**Status:** Post-implementation review

---

## Summary

The coding agent addressed the critical issues from the previous feedback document (sidebar persistence, danger zone consolidation, avatar contrast). This document covers the remaining issues and new feedback.

---

## Critical Issues

### 1. Server Action Serialization Error

**Problem:** When saving forms (creating workspace, updating workspace description, etc.), users get the error:
```
"Only plain objects, and a few built-ins, can be passed to Client Components from Server Components. Classes or null prototypes are not supported. {}"
```

**Root Cause:** Server actions in `src/lib/server-actions/workspace.ts` return objects directly from the RPC layer. The RPC layer returns objects from Durable Object SQL queries, which may have null prototypes or class instances.

**Affected server actions:**
- `createWorkspace` - Returns `authDO.createWorkspace(...)` directly
- `updateWorkspaceInfo` - Returns `authDO.updateWorkspace(...)` directly

**Fix required:** Convert RPC results to plain objects before returning from server actions. Use the same pattern already established in the page components (e.g., `safeWorkspace` in [workspace/general/page.tsx](../src/app/(app)/settings/workspace/general/page.tsx)).

**Example fix for `createWorkspace`:**
```typescript
export async function createWorkspace(name: string, description?: string | null) {
  const session = await requireSession()
  // ... validation ...

  const workspace = await authDO.createWorkspace(
    session.org_id,
    trimmed,
    session.user_id,
    description ?? null
  )

  // Convert to plain object for client serialization
  return {
    id: workspace.id,
    org_id: workspace.org_id,
    name: workspace.name,
    description: workspace.description,
    created_by: workspace.created_by,
    created_at: workspace.created_at,
    avatar: {
      color: workspace.avatar.color,
      content: workspace.avatar.content,
    },
    archived: workspace.archived,
    archived_at: workspace.archived_at,
  }
}
```

**Files to update:**
- `src/lib/server-actions/workspace.ts` - `createWorkspace`, `updateWorkspaceInfo`, `archiveWorkspace`
- `src/lib/server-actions/org.ts` - Review and fix any actions returning DO results directly
- `src/lib/server-actions/user.ts` - Review `updateUserProfile` if it returns RPC results directly

---

## Medium Priority Issues

### 2. Team Table: Merge Pending Invitations into Member List

**Current behavior:** The team page shows pending invitations as a separate table above the member list.

**Problem:** This creates visual fragmentation. When there are pending invitations, users see two separate tables stacked on top of each other.

**Expected behavior:** Show pending invitations as rows in the same table as members, with a "Status" column to distinguish them.

**Implementation:**

1. **Add Status column to member table:**
   - Active members show "Active" status (or just leave blank/implicit)
   - Pending invitations show "Pending" or "Invited" status with date

2. **Unify the data structure:**
   ```typescript
   type TeamTableRow =
     | { type: 'member'; user: User; role: OrgRole; workspaceAccess: Record<string, WorkspaceAccessLevel> }
     | { type: 'invitation'; email: string; role: OrgRole; created_at: number; expires_at: number; id: string }
   ```

3. **Update table columns:**
   - Member/Email (show avatar + name for members, just email for invitations)
   - Role
   - Status (new column)
   - Workspace access (disabled/N/A for invitations)
   - Actions (Cancel for invitations, Remove/Leave for members)

4. **Mobile view:** Update card view to match

**Files to modify:**
- `src/components/settings/team-table.tsx` - Merge tables, add Status column

---

### 3. Workspace Access Tags: Hover UX Causes Layout Shift

**Current behavior:** Hovering over a workspace tag reveals pencil and X icons by expanding the tag. This causes the table column to grow, shifting the layout.

**Problem:** The layout shift is jarring and makes it difficult to click the icons precisely as content moves.

**Proposed solutions (pick one):**

#### Option A: Edit Mode Toggle (Recommended)

Add an "Edit" button that puts the workspace access column into edit mode:

1. Default state: Tags show workspace names only, no action icons
2. Click "Edit" button in column header → Enter edit mode
3. Edit mode: All tags show action icons (pencil toggle, X remove)
4. "Done" button exits edit mode

**Benefits:**
- No layout shift during normal viewing
- All badges editable at once
- Clear mode distinction
- Classic pattern (like iOS/Android list editing)

**Implementation:**
```tsx
// In TeamTable, add editing state
const [editingWorkspaceAccess, setEditingWorkspaceAccess] = useState(false)

// Column header
<TableHead>
  <div className="flex items-center justify-between">
    <span>Workspace access</span>
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setEditingWorkspaceAccess(!editingWorkspaceAccess)}
    >
      {editingWorkspaceAccess ? "Done" : "Edit"}
    </Button>
  </div>
</TableHead>

// Pass editing state to WorkspaceAccessTags
<WorkspaceAccessTags
  ...
  editing={editingWorkspaceAccess}
/>
```

#### Option B: Dialog-Based Editing

Use the existing three-dot menu to open a dialog for workspace access:

1. Add "Manage workspace access" option to the row's dropdown menu
2. Opens a dialog with full workspace access controls
3. No hover interactions on the tags themselves

**Benefits:**
- No layout shift
- More space for complex interactions
- Consistent with other table actions

#### Option C: Fixed-Width Tags with Overlaid Icons

Reserve space for icons always, but visually hide them:

1. Tags have fixed padding on the right for icon space
2. Icons are absolutely positioned and only visible on hover
3. Icons appear over/beside the text without expanding the tag

**Benefits:**
- Keeps inline editing
- No layout shift

**Drawback:** Wastes horizontal space

**Recommendation:** Go with **Option A (Edit Mode Toggle)** - it's the most intuitive and eliminates layout shift entirely. The "Edit" button also makes it clearer that workspace access can be changed.

**Files to modify:**
- `src/components/settings/team-table.tsx` - Add editing state and button
- `src/components/settings/workspace-access-tags.tsx` - Accept `editing` prop, always show icons when editing

---

### 4. Avatar Preview Sizing in Picker

**Current behavior:** In the avatar picker dialog, the preview avatar shows the initials/emoji at a size that appears small relative to the avatar circle (h-16 w-16).

**Problem:** The text/emoji inside the avatar fallback doesn't scale with the larger preview size. The `AvatarFallback` uses `text-sm` by default, which is appropriate for small avatars but looks disproportionately small in the larger preview.

**Expected behavior:** The preview avatar should show larger text that fills more of the avatar circle, matching the visual weight seen at normal sizes.

**Fix required:** Add a text size class to the preview avatar's `AvatarFallback`:

```tsx
// In avatar-picker.tsx, the preview Avatar at line 112-118
<Avatar className="h-16 w-16">
  <AvatarFallback
    className="text-2xl"  // ADD THIS - larger text for preview
    style={{ backgroundColor: preview.color, color: previewTextColor }}
  >
    {preview.content}
  </AvatarFallback>
</Avatar>
```

Alternatively, extend the Avatar component's size system to include an "xl" size with appropriate text scaling:
```tsx
// In src/components/ui/avatar.tsx
// Add data-[size=xl]:size-16 data-[size=xl]:text-2xl
```

**Files to modify:**
- `src/components/settings/avatar-picker.tsx` - Add text size class to preview AvatarFallback

---

### 5. Add "Create Organization" Functionality

**Current state:** Users can create workspaces within an org, but cannot create new organizations from the settings UI.

**Expected behavior:** Add a way for users to create a new organization from the Organization General settings page.

**Implementation:**

1. **Add "Create new organization" section** to `src/app/(app)/settings/organization/general/page.tsx`:
   - Place after the org name form, before the Danger Zone
   - Similar pattern to "Create new workspace" in workspace general

2. **Create dialog component** `src/components/settings/create-org-dialog.tsx`:
   - Form with org name input
   - Creates org via server action
   - On success: refresh auth context, optionally switch to new org

3. **Add server action** `createOrg` to `src/lib/server-actions/org.ts`:
   - Calls `authDO.createOrg(name, userId)`
   - Returns plain object

4. **Note:** The backend already supports this via `authDO.createOrg()`. Just need UI.

**Files to create/modify:**
- `src/components/settings/create-org-dialog.tsx` (new)
- `src/app/(app)/settings/organization/general/page.tsx` - Add section with button
- `src/lib/server-actions/org.ts` - Add `createOrg` server action

---

### 6. Add Billing Tab Placeholder

**Current state:** No billing tab exists in settings.

**Expected behavior:** Add a "Billing" tab under the Organization section that shows billing status and a placeholder for future billing features.

**Implementation:**

1. **Add nav item** to `src/components/settings/settings-nav.tsx`:
   ```typescript
   {
     label: "Organization",
     items: [
       { label: "General", href: "/settings/organization/general" },
       { label: "Team", href: "/settings/organization/team" },
       { label: "Billing", href: "/settings/organization/billing" },  // NEW
       { label: "Domains", href: "/settings/organization/domains" },
     ],
   },
   ```

2. **Create billing page** `src/app/(app)/settings/organization/billing/page.tsx`:
   ```tsx
   import { Separator } from "@/components/ui/separator"
   import { Badge } from "@/components/ui/badge"
   import { SettingsHeader } from "@/components/settings/settings-header"
   import { requireAuthContextLite } from "@/lib/server-guards"

   export default async function OrgBillingPage() {
     const authContext = await requireAuthContextLite()
     const billingStatus = authContext.currentOrg.billing_status

     return (
       <div className="space-y-6">
         <SettingsHeader
           title="Billing"
           description="View your organization's billing status and manage payments."
         />
         <Separator />
         <div className="space-y-4 max-w-2xl">
           <div>
             <h3 className="text-base font-medium mb-2">Current plan</h3>
             <div className="flex items-center gap-3">
               <Badge variant={billingStatus === 'paying' ? 'default' : 'secondary'}>
                 {billingStatus === 'paying' ? 'Pro' : 'Free'}
               </Badge>
             </div>
           </div>
           <p className="text-sm text-muted-foreground">
             Billing management is coming soon. Contact support for plan changes.
           </p>
         </div>
       </div>
     )
   }
   ```

**Files to create/modify:**
- `src/components/settings/settings-nav.tsx` - Add Billing nav item
- `src/app/(app)/settings/organization/billing/page.tsx` (new)

---

## Implementation Checklist

| Issue | Priority | Files |
|-------|----------|-------|
| Server action serialization error | Critical | `server-actions/workspace.ts`, `server-actions/org.ts`, `server-actions/user.ts` |
| Merge invitations into team table | Medium | `team-table.tsx` |
| Workspace access tag hover UX | Medium | `team-table.tsx`, `workspace-access-tags.tsx` |
| Avatar preview sizing | Medium | `avatar-picker.tsx` |
| Create organization UI | Medium | `create-org-dialog.tsx` (new), `organization/general/page.tsx`, `server-actions/org.ts` |
| Billing tab placeholder | Medium | `settings-nav.tsx`, `organization/billing/page.tsx` (new) |

---

## Notes for Implementation

### Server Action Pattern
When returning objects from server actions that originate from Durable Objects/RPC:
1. Always destructure and reconstruct as plain objects
2. Explicitly copy nested objects (like `avatar: { color, content }`)
3. Don't return the RPC result directly

### Edit Mode Pattern
For the workspace access tags edit mode:
1. The edit state should be local to the TeamTable component
2. Pass `editing` boolean prop to WorkspaceAccessTags
3. When `editing` is true, show all action icons inline
4. When `editing` is false, hide action icons completely (no hover behavior)

