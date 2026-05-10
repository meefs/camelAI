# Chat Groups Plan

**Date:** 2026-05-07
**Branch:** `illianaa/budapest`
**Scope:** Introduce chat groups — lightweight, per-user, in-workspace folders for chats — surfaced through a new sidebar list and a chat tab bar above the chat content. Add status indicators that propagate from chat → group → workspace switcher avatar. The preview panel and the existing per-thread split are unchanged.

> **Important:** the prior `docs/ux-rehaul-v1-chat-owned-preview.md` and `docs/ux-rehaul-v2-independent-preview.md` documents proposed a *different* model (workspace-accordion sidebar with shared "projects"). This plan supersedes that direction. The workspace switcher stays at the top of the sidebar, groups are **per-user**, and the preview panel is **unchanged from production**.

---

## 1. Objective

Workspaces are identity (org + access). Chat groups are an organizing affordance for chats *inside* the active workspace — closer to browser tab groups than to projects. Today, chats are flat: a user lands on the workspace, opens one thread at a time, and uses Chat History to switch. We're adding:

1. A **sidebar list of chat groups** (replacing nothing — sits between the workspace switcher and the existing nav items).
2. A **chat tab bar** above the chat content showing the open chats inside the active group, with `+`, a closed-chats popover, and a `⋯` settings menu (rename only, in v1).
3. **Per-user** group state (UserDO-backed) so multiplayer chats keep working without forcing one user's organization on another.
4. **Status indicators** (spinner / solid green / none) that cascade from individual chats up to chat groups (sidebar) and the workspace switcher avatar.
5. **Drag-and-drop** + a right-click "Move to group…" affordance for relocating a chat between groups.

Out of scope, by spec: shared/snapshot groups, pinning, color-coding, multi-select, restoring a closed group as a unit, group-level settings beyond rename.

---

## 2. Current State (one-screen recap)

```
┌──────────────────────┐
│ [Workspace switcher] │  src/components/sidebar/workspace-switcher.tsx
│ Beta                 │  (DropdownMenu, no status indicator)
│                      │
│ 🏠 New Chat          │  src/components/sidebar/app-sidebar.tsx (flat list)
│ 🖥  Computer          │
│ 💬 Chat History      │
│ 🔌 Connections       │
│ 🗂  Apps              │
│ ──────────────────── │
│ ❓ Get Help          │
│ 👤 User              │
└──────────────────────┘
```

- **Sidebar:** `app-sidebar.tsx` renders a flat `SidebarMenu` (lines 56-97). `WorkspaceSwitcher` at top is a `DropdownMenu` listing workspaces grouped by org with no avatar status indicator.
- **Chat:** `src/components/Chat.tsx` renders a `ResizablePanelGroup` with chat on the left and the preview panel on the right. Per-thread preview state (`previewTabs`, `previewActiveTabId`, `previewTarget`) lives in `ChatThreadDO` (`workers/main/src/durable-objects.ts:170-180`, persisted via `ctx.storage.kv`). **Keep this exactly as it is.**
- **Routes:** `chat/:id` → `_app.chat.$id.tsx`. `chat` → `_app.chat._index.tsx` (welcome). No tab bar exists today.
- **Schema:** OrgDO has a `threads` table (`workers/main/src/auth.ts:1253-1262`, schema V22) with `id, workspace_id, title, model, created_by, created_at, updated_at, source, first_user_message`. **No** `project_id` / `chat_group_id` / fork-metadata columns. The threads table stays untouched.
- **UserDO:** SQLite + KV at schema V8 (`workers/main/src/auth.ts:420-577`). `orgs` table tracks per-org `last_workspace_id`. This is where chat group state will live.
- **Fork API:** already shipped at `POST /api/workspaces/:id/chat/:threadId/fork` (`src/routes/api/workspaces.$id.chat.$threadId.fork.ts`). Returns the new thread; copies the source thread's fork-state snapshot. We'll layer a tiny client-side step on top so a forked chat lands in the **current group**.
- **Drag/drop primitives:** none imported. Native HTML drag-and-drop is already used in `computer-page-content.tsx` — reuse that pattern.
- **shadcn primitives available:** `sidebar`, `dropdown-menu`, `context-menu`, `popover`, `tooltip`, `tabs`, `collapsible`, `resizable`, `dialog`, `command`, `badge`, `avatar`. All confirmed under `src/components/ui/`.

---

## 3. Target Layout

```
┌──────────────────┬────────────────────────────────────────────────────────────────┐
│ [WS] Workspace ▾ │                                                                │
│      Org name    │   ┌─────────────┬───────────┬──────┬───┬───┬───┐              │
│                  │   │● Build dsh ✎│ API ept   │ Fix ●│ + │ ⌄ │ ⋯ │              │
│ + New chat       │   └─────────────┴───────────┴──────┴───┴───┴───┘              │
│                  │   ↑ active     ↑ inactive  ↑ run  ↑   ↑     ↑                │
│ CHAT GROUPS      │                                       closed settings          │
│ ▸ ● Build dsh    │   ┌──────────────────────────┬──────────────────────────────┐ │
│   Marketing  ×   │   │                          │                              │ │
│   Customer ops   │   │  Chat messages           │  Preview panel               │ │
│                  │   │  (existing component)    │  (existing — unchanged       │ │
│ ──────────────── │   │                          │   per-thread state in        │ │
│ 🖥  Computer      │   │                          │   ChatThreadDO)              │ │
│ 💬 Chat History  │   │                          │                              │ │
│ 🔌 Connections   │   │  ┌───────────────────────┴────────┐                     │ │
│ 🗂  Apps          │   │  │ Context: API endpoints         │                     │ │
│                  │   │  ├─────────────────────────────────┤                     │ │
│ ──────────────── │   │  │ Message...               [Send] │                     │ │
│ ❓ Get Help      │   │  └─────────────────────────────────┘                     │ │
│ 👤 User          │   └──────────────────────────────────────────────────────────┘ │
└──────────────────┴────────────────────────────────────────────────────────────────┘

Status legend (used at all three levels):
  ●   spinner (blue, animate-pulse)   = agent working
  ●   solid green dot                 = completed run, awaiting review by *this user*
  (no dot)                            = idle
```

Three things to notice:

- The workspace switcher **stays where it is**. It does not turn into an accordion. We just teach its avatar to show a status dot.
- "New chat" is now its own button just below the switcher. It enters the existing welcome screen with no persisted writes; the first send creates *a new chat in a new group*. The `+` in the tab bar creates a placeholder in *the current group* until first send. Same affordance, different scope.
- The chat tab bar lives **above** the existing `ResizablePanelGroup`. It does not replace, swap with, or otherwise touch the preview panel.

---

## 4. Conceptual Model

| Concept | Scope | Persistence | Notes |
|---|---|---|---|
| Workspace | Org-shared | OrgDO `workspaces` | unchanged |
| Thread (chat) | Org-shared | OrgDO `threads` | unchanged |
| Chat group | **Per-user**, per-workspace | `UserDO` SQLite + KV | new |
| Group membership | **Per-user** | `UserDO` | the same thread can be in different groups for different users |
| Tab bar open/closed/order | **Per-user**, per-group | `UserDO` (canonical) + `sessionStorage` (placeholder-only restore) | "closed" still keeps the chat reachable from group's closed-chats popover |
| Last-viewed thread (for unread dot) | **Per-user**, per-thread | `UserDO` | timestamp |

