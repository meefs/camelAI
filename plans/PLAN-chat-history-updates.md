# Chat History Page Updates Plan

## Overview

This plan details updates to the chat history page to improve the UX around workspace context. Since threads are now stored at the org level but are still tied to specific workspaces, users need clear visibility into which workspace each thread belongs to and seamless navigation when clicking into threads from different workspaces.

## Goals

1. Add workspace filter tabs below the search bar
2. Display workspace badges on threads from other workspaces
3. Show a workspace-switch confirmation modal when clicking a thread from a different workspace
4. Replace computed author initials with actual user avatars

---

## 1. Workspace Filter Tabs

### Location
Add tabs between the search input and the controls row in `ChatsToolbar`.

### UI Design
Use the existing `Tabs` component with the default (pill) variant:

```tsx
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

<Tabs defaultValue="this-workspace" value={filter} onValueChange={onFilterChange}>
  <TabsList>
    <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
    <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
  </TabsList>
</Tabs>
```

### Files to Modify

#### [chats-toolbar.tsx](src/components/history/chats-toolbar.tsx)
- Add `filter` and `onFilterChange` props to interface
- Insert `Tabs` component between search input and controls row
- Add imports for Tabs components

#### [history-client.tsx](src/app/(app)/history/history-client.tsx)
- Add state: `const [filter, setFilter] = useState<'this-workspace' | 'all-workspaces'>('this-workspace')`
- Pass `filter` and `onFilterChange={setFilter}` to `ChatsToolbar`
- Fetch logic should change based on filter (see Section 5)

---

## 2. Backend: Fetch Threads Across All Workspaces

### New RPC Method
Add to [rpc-service.ts](workers/main/src/rpc-service.ts):

```typescript
async getThreadsAllWorkspaces(
  workspaceIds: string[],
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  // Query threads WHERE workspace_id IN (workspaceIds)
  // ORDER BY updated_at DESC with pagination
}
```

### New chat-do Function
Add to [chat-do.ts](src/lib/chat-do.ts):

```typescript
export async function getThreadsPaginatedAllWorkspaces(
  workspaceIds: string[],
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  return withRpc((rpc) => rpc.getThreadsAllWorkspaces(workspaceIds, params));
}
```

### New Server Action
Add to [thread.ts](src/lib/server-actions/thread.ts):

```typescript
export async function getThreadsPageAllWorkspaces(
  params: { offset?: number; limit?: number } = {}
) {
  const session = await requireSession();
  // Get all workspace IDs user has access to in current org
  const workspaces = await authDO.getWorkspacesByOrg(session.org_id, session.user_id);
  const accessibleIds = workspaces
    .filter(w => w.access_level !== 'none')
    .map(w => w.id);

  if (accessibleIds.length === 0) {
    return { items: [], total: 0, offset: 0, limit: params.limit ?? 50 };
  }

  const page = await chatDO.getThreadsPaginatedAllWorkspaces(accessibleIds, params);
  const hydratedItems = await hydrateThreads(page.items);
  return toSerializable({ ...page, items: hydratedItems });
}
```

### OrgDO SQL Query
Add to [auth.ts](workers/main/src/auth.ts) in OrgDO class:

