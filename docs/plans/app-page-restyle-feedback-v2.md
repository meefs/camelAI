# App Page Restyle - Feedback v2

This document contains feedback on the second iteration of the app page restyle. Please address these items.

**Previous feedback:** [docs/plans/app-page-restyle-feedback.md](./app-page-restyle-feedback.md)

---

## 1. Change App Icon from "Boxes" to "LayoutGrid"

**Issue:** The current app icon uses `Boxes` from lucide-react. We want to change it to `LayoutGrid` across all locations.

**Locations to update:**

| File | Line | Current | Change To |
|------|------|---------|-----------|
| `src/app/(app)/apps/apps-client.tsx` | 15 | `import { AlertCircle, Boxes }` | `import { AlertCircle, LayoutGrid }` |
| `src/app/(app)/apps/apps-client.tsx` | 130 | `<Boxes className="size-6 text-muted-foreground" />` | `<LayoutGrid className="size-6 text-muted-foreground" />` |
| `src/components/sidebar/app-sidebar.tsx` | 3 | `import { ..., Boxes, ... }` | `import { ..., LayoutGrid, ... }` |
| `src/components/sidebar/app-sidebar.tsx` | 79 | `<Boxes />` | `<LayoutGrid />` |

**Implementation:**
```tsx
// Import
import { LayoutGrid } from 'lucide-react';

// Usage (same className as before)
<LayoutGrid className="size-6 text-muted-foreground" />
```

---

## 2. Workspace Filtering for Apps (Major Feature)

**Issue:** Apps need workspace filtering similar to chat history. Currently, apps are shown without workspace context. We need:
1. A toggle between "This workspace" and "All workspaces"
2. Workspace badges on app cards when viewing all workspaces
3. Workspace switching prompts when interacting with apps from other workspaces

### Reference Implementation

The chat history page already implements this pattern. Use these files as your guide:

| Component | Reference File | Purpose |
|-----------|----------------|---------|
| Filter state & logic | `src/app/(app)/history/history-client.tsx` | Main client with filter state |
| Tabs toolbar | `src/components/history/chats-toolbar.tsx` | "This workspace" / "All workspaces" tabs |
| Workspace badge | `src/components/history/chat-row.tsx` (lines 190-208) | Conditional workspace badge |
| Switch dialog | `src/components/history/switch-workspace-dialog.tsx` | Workspace switch confirmation |
| Server actions | `src/lib/server-actions/thread.ts` | `getThreadsPage` vs `getThreadsPageAllWorkspaces` |

### 2.1 Add Filter State

**In `apps-client.tsx`:**
```tsx
const [filter, setFilter] = useState<'this-workspace' | 'all-workspaces'>('this-workspace');

const handleFilterChange = useCallback(
  (value: 'this-workspace' | 'all-workspaces') => {
    setFilter(value);
    refreshApps(value);  // Fetch with new filter
  },
  [refreshApps]
);
```

### 2.2 Add Toolbar with Tabs

Create a toolbar component (or add to existing UI) with the filter tabs. Reference `chats-toolbar.tsx`:

```tsx
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

<Tabs value={filter} onValueChange={(v) => onFilterChange(v as 'this-workspace' | 'all-workspaces')}>
  <TabsList variant="line">
    <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
    <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
  </TabsList>
</Tabs>
```

### 2.3 Workspace Badge on AppCard

When viewing "All workspaces", show a workspace badge on apps that are NOT in the current workspace.

**In `AppCard.tsx`, add props:**
```tsx
interface AppCardProps {
  // ... existing props
  showWorkspaceBadge?: boolean;
  workspace?: { id: string; name: string; avatar: { color: string; content: string } } | null;
  currentWorkspaceId?: string;
}
```

**Conditional badge rendering (reference `chat-row.tsx` lines 190-208):**
```tsx
const workspaceBadge = showWorkspaceBadge && workspace ? (
  <Badge
    variant="secondary"
    className="gap-1 pl-1 pr-2 text-[10px] text-muted-foreground max-w-[140px] min-w-0 shrink justify-start"
  >
    <Avatar size="xs">
      <AvatarFallback
        content={workspace.avatar.content}
        style={{
          backgroundColor: workspace.avatar.color,
          color: getContrastTextColor(workspace.avatar.color),
        }}
      >
        {workspace.avatar.content}
      </AvatarFallback>
    </Avatar>
    <span className="truncate min-w-0">{workspace.name}</span>
  </Badge>
) : null;
```