Because groups are per-user, *no* schema changes are needed on threads. A chat that exists for everyone in the workspace can be in different groups per teammate, or have no materialized group yet for a teammate who has never opened it.

**Important backend boundary:** group state lives in `UserDO`, while threads live in `OrgDO`. There is no cross-Durable-Object SQL transaction. Anywhere this plan says "create thread + group" means a recoverable write sequence with idempotent/compensating cleanup, not a literal atomic database transaction across DOs. Atomicity is only available inside one DO, via `this.ctx.storage.transactionSync(...)`.

### Close vs delete

- **Close a tab** → tab disappears from the bar; chat moves into the group's "closed chats" popover; chat still exists, still listed in Chat History. Reversible from the popover.
- **Close a group** → group disappears from the sidebar; its member chats lose their materialized grouping for this user until reopened. Closed-tabs lists are dropped (we do not remember which chats were grouped together — see §11). The chats themselves are untouched and remain in Chat History.
- **Delete a chat** → existing Chat History delete behavior, plus actor-side group-membership cleanup and lazy stale-row pruning for other users.

---

## 5. Data Model

### 5.1 UserDO migration (new schema version V9)

```sql
-- chat groups, scoped to (user, org, workspace)
CREATE TABLE IF NOT EXISTS chat_groups (
  id TEXT PRIMARY KEY,                    -- crypto.randomUUID(), matching repo convention
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',          -- empty until first chat auto-titles
  last_active_thread_id TEXT,             -- where sidebar click should land
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_groups_workspace
  ON chat_groups(org_id, workspace_id, updated_at DESC);

-- one row per (user, group, thread) — exactly one group per thread per user
CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1,     -- 1 = in tab bar, 0 = in closed-chats popover
  position INTEGER NOT NULL DEFAULT 0,    -- tab order when is_open=1
  closed_at INTEGER,                      -- null while open
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, thread_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_group_members_thread
  ON chat_group_members(thread_id);       -- enforces "one group per thread per user"
CREATE INDEX IF NOT EXISTS chat_group_members_open
  ON chat_group_members(group_id, is_open, position);

-- last-viewed timestamps for the "completed-awaiting-review" indicator
CREATE TABLE IF NOT EXISTS chat_thread_views (
  thread_id TEXT PRIMARY KEY,
  viewed_at INTEGER NOT NULL
);
```

Bump `CURRENT_SCHEMA_VERSION` in `UserDO.migrate` (`workers/main/src/auth.ts:573`) from 8 → 9 and add the `if (version < 9) { ... }` block.

Do **not** depend on SQLite foreign-key cascades for correctness; this codebase does not currently rely on `PRAGMA foreign_keys = ON`. Keep the `REFERENCES` clause if useful for documentation, but `closeChatGroup`, `moveThreadToGroup`, and stale-thread cleanup should explicitly delete `chat_group_members` rows inside `transactionSync`.

### 5.2 No OrgDO changes

The `threads` table is **not** modified. Group membership is purely UserDO state. A persisted thread can technically exist without a UserDO membership row (legacy threads, after closing a group, or after a partial failure), but the product should never render an opened chat surface without first calling `ensureGroupForThread`.

When a group is closed, no OrgDO cleanup is needed. When a thread is deleted from Chat History, remove the acting user's membership immediately and lazily prune stale memberships for other users when their group lists are hydrated. There is no practical way to enumerate every user's UserDO synchronously on thread delete.

### 5.3 New types (`src/types.ts` or a sibling file)

```ts
export interface ChatGroup {
  id: string;
  org_id: string;
  workspace_id: string;
  name: string;
  last_active_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChatGroupMember {
  group_id: string;
  thread_id: string;
  is_open: boolean;
  position: number;
  closed_at: number | null;
}

export interface ChatGroupSummary extends ChatGroup {
  open_thread_ids: string[];      // ordered, used to render the tab bar
  closed_thread_ids: string[];    // surfaced in the popover
}

export type ThreadStatus = 'idle' | 'running' | 'unread';
```

`ThreadStatus` mirrors the visual states (none / spinner / solid green dot).

### 5.4 UserDO RPC surface (new)

Add to `UserDO` in `workers/main/src/auth.ts`:

```ts
listChatGroups(orgId: string, workspaceId: string, opts?: { limit?: number }): ChatGroupSummary[];
//   default limit 10, ordered by updated_at desc; sidebar always passes the default
listChatGroupsForMove(orgId: string, workspaceId: string): ChatGroup[];
//   no 10-row limit; used only by "Move to group..." menus
createChatGroup(orgId: string, workspaceId: string, opts?: { name?: string; lastActiveThreadId?: string }): ChatGroup;
//   internal-only: invoked inside UserDO transactions for group/membership writes; never exposed
//   to the client as a standalone "create empty group" action
renameChatGroup(groupId: string, name: string): void;
closeChatGroup(groupId: string): void;                                  // explicitly deletes group + member rows; threads lose grouping for this user

addThreadToGroup(groupId: string, threadId: string, opts?: { position?: number; reopenIfClosed?: boolean }): void;
moveThreadToGroup(threadId: string, targetGroupId: string, opts?: { position?: number }): void;
moveThreadToNewGroup(orgId: string, workspaceId: string, threadId: string, opts?: { name?: string }): { group: ChatGroup };
//   in the same transaction, if the source group is now empty, delete it
closeThreadTab(threadId: string): void;                                  // is_open = 0
reopenThreadTab(threadId: string, opts?: { position?: number }): void;   // is_open = 1
reorderThreadTabs(groupId: string, orderedIds: string[]): void;
setGroupActiveThread(groupId: string, threadId: string): void;           // updates last_active_thread_id + updated_at

ensureGroupForThread(orgId: string, workspaceId: string, threadId: string, fallbackName: string): ChatGroupSummary;
//   used when a teammate opens a chat that has no group for this user yet (§9)
touchGroupForThread(threadId: string, at?: number): void;
//   bump chat_groups.updated_at for the group that owns this thread for this user;
//   called from chat send/open actions to drive sidebar recency (§12.3)

forgetThreadView(threadId: string): void;
markThreadViewed(threadId: string, at?: number): void;
listThreadViews(threadIds: string[]): Record<string, number>;            // for unread calculations
removeThreadMembership(threadId: string): void;                          // actor-side cleanup when a thread is deleted
pruneMissingThreads(threadIds: string[]): void;                          // lazy cleanup after OrgDO hydration filters missing threads
```

Expose methods in the same async-compatible style as existing `UserDO` RPCs, but keep related SQL mutations inside `this.ctx.storage.transactionSync(...)` so each UserDO mutation is internally atomic.

### 5.5 Workspace and group status (server-derived)

For "agent currently working" we have two current streaming paths:

- `ChatThreadDO.setChatIsStreaming` (`durable-objects.ts:1969`) for the side-channel/legacy path.
- The direct runner bridge in `workers/main/src/routes/websocket.ts`, which currently sends `streaming_state` directly to the browser when a user message starts and when the runner emits `result` / `error` / `turn/completed`.

Do **not** treat `ChatThreadDO` as the only source of truth. Add one shared helper, e.g. `recordWorkspaceThreadStreaming(env, workspaceId, threadId, isStreaming)`, and call it from both paths.