```typescript
getThreadsAllWorkspacesPaginated(
  workspaceIds: string[],
  offset = 0,
  limit = 50
): { items: OrgThread[]; total: number; offset: number; limit: number } {
  const placeholders = workspaceIds.map(() => '?').join(',');

  const countResult = this.sql
    .exec(`SELECT COUNT(*) as count FROM threads WHERE workspace_id IN (${placeholders})`, ...workspaceIds)
    .toArray()[0] as { count: number };

  const items = this.sql
    .exec(
      `SELECT * FROM threads WHERE workspace_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ...workspaceIds,
      limit,
      offset
    )
    .toArray() as OrgThread[];

  return { items, total: countResult.count, offset, limit };
}
```

---

## 3. Workspace Badge on Chat Row

### Design
- Only show badge when viewing "All workspaces" AND thread is from a different workspace than current
- Use the workspace avatar (small colored circle with initials/emoji) + workspace name as a subtle tag
- Position: inline after the thread title, or in the metadata row

### UI Component Pattern
Create a small inline badge component or add inline to ChatRow:

```tsx
// In ChatRow, after title
{showWorkspaceBadge && workspace && (
  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground ml-2">
    <span
      className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium shrink-0"
      style={{
        backgroundColor: workspace.avatar.color,
        color: getContrastTextColor(workspace.avatar.color),
      }}
    >
      {workspace.avatar.content}
    </span>
    <span className="truncate max-w-[100px]">{workspace.name}</span>
  </span>
)}
```

### Props to Add
- `ChatRow` needs: `workspace?: Workspace` and `showWorkspaceBadge?: boolean`
- `ChatsList` needs to pass these through
- `HistoryClient` needs to pass `currentWorkspaceId` and the workspace map

### Workspace Data
The `Thread` type already has `workspace_id`. We need to enrich with workspace info:
- In `history-client.tsx`, get `workspaces` from `useAuth()`
- Create a map: `const workspaceMap = new Map(workspaces.map(w => [w.id, w]))`
- Pass to ChatRow: `workspace={workspaceMap.get(thread.workspace_id)}`
- Compute `showWorkspaceBadge={filter === 'all-workspaces' && thread.workspace_id !== currentWorkspace?.id}`

---

## 4. Workspace Switch Modal

### Behavior
When a user clicks a thread that belongs to a different workspace than the current one:
1. Prevent navigation
2. Show a modal asking to switch workspaces
3. On confirm: switch workspace, then navigate to the chat
4. On cancel: close modal, stay on history page

### UI Component
Create new file: `src/components/history/switch-workspace-dialog.tsx`

```tsx
'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Workspace } from '@/types';
import { getContrastTextColor } from '@/lib/avatar';

interface SwitchWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  onConfirm: () => void;
  loading?: boolean;
}