**Pass the badge conditionally:**
```tsx
showWorkspaceBadge={
  Boolean(
    filter === 'all-workspaces' &&
    currentWorkspaceId &&
    app.workspace_id !== currentWorkspaceId
  )
}
```

### 2.4 Server Actions for Workspace-Filtered Apps

**Current:** `getOrgApps()` in `src/lib/server-actions/apps.ts`

**Need to add:** `getOrgAppsAllWorkspaces()` - similar pattern to `getThreadsPageAllWorkspaces()` in `src/lib/server-actions/thread.ts`

The apps already have `workspace_id` in the schema, so filtering should work. You'll need:

1. **This workspace:** Filter apps by current workspace
2. **All workspaces:** Get apps from all accessible workspaces (use `listUserWorkspaces` to get accessible workspace IDs, filter by `access_level !== 'none'`)

### 2.5 Handle Workspace Switching (Chat Button)

When a user clicks "Chat" on an app from a different workspace, we need to prompt them to switch workspaces first (since the app's source directory is in that workspace).

**For now, add a FIXME placeholder:**

```tsx
const handleStartChat = (app: WorkerScriptWithCreator) => {
  // FIXME: Check if app.workspace_id !== currentWorkspaceId
  // If different workspace, show SwitchWorkspaceDialog before proceeding
  // Reference: history-client.tsx handleOpenThread() lines 238-269

  // For now, just show a toast or log
  console.log('Start chat with app:', app.script_name, 'workspace:', app.workspace_id);
};
```

**Later implementation will:**
1. Check if `app.workspace_id !== currentWorkspaceId`
2. If different, show `SwitchWorkspaceDialog` with target workspace
3. After user confirms, switch workspace and then start the chat

### 2.6 Detect Workspace Changes

When the user switches workspaces while on the Apps tab, the app list should update accordingly.

**In `apps-client.tsx`, add effect to watch for workspace changes:**
```tsx
const { currentWorkspace } = useAuth();

useEffect(() => {
  // Re-fetch apps when workspace changes (if filtering by "this workspace")
  if (filter === 'this-workspace') {
    refreshApps('this-workspace');
  }
}, [currentWorkspace?.id, filter, refreshApps]);
```

Reference: `history-client.tsx` does similar workspace change detection.

---

## Summary of Changes

| Item | File(s) to Modify | Priority |
|------|-------------------|----------|
| Icon change (Boxes → LayoutGrid) | `apps-client.tsx`, `app-sidebar.tsx` | Quick fix |
| Filter state + tabs | `apps-client.tsx` | Core feature |
| Workspace badge on AppCard | `AppCard.tsx` | Core feature |
| Server actions for filtering | `src/lib/server-actions/apps.ts` | Core feature |
| Workspace switch prompt (FIXME) | `apps-client.tsx` | Placeholder for now |
| Workspace change detection | `apps-client.tsx` | Core feature |

---

## Files to Reference

**Chat history implementation (your guide):**
- `src/app/(app)/history/history-client.tsx` - Main pattern to follow
- `src/components/history/chats-toolbar.tsx` - Tabs filter UI
- `src/components/history/chat-row.tsx` - Workspace badge styling
- `src/components/history/switch-workspace-dialog.tsx` - Dialog (can be reused)
- `src/lib/server-actions/thread.ts` - Server action patterns

**Files to modify:**
- `src/app/(app)/apps/apps-client.tsx` - Main changes
- `src/app/(app)/apps/AppCard.tsx` - Add workspace badge
- `src/components/sidebar/app-sidebar.tsx` - Icon change
- `src/lib/server-actions/apps.ts` - Add workspace filtering

---

## Notes

1. **Apps already have `workspace_id`** - The `worker_scripts` table stores `workspace_id` for each app, so filtering is possible.

2. **Reuse existing components** - The `SwitchWorkspaceDialog` component can be reused or imported from the history module.

3. **AuthContext integration** - Use `useAuth()` to get `currentWorkspace`, `workspaces`, and `switchWorkspace()`.

4. **The Chat button FIXME** - For now, just add a FIXME comment. The actual workspace switching logic can be implemented later when the chat-with-app feature is complete.