1. **Per-thread:** `ChatThreadDO` already broadcasts to its own thread connection. The sidebar/tab bar are not connected to that DO. Don't try to reuse the per-thread WS — instead, fan out a low-volume *workspace-level* event:

   - On every streaming toggle, the shared helper calls `WorkspaceDO.recordThreadStreaming(threadId, isStreaming)`.
   - `WorkspaceDO` stores streaming rows in SQL/KV with `started_at` / `updated_at` (not only an in-memory `Set`) and broadcasts `{ type: 'thread_status', threadId, status: 'running' | 'idle' }` over a new workspace-level WebSocket.
   - The browser's app shell opens one workspace-level WS per active workspace. The sidebar/tab bar consume those events.
   - Add the status WebSocket as an explicit route such as `/ws/workspaces/:workspaceId/status`, registered before the generic `/ws/[^/]+` chat side-channel route. The existing `/ws/:workspace` route requires `threadId` and proxies to `ChatThreadDO`; do not overload it.

2. **Unread (solid green dot):** *client-derived*, no broadcast needed. A thread is `unread` when `thread.updated_at > viewed_at(thread, user)` AND the thread is not currently `running`. Mark viewed when:
   - the user is actively focused on that chat tab in the tab bar, **and**
   - the latest assistant turn has fully streamed.

Aggregation:

- **Group status** = highest-priority status across its open + closed members (`running` > `unread` > `idle`).
- **Workspace status** (avatar dot) = highest-priority status across *all* materialized groups in this workspace (visible top-10 *plus* older ones still in storage), plus the workspace-level streaming snapshot for any active legacy/unmaterialized thread.
- **Cross-workspace** roll-up isn't needed for v1 — the workspace switcher displays a dot for the *current* workspace's status. (Avatars in the dropdown for non-active workspaces use a small per-workspace status map computed in the layout loader; see §6.4.)

---

## 6. Sidebar Changes

**File:** `src/components/sidebar/app-sidebar.tsx` (modify, do not rewrite)

### 6.1 Layout

```
SidebarHeader
  WorkspaceSwitcher                            ← unchanged, but avatar gets status dot (§6.4)
  Beta badge                                    ← unchanged

SidebarContent
  SidebarGroup            "Primary"
    SidebarMenuItem  + New Chat                 ← MOVED here, used to live as "Home"
                                                 (navigates to /chat; first send creates group + chat — §6.2)

  SidebarGroup            "Chat groups"         ← NEW
    SidebarGroupLabel     "Chat Groups"
    SidebarMenu
      <ChatGroupsList />                        ← new component (§6.3)
                                                 top 10 by recency; no scroll

  SidebarGroup            "Workspace"           ← unchanged items, regrouped
    SidebarMenuItem  Computer
    SidebarMenuItem  Chat History
    SidebarMenuItem  Connections
    SidebarMenuItem  Apps

SidebarFooter                                   ← unchanged
  Get Help
  NavUser
```

The "Home" route at `/` keeps existing behavior but is no longer reachable via a sidebar item — sidebar's "+ New Chat" navigates to `/chat` (welcome) and creates a new group on first send (§7.4).

### 6.2 "+ New Chat" button

A `SidebarMenuButton` directly under the workspace switcher and above the chat groups list (so it sits "next to the chat groups").

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    onClick={handleNewChat}
    tooltip="New chat"
    className="font-medium"
  >
    <Plus />
    <span>New chat</span>
  </SidebarMenuButton>
</SidebarMenuItem>
```

`handleNewChat` simply navigates to `/chat`. **No group or thread is created yet** — the user might never send a message, in which case nothing is written. The welcome screen renders with **no chat tab bar visible** because no group is active, and no group row is highlighted in the sidebar.

On first send, the welcome screen's action handler runs a recoverable write sequence:

1. Creates the OrgDO thread via the existing `chatDO.createThread(...)` path.
2. Creates the UserDO group and membership in one `transactionSync` block.
3. Stores `last_active_thread_id = thread.id` so the sidebar row can route back to it.
4. Returns `{ groupId, threadId }`; the client navigates to `/chat/:threadId`.

If step 2 fails after the thread is created, the action should either delete the just-created thread before returning an error, or return a response that lets `/chat/:threadId` recover by calling `ensureGroupForThread`. Do not call this cross-DO sequence "atomic" in code comments.

After navigation the new group sits at the top of the sidebar (most recent), is highlighted, and the tab bar appears with the new chat as its only tab. This matches the conceptual rule: a chat doesn't exist until a message is sent, and once it is opened in the chat surface, it has a group for that user.

### 6.3 `<ChatGroupsList />` (new component)

**File:** `src/components/sidebar/chat-groups-list.tsx`

```
┌────────────────────────────┐
│ ▸ ● Build dashboard      × │  ← active group, expanded chevron, status dot, hover ×
│   Marketing                │
│   Customer ops           × │  ← hover state revealing close
└────────────────────────────┘
```

**Props:**

```ts
interface ChatGroupsListProps {
  groups: ChatGroupSummary[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onMoveThreadToGroup?: (threadId: string, targetGroupId: string) => void;  // drop target
}
```

**Composition (shadcn):**

| Element | Primitive | Notes |
|---|---|---|
| Wrapper | `SidebarMenu` | inside its own `SidebarGroup` with label "Chat groups" |
| Each row | `SidebarMenuItem` + `SidebarMenuButton` | `isActive={group.id === activeGroupId}` |
| Hover close | `<SidebarMenuAction>` (already used elsewhere) | `<X className="size-3" />`, AlertDialog confirm if group has ≥2 chats |
| Status dot | shared `<ThreadStatusDot status={...} />` | see §8 |
| Drop target | native `onDragOver` / `onDrop` | accepts `application/x-camelai-thread-id` |
| Empty state | small muted "No groups yet" line | when `groups.length === 0` (e.g. first run) |

**Cap to 10 most-recent groups (no scrolling).** The list renders at most ten rows, ordered by `chat_groups.updated_at DESC`. Older groups remain in storage but are not visible in the sidebar — users get to those chats through Chat History (which always opens a thread in a brand-new group anyway, so they re-enter the recency window the moment they click). The data layer enforces this with a `LIMIT 10` in `listChatGroups`; the component does not need its own scroll container.

**Click behavior:**

- Click a group → navigate to `last_active_thread_id` when that member is still open; otherwise use the first open tab by `position`; otherwise open the most recently closed tab; if neither exists (degenerate), fall through to the welcome screen pre-bound to that group.
- The route stays `/chat/:id` for tab content; the *active group* is whatever group contains the active thread (looked up via `chat_group_members`). When the welcome screen is shown, the active group comes from a `?group=` param.

### 6.4 Workspace switcher status dot

**File:** `src/components/sidebar/workspace-switcher.tsx`

Adorn the trigger avatar with a dot that mirrors the **current workspace's** rolled-up status. Use a tiny ring placed on the avatar:

```tsx
<div className="relative">
  <Avatar size="default">{/* existing */}</Avatar>
  <ThreadStatusDot
    status={workspaceStatus}
    className="absolute -bottom-0.5 -right-0.5 ring-2 ring-sidebar"
  />
</div>
```

In the dropdown body, also render a status dot per non-current workspace, derived from a small loader-supplied roll-up `Record<workspaceId, ThreadStatus>` (see §10.2 for source). When idle, render no dot (empty `<span/>`) so the avatar layout is unchanged.

### 6.5 New shared component: `<ThreadStatusDot />`

**File:** `src/components/thread-status-dot.tsx`

```tsx
interface Props {
  status: ThreadStatus;
  className?: string;
}
export function ThreadStatusDot({ status, className }: Props) {
  if (status === 'idle') return null;
  return (
    <span
      aria-label={status === 'running' ? 'Agent is working' : 'New activity'}
      className={cn(
        'inline-block size-1.5 rounded-full shrink-0',
        status === 'running' && 'bg-blue-500 animate-pulse motion-reduce:animate-none',
        status === 'unread' && 'bg-emerald-500',
        className,
      )}
    />
  );
}
```

Wrap it in `<Tooltip>` at call sites where label affordance is wanted (e.g., on group rows: `"3 chats · 1 needs review"`).

---

## 7. Chat Tab Bar (new component)

**File:** `src/components/chat-tab-bar.tsx`

### 7.1 Layout

```
┌──────────────────┬──────────────┬─────────────┬─────┬─────┬─────┐
│ ● Build dsh ✎ × │  API ept × │ ● Fix layout × │  + │ ⌄  │ ⋯  │
└──────────────────┴──────────────┴─────────────┴─────┴─────┴─────┘
   ↑ active        ↑ inactive    ↑ running     +  closed  group ⋯
                                                  popover  menu
```

- Height: `h-10`. Uses the project's existing tab styling vocabulary (compare `src/components/preview-panel/` tab rows). Active tab: `bg-background border-b-2 border-primary text-foreground font-medium`. Inactive: `bg-muted/30 text-muted-foreground hover:text-foreground`.
- Each tab: `[status dot] [title] [pencil] [×]`. Pencil and × are `opacity-0 group-hover:opacity-100`. Pencil opens an inline rename input (`<Input size="xs" />`).
- Overflow: horizontally scrollable container (`overflow-x-auto`, `whitespace-nowrap`); no wrapping.
- Dragging a tab fires native `dragstart` with `dataTransfer.setData('application/x-camelai-thread-id', threadId)` so it can be dropped on the chat-groups list (§11).

### 7.2 Props

```ts
interface ChatTabBarProps {
  groupId: string;
  groupName: string;
  openTabs: Array<{ threadId: string; title: string; status: ThreadStatus }>;
  closedTabs: Array<{ threadId: string; title: string }>;
  activeThreadId: string | null;