export function SwitchWorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  onConfirm,
  loading,
}: SwitchWorkspaceDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This chat belongs to a different workspace. Switch to{' '}
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <span
                className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium"
                style={{
                  backgroundColor: workspace.avatar.color,
                  color: getContrastTextColor(workspace.avatar.color),
                }}
              >
                {workspace.avatar.content}
              </span>
              {workspace.name}
            </span>{' '}
            to continue this conversation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={loading}>
            {loading ? 'Switching...' : 'Switch workspace'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

### Integration in history-client.tsx

```tsx
// State
const [switchDialog, setSwitchDialog] = useState<{
  open: boolean;
  threadId: string | null;
  workspace: Workspace | null;
}>({ open: false, threadId: null, workspace: null });
const [switchingWorkspace, setSwitchingWorkspace] = useState(false);

// Handler
const handleOpenThread = async (id: string) => {
  const thread = threads.find(t => t.id === id);
  if (!thread) return;

  // If same workspace or no current workspace, navigate directly
  if (!currentWorkspace || thread.workspace_id === currentWorkspace.id) {
    router.push(`/chat/${id}`);
    return;
  }

  // Different workspace - show dialog
  const targetWorkspace = workspaceMap.get(thread.workspace_id);
  if (!targetWorkspace) {
    // Fallback: navigate anyway
    router.push(`/chat/${id}`);
    return;
  }

  setSwitchDialog({ open: true, threadId: id, workspace: targetWorkspace });
};

const handleConfirmSwitch = async () => {
  if (!switchDialog.workspace || !switchDialog.threadId) return;

  setSwitchingWorkspace(true);
  try {
    await switchWorkspace(switchDialog.workspace.id);
    router.push(`/chat/${switchDialog.threadId}`);
  } catch (error) {
    console.error('Failed to switch workspace:', error);
  } finally {
    setSwitchingWorkspace(false);
    setSwitchDialog({ open: false, threadId: null, workspace: null });
  }
};

// Render dialog
<SwitchWorkspaceDialog
  open={switchDialog.open}
  onOpenChange={(open) => !open && setSwitchDialog({ open: false, threadId: null, workspace: null })}
  workspace={switchDialog.workspace!}
  onConfirm={handleConfirmSwitch}
  loading={switchingWorkspace}
/>
```

---

## 5. User Avatar Display

### Current Implementation
[chat-row.tsx](src/components/history/chat-row.tsx) lines 59-66 compute initials from creator name/email:

```tsx
function getInitials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}
```

### Required Change
Use the actual `thread.creator.avatar` object which contains `{ color, content }`:

```tsx
// Import
import { getContrastTextColor } from '@/lib/avatar';

// In component - replace AvatarFallback usage
const creatorAvatar = thread.creator?.avatar;
const creatorLabel = getCreatorLabel(thread.creator?.name, thread.creator?.email);

// Render
<Avatar size="xs">
  <AvatarFallback
    style={{
      backgroundColor: creatorAvatar?.color ?? undefined,
      color: creatorAvatar?.color ? getContrastTextColor(creatorAvatar.color) : undefined,
    }}
  >
    {creatorAvatar?.content ?? (creatorLabel ? getInitials(creatorLabel) : '?')}
  </AvatarFallback>
</Avatar>
```

This displays the user's actual avatar (custom initials/emoji with their chosen color) rather than computed initials.

---

## 6. Data Flow Updates

### Thread Type Enhancement
The existing `Thread` type already includes `workspace_id` and optional `creator?: User`. The `User` type includes `avatar: Avatar`. No type changes needed.

### Hydration
The existing `hydrateThreads()` function in thread.ts already populates `creator` with full User data including avatar. No changes needed.

### history-client.tsx Data Requirements
```tsx
const { currentWorkspace, workspaces, switchWorkspace } = useAuth();

// Build workspace lookup map
const workspaceMap = useMemo(
  () => new Map(workspaces?.map(w => [w.id, w]) ?? []),
  [workspaces]
);
```

---

## 7. Implementation Order

1. **Backend first**: Add `getThreadsAllWorkspacesPaginated` to OrgDO, RPC service, chat-do, and server action
2. **User avatar**: Update ChatRow to use actual avatar colors/content
3. **Filter tabs**: Add tabs UI and state to toolbar and history-client
4. **Workspace badge**: Add badge to ChatRow for threads from other workspaces
5. **Switch dialog**: Create dialog component and integrate into handleOpenThread

---

## 8. Files Summary

| File | Changes |
|------|---------|
| `workers/main/src/auth.ts` | Add `getThreadsAllWorkspacesPaginated()` method to OrgDO |
| `workers/main/src/rpc-service.ts` | Add `getThreadsAllWorkspaces()` RPC method |
| `src/lib/chat-do.ts` | Add `getThreadsPaginatedAllWorkspaces()` function |
| `src/lib/server-actions/thread.ts` | Add `getThreadsPageAllWorkspaces()` server action |
| `src/components/history/chats-toolbar.tsx` | Add filter tabs UI |
| `src/components/history/chat-row.tsx` | Use real avatar, add workspace badge |
| `src/components/history/chats-list.tsx` | Pass workspace data to ChatRow |
| `src/app/(app)/history/history-client.tsx` | Add filter state, workspace switch logic, dialog |
| `src/components/history/switch-workspace-dialog.tsx` | New file - workspace switch confirmation dialog |

---

## 9. Testing Considerations

- Verify "This workspace" only shows threads for current workspace
- Verify "All workspaces" shows threads from all accessible workspaces
- Verify workspace badge only appears on "All workspaces" tab for non-current workspace threads
- Verify clicking a thread from another workspace shows the switch dialog
- Verify switching workspace then navigating works correctly
- Verify user avatars display with correct colors and content
- Verify pagination works correctly in both filter modes
- Verify search works correctly in both filter modes