  onSelectTab: (threadId: string) => void;
  onCloseTab: (threadId: string) => void;
  onRenameTab: (threadId: string, name: string) => void;
  onReorderTabs: (orderedThreadIds: string[]) => void;
  onNewTab: () => void;                                  // opens placeholder; first send creates chat in this group
  onReopenClosedTab: (threadId: string) => void;
  onRenameGroup: (name: string) => void;
}
```

### 7.3 Subcomponents

| Element | shadcn primitive |
|---|---|
| Tab row | plain `<button>` with `data-active` styling; **not** `<Tabs>` because we need bespoke drag/close affordances per tab. |
| `+` new tab | `<Button variant="ghost" size="icon-xs"><Plus /></Button>` |
| Closed-chats popover (`⌄`) | `<Popover>` with a `<Command>` search inside; lists closed tabs; click reopens. Hidden when `closedTabs.length === 0`. |
| Settings menu (`⋯`) | `<DropdownMenu>` with one item: "Rename group". Structured with a `DropdownMenuSeparator` placeholder so future items slot in cleanly. |
| Tab right-click | `<ContextMenu>` wrapping each tab — items: "Close tab", "Rename chat", `DropdownMenuSeparator`, "Move to group ▸" (submenu of other groups + "New group"). |

### 7.4 Wiring into the chat layout

**File:** `src/routes/_app.chat.$id.tsx`

The existing route renders `<Chat threadId=... />` inside the layout. Wrap that with the tab bar:

```tsx
<div className="flex h-full min-h-0 flex-col">
  <ChatTabBar {...tabBarProps} />
  <div className="min-h-0 flex-1">
    <Chat threadId={activeThreadId} workspaceId={workspaceId} />
  </div>
</div>
```

Rules:

- `<Chat>` is keyed on `activeThreadId` so it remounts on tab switch; this preserves the existing per-thread preview state (loaded from `ChatThreadDO` storage) without any change to `Chat.tsx`.
- Switching to a tab whose chat is in a different group is *not* possible from the tab bar — the bar only shows the active group. Switching groups via the sidebar swaps the bar wholesale.
- `onNewTab` navigates to `/chat?group=<activeGroupId>` and adds only a client-side placeholder tab. It does **not** create an OrgDO thread until first send.
- `onCloseTab` calls `closeThreadTab(threadId)` and (if the closed tab was active) navigates to the next remaining open tab; if none remain, navigates to `/chat?group=<groupId>` (group welcome).

### 7.5 Empty state for a brand-new chat (no thread yet)

A chat does not count as a real thread until the first user message is sent. Two entry points produce a "no thread yet" state, and they differ in whether a group already exists:

| Entry point | What renders | First-send behavior |
|---|---|---|
| **Sidebar "+ New chat"** (no group exists yet) | Existing welcome screen, identical to today. **No tab bar** is rendered (no active group). No row in the sidebar is highlighted. | Action handler creates thread, then creates group + membership in UserDO (§6.2). Client navigates to `/chat/:threadId`. The new group appears at the top of the sidebar, the tab bar appears with the new chat as its only tab. |
| **Tab bar `+`** (group already active) | Existing welcome screen, **with the tab bar still visible** showing the group's existing tabs. A transient "New chat" placeholder is rendered as the active tab — purely client-state, never persisted. | Action handler validates the group belongs to the current user/workspace, creates a thread, then adds membership in UserDO. The placeholder tab is replaced by the real auto-titled tab. If the user navigates away before sending, the placeholder is discarded silently with no DB writes. |

Per spec, the welcome screen's content stays **identical to today** in both cases. Empty-state iteration happens after groups ship and stabilize.

Implementation notes:

- The `/chat` route accepts `?group=:id` to bind first-send to an existing group (used by tab bar `+`). Absence of `?group=` means "create a new group on first send" (sidebar `+ New chat`). The route action should read the group from the URL and/or `formData.groupId`, because current `Chat.tsx` submit calls target the `/chat` action directly. Do not assume an existing `POST /api/workspaces/:id/chat/threads` route exists.
- The placeholder tab uses an in-memory id like `placeholder:<random>` so reordering and styling work the same way as for real tabs. It is not written to UserDO and is not part of `chat_group_members`.
- A user with multiple browser tabs open could create multiple placeholders in different windows; each first-send creates its own real tab independently. No cross-window coordination is needed because nothing is persisted until send.

---

## 8. Status Indicators

### 8.1 Single component, three placements

Use `<ThreadStatusDot />` (§6.5) in:

- **Tab bar tabs** — left of the title.
- **Sidebar group rows** — left of the group name.
- **Workspace switcher avatar** — bottom-right ring on the avatar.

### 8.2 Cascading rules

| Level | Source of `running` | Source of `unread` |
|---|---|---|
| Thread (tab) | `WorkspaceDO` thread-status broadcast fed by both ChatThreadDO and runner-bridge streaming toggles | `thread.updated_at > viewed_at(thread, user)` and not currently running |
| Group | any member thread is `running` | any member thread is `unread` |
| Workspace (switcher dot) | any materialized member thread is `running`, plus workspace streaming snapshot rows for legacy/unmaterialized threads | any materialized member thread is `unread` |

Priority: `running` > `unread` > `idle`. A row with both running and unread chats shows the spinner (running wins).

### 8.3 Mark-viewed semantics

- A thread is "viewed" when the user is on its tab AND the assistant's last turn has finished streaming. Until both conditions hold, the dot stays.
- Viewed timestamps update via `markThreadViewed(threadId)` UserDO RPC, called from the active chat's streaming-state handler when that thread is the active tab. In today's client, `streaming_state` can arrive from both the side-channel socket and the direct runner socket, so centralize the client-side "maybe mark viewed" logic instead of wiring it to only one socket.

### 8.4 Source of truth for "running"

`WorkspaceDO` already lives in `workers/main/src/workspace.ts`. Add:

```ts
recordThreadStreaming(threadId: string, isStreaming: boolean): void;
listStreamingThreadIds(): string[];
// status WS connections receive an initial snapshot and then broadcasts
// { type: 'thread_status', threadId, status }
```

`ChatThreadDO.setChatIsStreaming` (private method at `durable-objects.ts:1969`, called from lines 1723 / 2121 / 2617 / 2795 / 2812 / 2819) already emits a `set_chat_is_streaming` trace and broadcasts a `streaming_state` realtime event. Add the shared workspace-stub call there.

Also patch `workers/main/src/routes/websocket.ts`:

- right after the bridge sends `streaming_state: true` for a user message, call the shared helper with `true`;
- when the runner emits `error`, `result`, or `turn/completed`, call the helper with `false`;
- when the runner/client socket closes unexpectedly, clear the row with `false` in best effort.

Wrap all workspace-status writes in try/catch or `waitUntil(...catch(...))`; status failures must never crash a chat turn.

The browser layout opens one explicit workspace-level WS per active workspace, e.g. `/ws/workspaces/:workspaceId/status`. The route must validate workspace access with the Worker-side `requireWorkspaceAccess` helper, but does not require a `threadId`. Initial state is the snapshot returned by `listStreamingThreadIds()` on connect. Expire stale persisted streaming rows after a conservative TTL so a crash cannot leave a permanent spinner.

---

## 9. Sharing Model

Groups are per-user. Multiplayer chats keep working because *threads* remain in OrgDO and any teammate with workspace access can open them — the only thing per-user is the group state.

### 9.1 Auto-creating a group when a teammate opens a shared chat

When a user opens `/chat/:id`:

1. Loader calls `userDO.ensureGroupForThread(orgId, workspaceId, threadId, fallbackName=thread.title)`.
2. `ensureGroupForThread` either returns the existing membership or creates a brand-new group named after the thread, adds the thread as the only open tab, and returns it.
3. Sidebar + tab bar render against the user's view.

Renaming or closing a group is a UserDO mutation only — teammates are unaffected. Group ordering in the sidebar is recency-based, not manually reordered.

### 9.2 First-open auto-naming

When a chat in a previously empty (auto-created, name=`""`) group gets its first auto-title, mirror it onto the group. Add a UserDO helper like `renameEmptySingleThreadGroupForThread(threadId, title)` that only updates when:

- the current user has a membership for `threadId`,
- the owning group `name` is empty,
- the group has exactly one member.

Title generation currently happens in more than one place:

- `_app.chat._index.tsx` calls `chatDO.generateThreadTitle(...)` in `waitUntil` after first-send thread creation.
- `ChatThreadDO.generateThreadTitleFromMessage(...)` can update and broadcast a title in the side-channel path.
- `workers/main/src/routes/websocket.ts` updates thread metadata/title in the direct runner path.

Patch all title-update paths to call a shared "maybe auto-name group" helper with the acting `userId` when available. If `userId` is not available, skip the group rename; later `ensureGroupForThread` uses the current thread title as fallback when that user opens the chat. Other users who later open the chat land in their own auto-named group via §9.1.

---

## 10. Loaders, Actions, and APIs

### 10.1 New API routes

Add in `src/routes.ts` and create the corresponding files:

```
GET    api/chat-groups                                    list groups for active workspace (top 10)
PATCH  api/chat-groups/:id                                rename group
DELETE api/chat-groups/:id                                close group
POST   api/chat-groups/:id/members                        add thread (move into group)
DELETE api/chat-groups/:id/members/:threadId              close tab (is_open=0)
POST   api/chat-groups/:id/members/:threadId/reopen       reopen closed tab
POST   api/chat-groups/:id/reorder-tabs                   bulk reorder open tabs
POST   api/chat-groups/move-thread                        single-call UserDO-atomic move:
                                                          { threadId, targetGroupId | "new", name? }
                                                          if source group is now empty, delete it
POST   api/threads/:id/mark-viewed                        update chat_thread_views
PATCH  api/threads/:id                                    rename thread title from tab bar
```

There is **no** `POST /api/chat-groups` — groups are never created standalone. They are only created:

- as part of a thread-send action (sidebar `+ New chat` first-send, see §6.2),
- as part of a `move-thread` to `targetGroupId: "new"`,
- transparently via `ensureGroupForThread` when a thread is opened.

The existing thread-create path is the `_app.chat._index.tsx` route action at `/chat` (`intent=createThread`), not a dedicated `POST /api/workspaces/:id/chat/threads` API. Extend that action to accept either:

- `groupId?: string` — add the new thread to an existing group after validating it belongs to the current user/org/workspace.
- no `groupId` (or an explicit `createGroup: "1"`) — create a brand-new group and add the new thread.

The sidebar `+ New chat` first-send flow sends no `groupId`. The tab bar `+` first-send flow uses `?group=<activeGroupId>` and/or `groupId=<activeGroupId>` in form data. Keep this as one create path unless the implementation intentionally introduces a new JSON API and migrates all callers.

All write routes should use `requireSessionWorkspaceAccess(..., { requireWrite: true })` when possible, then verify the target group belongs to the authenticated user's current org/workspace and the target thread belongs to that same workspace in OrgDO. Cross-workspace moves are explicitly rejected (a chat cannot move to a group in a different workspace).

### 10.2 Loader changes

| Loader | Add |
|---|---|
| `src/routes/_app.tsx` | Load `chatGroups` for the **current workspace** (top 10 by recency) + the `Record<workspaceId, ThreadStatus>` roll-up for the workspace switcher dropdown. Pass to layout context. |
| `src/routes/_app.chat.$id.tsx` | Resolve the thread's group via `ensureGroupForThread` (and `touchGroupForThread` / `setGroupActiveThread` for recency), load that group's members + closed members, plus all threads' titles. Skip this entirely for `adminReadonly=1`; admin read-only views must not create personal group state for the admin. |
| `src/routes/_app.chat._index.tsx` | Welcome screen. Accepts `?group=:id` for the tab-bar-`+` flow (first-send adds to that group). When `?group=` is absent (sidebar `+ New chat` flow), first-send creates a brand-new group and membership after creating the thread, with compensation/recovery for partial failure. No group is created until the user actually sends. |

The roll-up `Record<workspaceId, ThreadStatus>` is computed from `WorkspaceDO.listStreamingThreadIds()` (cheap) plus a UserDO query for unread thread counts per workspace.

Current `_app.tsx.shouldRevalidate` returns `false` for `intent=createThread` to avoid expensive auth reloads. Once create-thread also mutates chat groups, the implementation must either:

- update the chat-groups client context optimistically from the create response, or
- allow a targeted revalidation/refetch of chat-group data after grouped thread creation.

Do not rely on the layout loader naturally rerunning after first-send; today it intentionally does not.

### 10.3 Server helpers

**File:** `src/lib/chat-groups.server.ts` (new)

```ts
export async function listGroupsForWorkspace(context, workspaceId): Promise<ChatGroupSummary[]>;
export async function ensureGroupForThread(context, threadId): Promise<ChatGroupSummary>;
export async function moveThreadToGroup(context, args): Promise<ChatGroupSummary>;
export async function closeGroup(context, groupId): Promise<void>;
export async function removeDeletedThreadFromUserGroups(context, threadId): Promise<void>;
// thin wrappers around UserDO RPC; centralizes auth / workspace-access checks,
// OrgDO thread hydration, and lazy pruning of stale member rows
```

Modeled after `src/lib/chat-do.server.ts`.

---

## 11. Drag-and-Drop and "Move to Group…"

### 11.1 Drag

- Tab `<button>` gets `draggable` and `onDragStart` setting `application/x-camelai-thread-id`.
- Sidebar group rows get `onDragOver` / `onDrop`. On drop:
  - Same group → noop.
  - Different group → `POST /api/chat-groups/move-thread { threadId, targetGroupId }`.
- The `New chat` area (or any empty space below the chat groups list) is also a drop target — it calls `POST /api/chat-groups/move-thread { threadId, targetGroupId: "new" }` to create the destination group and move the existing thread in one UserDO transaction.
- During drag, highlight valid drop targets with `bg-sidebar-accent/50`.

### 11.2 Right-click context menu

Wrap each tab in `<ContextMenu>`:

```
Close tab
Rename chat
─────────
Move to group ▸
  ▸ Build dashboard
  ▸ Marketing
  ▸ Customer ops
  ─────────
  ▸ New group
```

The submenu lists **all** of the user's other groups in the active workspace (not just the visible 10), plus a "New group" option at the bottom. This lets a user move a chat into a group that's currently outside the sidebar's 10-row window — the destination group's `updated_at` is bumped by the move, so it re-enters the visible window after the operation. Because this is inside `ContextMenu`, use `ContextMenuSub`, `ContextMenuSubTrigger`, and `ContextMenuSubContent` from `src/components/ui/context-menu.tsx` with internal scrolling if the user has many groups. Selecting an item dispatches the same `move-thread` API.

This is the keyboard/trackpad-friendly fallback for users who don't drag.

---

## 12. Closing a Group and Chat History Integration

### 12.1 Closing a group

- Hover a group row in the sidebar → `×` reveals.
- If the group has 0–1 chats, close immediately.
- If the group has ≥2 chats, confirm via `<AlertDialog>`: *"Close 'Marketing'? Its 4 chats will be removed from this group. You can reopen any of them from Chat History."*
- On confirm: `DELETE /api/chat-groups/:id`. UserDO explicitly deletes `chat_group_members` for that group and then deletes `chat_groups`. Threads are untouched.
- Closing the active group navigates to the next remaining group's normal landing target (§6.3 click behavior), or to the plain welcome screen if no groups remain.

### 12.2 Chat History page

**File:** `src/routes/_app.history.tsx`

- The page itself stays flat and sorted by recency (no group hierarchy on this page, per spec).
- When the user clicks a thread in history, the navigation handler:
  1. If the thread is in another workspace, switches workspace first (existing history behavior already opens `SwitchWorkspaceDialog`).
  2. POSTs `move-thread { threadId, targetGroupId: "new" }` in the destination/current workspace (removing any prior membership for this user).
  3. Navigates to `/chat/:threadId`.
- This achieves "open from history → land in a brand-new group of its own", regardless of whether the chat was in a group earlier. Compare with the closed-chats popover (§7.3), which calls `reopenThreadTab` and stays in the existing group — same chat, two ways in, two behaviors. Document this difference in the route's loader/action so future readers don't conflate them.

### 12.3 Sidebar 10-group cap, lazy materialization, and recency

**Conceptual rule:** every chat the user opens in the chat surface is in a group. A chat that has only ever existed as a single thread is "in a group with only itself" — semantically a group of one. Because OrgDO threads and UserDO groups are separate, legacy/closed/history-only threads can lack a membership row until opened. Once materialized for a user, `chat_group_members.thread_id` keeps the thread in exactly one live group for that user.

**Sidebar visibility:** `<ChatGroupsList />` renders at most 10 groups, ordered by `chat_groups.updated_at DESC` (most recently active first). Older groups stay in storage but are not visible. Users reach older chats through Chat History; per spec, opening from Chat History always creates a *new* group, so an older chat re-enters the recency window with a fresh group the moment the user clicks it.

**No bulk backfill.** Existing users have many threads but zero groups today, and we do not retroactively materialize one per thread. Groups are created lazily, only when needed:

- A thread the user creates after this ships is added to a group at creation time — a brand-new group for sidebar `+ New chat` (§6.2), or the active group for tab bar `+` (§7.5).
- A thread the user opens via `/chat/:id` is materialized via `ensureGroupForThread` if no membership exists for them yet (§9.1).
- A thread the user clicks in Chat History always materializes a *new* group (§12.2).

**Recency / `updated_at` semantics.** `chat_groups.updated_at` is bumped whenever the user:

- creates or renames the group,
- adds, removes, closes, reopens, or reorders a member tab,
- sends a message in or opens a thread that's a member of this group.

The third bullet keeps groups containing recent user activity at the top of the sidebar. It's per-user — a teammate's activity in a shared chat does not bump *your* group ordering. (The `unread` dot still shows, see §8.2.) Bumps from message-send happen in the same paths that currently call `orgStub.touchThread(threadId)` for user messages (`ChatThreadDO.updateThreadMetadataForUserMessage` and the direct runner bridge helper in `workers/main/src/routes/websocket.ts`). Bumps from open happen in the chat route loader.

**Auto-delete empty groups.** When a `move-thread` operation leaves a group with zero members, delete its member rows and group row in the same UserDO transaction. This prevents accumulation of zombie groups beyond the 10-window.

---

## 13. Forking

The fork API at `POST /api/workspaces/:id/chat/:threadId/fork` returns the new thread. Today it only creates the fork.

Prefer making grouping part of the fork API request rather than a client-side follow-up. Send `groupId: currentGroupId` in the existing JSON body, validate that the group belongs to the acting user/current workspace, create the forked OrgDO thread, then add it to the group in UserDO before returning `{ thread }`. If UserDO grouping fails after thread creation, delete the just-created fork before returning an error, mirroring the existing rollback when sandbox fork setup fails.

If the user wants the fork in a different group, they drag it afterward.

Implementation: the fork button handler in `src/components/Chat.tsx` already posts `{ messageId }` to `POST /api/workspaces/:id/chat/:threadId/fork`; extend that payload with `groupId` from the chat-groups layout context. On success, navigate to `/chat/:newThreadId` and let the tab bar loader/context select the newly added tab. No picker, no destination prompt — per spec.

---

## 14. Implementation Order

1. **UserDO schema V9** + RPC methods (createGroup, listGroups, addThread, moveThread, closeGroup, closeTab, reopen, markViewed, pruneMissingThreads, etc.). Unit-test the RPCs in `workers/main/tests/`.
2. **Server helpers** in `src/lib/chat-groups.server.ts` with workspace/thread authorization, OrgDO hydration, stale-membership pruning, and cross-DO compensation helpers for create/fork flows.
3. **API routes** under `api/chat-groups/*`, `api/threads/:id/mark-viewed`, and thread-title rename, using `requireSessionWorkspaceAccess` and helper-level validation.
4. **`<ThreadStatusDot />`** + `WorkspaceDO.recordThreadStreaming` + explicit workspace-status WS route + shared recorder calls from both `ChatThreadDO.setChatIsStreaming` and `workers/main/src/routes/websocket.ts`.
5. **Sidebar updates** in `app-sidebar.tsx`: New Chat button, Chat Groups section, `<ChatGroupsList />`. Workspace switcher avatar dot.
6. **`<ChatTabBar />`** and integration in `_app.chat.$id.tsx`. Inline rename, closed-chats popover, settings menu, native drag, right-click context menu.
7. **Move-thread API + drag-drop wiring** between tab bar and sidebar.
8. **Welcome-screen flows** in `_app.chat._index.tsx`:
   - Sidebar `+ New chat` (no `?group=`) → action creates thread, then group + membership with compensation/recovery on first send.
   - Tab bar `+` (`?group=:id`) → action adds new thread to that group; transient placeholder tab is purely client-state.
9. **Auto-name group from first thread title** hook tied to the acting user's UserDO.
10. **Chat History "open as new group"** behavior.
11. **Forking** accepts current group in the fork API, rolls back the fork on grouping failure, and opens as a tab.
12. **Thread delete/rename integration:** remove actor-side membership on delete, lazily prune stale member rows for other users, and wire tab rename to the shared thread-title endpoint.
13. **Polish:** 10-row sidebar cap (no scroll), motion-reduce, tooltip copy ("3 chats · 1 needs review"), keyboard focus order, AlertDialog confirms.

Each step should leave the app working and should include the tests for that slice before moving on. Step 4 is independently shippable as a tiny win (workspace dot, no UI for groups yet — but with the broadcast infrastructure in place).

---

## 15. Testing Plan

Testing is a required part of this feature, not cleanup at the end. The implementation should land with a thorough test suite that covers persistence, authorization, route/action behavior, websocket status updates, UI interactions, and the most important user workflows. The goal is to catch both data-loss regressions and UX regressions before this becomes core navigation.

### 15.1 Worker and Durable Object tests

Add focused Worker tests under `workers/main/tests/`:

- **UserDO schema migration:** V9 creates `chat_groups`, `chat_group_members`, and `chat_thread_views`; migration is idempotent; existing V8 profile/org data survives.
- **Group creation/listing:** empty state returns no groups; creating groups scopes by `org_id` + `workspace_id`; list defaults to the top 10 by `updated_at DESC`; `listChatGroupsForMove` returns all groups.
- **Membership invariants:** one thread can belong to only one group per user; adding a thread to another group moves it cleanly; same operation is idempotent where expected.
- **Tab state:** close tab moves it to closed list; reopen restores it; reorder preserves open tab order; closing the active tab updates selection inputs consistently.
- **Move semantics:** move to existing group, move to new group, source empty group auto-delete, same-group move noop, and `last_active_thread_id` updates correctly.
- **Close group:** explicitly deletes member rows and group row; thread view rows remain harmless; threads in OrgDO are not deleted.
- **Thread views:** `markThreadViewed`, `listThreadViews`, and unread timestamp comparisons behave with missing view rows and newer thread updates.
- **Lazy materialization:** `ensureGroupForThread` creates exactly one group for legacy/unmaterialized threads; duplicate opens/races recover from the unique-index failure by reading the existing row.
- **Stale cleanup:** `removeThreadMembership` and `pruneMissingThreads` remove deleted-thread memberships and delete groups made empty by pruning.
- **Auto-name helper:** only renames empty, single-thread groups; does not overwrite a manually renamed group or multi-thread group.

Add WorkspaceDO tests for status:

- `recordThreadStreaming(true)` persists/broadcasts a running row.
- `recordThreadStreaming(false)` clears the row and broadcasts idle.
- new status websocket connections receive the initial snapshot.
- stale persisted rows expire so permanent spinners cannot survive crashes.
- multiple concurrent running threads in one workspace aggregate correctly.
- both call sites are covered: `ChatThreadDO.setChatIsStreaming` and the direct runner-bridge recorder helper.

Run with:

```bash
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts
bun run test:workers -- workers/main/tests/workspace-do-thread-status.test.ts
```

### 15.2 Server route and action tests

Add route/helper tests in `tests/` for the React Router server code and existing API-style routes:

- `/chat` first-send with no `groupId` creates an OrgDO thread, then creates a new UserDO group + membership, and returns both ids.
- `/chat?group=:id` and/or form `groupId` first-send validates ownership and adds the new thread to that existing group.
- create-thread compensation path: if grouping fails after thread creation, the new thread is deleted or `/chat/:id` recovery via `ensureGroupForThread` is explicitly verified.
- `_app.chat.$id` loader calls `ensureGroupForThread`, touches group recency, sets `last_active_thread_id`, and skips all group mutation for `adminReadonly=1`.
- `api/chat-groups/move-thread` rejects cross-workspace, cross-org, missing-thread, and non-owned-group moves.
- close/reopen/reorder tab routes validate current workspace access and group ownership.
- Chat History open routes through `move-thread { targetGroupId: "new" }`, including the existing switch-workspace dialog path.
- delete thread action removes the acting user's membership and leaves other users to lazy prune.
- fork route accepts `groupId`, validates it, adds the fork to the group, and deletes the fork if grouping fails.
- thread-title rename endpoint updates OrgDO title and rejects unauthorized workspace/thread combinations.
- mark-viewed route is per-user and cannot mark a thread outside the current workspace.

Run the focused route tests with `bun run test:run -- <test-file>` while developing, then include the full app unit pass before handoff.

### 15.3 UI and hook tests

Add component/hook tests in `tests/` using the existing Vitest + React Testing Library patterns:

- `<ChatGroupsList />` renders empty state, top-10 rows, active highlight, status dot priority, hover close affordance, and drop-target callbacks.
- `<ChatTabBar />` renders open/closed tabs, active state, overflow-safe labels, close/reopen behavior, inline rename submission, group rename menu, and context-menu move submenu using the `ContextMenu*` primitives.
- placeholder new tab appears for tab-bar `+`, is never persisted, and disappears on navigation away.
- no tab bar renders for sidebar `+ New chat` welcome flow with no active group.
- `use-chat-groups` exposes current group, optimistic mutations, revalidation/refetch behavior, and rollback on failed fetchers.
- workspace switcher and sidebar status dots obey `running > unread > idle`, including hidden/off-sidebar groups in the status roll-up.
- keyboard focus order reaches tabs, close buttons, closed-chats popover, settings menu, and context-menu fallback controls.
- preview panel regression: switching chat tabs remounts the chat view but does not merge or mutate preview-panel tabs/state.

### 15.4 End-to-end tests

Add at least one Playwright spec under the existing e2e structure (or the repo's current Playwright test location) for the core workflows:

- new user/workspace with no groups shows an empty chat-groups list and welcome screen.
- sidebar `+ New chat` does not create a thread/group until first send.
- first send creates a group of one, shows the tab bar, and highlights the sidebar group.
- tab-bar `+` creates a placeholder, first send replaces it with a real tab in the same group.
- closing a tab moves it to the closed-chats popover; reopening restores it.
- moving a tab to another group and to a new group updates both sidebar and tab bar.
- Chat History opens a thread into a brand-new group even if it was previously grouped.
- closing a group removes it from the sidebar and its chats remain accessible from history.
- forking from a message lands the fork in the current group.
- running/unread status dots appear at tab, group, and workspace levels and clear when viewed.

These e2e tests can mock or stub model/runner behavior where the repo already does that; they do not need to spend real model credits. They should focus on persisted state transitions and navigation.

### 15.5 Required verification before handoff

At minimum, the implementation handoff should include:

```bash
bun run typecheck
bun run test:run
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts
bun run test:workers -- workers/main/tests/workspace-do-thread-status.test.ts
bun run test:e2e -- <chat-groups spec>
```

If the full `bun run test:workers` or full `bun run test:e2e` suite is too slow for every iteration, run the focused suites during development and run the full relevant suite before final review. Any skipped test must be called out with the reason and the remaining risk.

---

## 16. Key Files

| File | Change |
|---|---|
| `workers/main/src/auth.ts` | UserDO migration V9, new RPC methods (§5.4). |
| `workers/main/src/workspace.ts` | `recordThreadStreaming`, `listStreamingThreadIds`, persisted streaming rows with stale TTL, workspace-level WS broadcast/fetch handler. |
| `workers/main/src/durable-objects.ts` | In `setChatIsStreaming` (line 1969), call the shared workspace-status recorder after the existing local broadcast. Also call group auto-name helper after title generation when `userId` is available. |
| `workers/main/src/routes/websocket.ts` | Direct runner bridge must call the shared workspace-status recorder on streaming true/false and the group auto-name helper after direct title generation. |
| `src/types.ts` | Add `ChatGroup`, `ChatGroupMember`, `ChatGroupSummary`, `ThreadStatus`. |
| `src/lib/chat-groups.server.ts` | **New.** Server helpers wrapping UserDO RPC + auth checks. |
| `src/routes.ts` | Add `api/chat-groups/*` routes + `api/threads/:id/mark-viewed` + thread-title rename route. |
| `workers/main/src/index.ts` | Register explicit workspace-status WS route before the generic `/ws/[^/]+` chat side-channel route. |
| `src/routes/api/chat-groups.*.ts` | **New.** One file per route per repo convention. |
| `src/routes/api/threads.$id.mark-viewed.ts` | **New.** |
| `src/routes/api/threads.$id.ts` | **New or expanded.** Rename thread title from tab bar; reuse `chatDO.updateThread`. |
| `src/routes/_app.tsx` | Loader: load chat groups for current workspace + roll-up status map; open workspace-level status WS; update `shouldRevalidate` or add optimistic chat-groups context updates after grouped thread creation. |
| `src/routes/_app.chat._index.tsx` | Accept `?group=:id`; on first send, create thread + add to group with cross-DO compensation/recovery. |
| `src/routes/_app.chat.$id.tsx` | Loader resolves group via `ensureGroupForThread`; render `<ChatTabBar />` above `<Chat />`. |
| `src/routes/_app.history.tsx` | When opening a thread, switch workspace if needed, then route through `move-thread { targetGroupId: "new" }` first. Delete action removes actor-side membership. |
| `src/components/sidebar/app-sidebar.tsx` | Move "New Chat" up; insert Chat Groups `SidebarGroup`; mount `<ChatGroupsList />`. |
| `src/components/sidebar/workspace-switcher.tsx` | Avatar status dot on trigger + dropdown items. |
| `src/components/sidebar/chat-groups-list.tsx` | **New.** |
| `src/components/chat-tab-bar.tsx` | **New.** |
| `src/components/thread-status-dot.tsx` | **New.** |
| `src/components/Chat.tsx` | Fork handler sends `groupId` to fork API and opens new tab. First-send payloads include `groupId` when adding to an existing group; omitting it creates a new group. **No preview-panel changes.** Preview panel and `ResizablePanelGroup` stay exactly as they are. |
| `src/hooks/use-chat-groups.ts` | **New.** Thin context wrapper around loader data + fetchers; provides `currentGroupId`, `openTabs`, mutations. |
| `workers/main/tests/user-do-chat-groups.test.ts` | **New.** Required RPC/migration/invariant tests from §15.1. |
| `workers/main/tests/workspace-do-thread-status.test.ts` | **New.** Required streaming roll-up + WS broadcast tests from §15.1. |
| `tests/chat-groups-routes.test.ts` | **New.** Required route/action/helper tests from §15.2. |
| `tests/chat-groups-ui.test.tsx` | **New.** Required sidebar/tab bar/hook tests from §15.3. |
| `tests/chat-groups.e2e.spec.ts` or repo-appropriate e2e path | **New.** Required core workflow coverage from §15.4. |

---

## 17. Out of Scope (v1)

Per spec:

- Sharing groups as snapshots / collaborative objects.
- Pinning or color-coding groups.
- Group-level settings beyond rename.
- Multi-select on tabs (cmd-click bulk operations).
- Restoring a closed group as a unit.
- Cross-workspace status roll-ups beyond the current workspace's avatar.

---

## 18. Open Questions

- **Empty state for a new chat in a group.** Per spec: keep it identical to today's blank-chat welcome state. We'll iterate on this once chat groups are live.

---

## 19. Risks and Things to Verify Mid-Implementation

- **Cross-DO partial failure:** thread creation/fork lives in OrgDO, while grouping lives in UserDO. Test failure handling so a grouping error does not leave a confusing ungrouped new thread, or ensure `/chat/:id` recovers with `ensureGroupForThread`.
- **Runner bridge streaming source:** current `/ws/runner/:workspace` sends `streaming_state` directly and can bypass `ChatThreadDO.setChatIsStreaming`. Verify workspace dots update from both code paths.
- **Layout revalidation:** `_app.tsx.shouldRevalidate` currently skips `intent=createThread`. Verify the sidebar group list updates after first send via optimistic context mutation or targeted refetch.
- **Thread deletion stale memberships:** deleting a shared thread cannot eagerly clean every user's UserDO. Verify group loaders filter/prune missing threads so stale tabs do not render.
- **WS fan-out volume** for the new workspace-level status channel. Streaming toggles are infrequent (one per assistant turn), so this should be cheap, but verify when more than one chat is running concurrently in the same workspace.
- **`ensureGroupForThread` race** when a teammate opens a chat for the first time in two tabs simultaneously. Mitigation: the SQL `UNIQUE INDEX chat_group_members_thread` makes the second insert fail; catch and read the existing membership.
- **Auto-name divergence:** the auto-name hook fires from the acting user's UserDO only. Other users who later open the same chat get their own auto-named groups (intentional — groups are per-user).
- **Closed-chats popover bound to group lifetime:** when a group is closed, the popover's contents go away. This matches spec ("we do not remember which chats were grouped together previously") but make sure the AlertDialog copy is clear about it.
- **Tab bar / preview panel separation:** during code review, watch for any temptation to merge preview tabs into the new tab bar. The two are intentionally separate; the spec is explicit on this point.
