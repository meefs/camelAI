# Chat Group Settings Menu on Sidebar Hover — Plan

## Problem

Users keep asking for the pin feature even though it already exists. Pin (and rename) live only
in the "Group options" `⋯` menu in the top-right of the chat tab bar (`src/components/chat-tab-bar.tsx:527-559`),
which users only see with a group open — a discovery problem. The sidebar chat group rows
(`src/components/sidebar/chat-groups-list.tsx`) currently show only an `X` (close) action on hover.

Two changes, one shared menu design:

1. Add a `⋯` options button to the sidebar row hover state, opening a dropdown with
   **Pin/Unpin group**, **Rename group**, and **Close group**.
2. Bring the existing tab-bar "Group options" menu into exact alignment with it: same item set
   (add **Close group**), same order, same styling — so the two menus read as one product surface.

No new backend: every action maps to an existing client helper / API route
(`PATCH /api/chat-groups/:id` for pin + rename, `DELETE /api/chat-groups/:id` for close).

## Current state (verified)

- `ChatGroupsList` (`src/components/sidebar/chat-groups-list.tsx`) renders each group as a
  `SidebarMenuItem` containing a `HoverCard` (thread-preview card, opens to the right,
  `openDelay={250}` / `closeDelay={150}`, controlled via `openHoverGroupId` state) wrapping the
  `SidebarMenuButton`, plus one `SidebarMenuAction` (the `X`) that fades in on row hover and
  routes through a close-confirmation `AlertDialog` (suppressible via the localStorage key
  `CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY`).
- `SidebarMenuAction` (`src/components/ui/sidebar.tsx:544`) is absolutely positioned at
  `right-1`, `w-5` (20px), hidden in collapsed-icon mode.
- The row's right slot (`ChatGroupRightSlot`) shows a status icon (running loader / unread dot)
  and an open-chat count; the count already fades on `group-hover/menu-item` and on
  `group-has-[[data-state=open]]/menu-item`.
- Pin logic: `saveChatGroupPinned` (`src/lib/chat-group-pin.client.ts`) — optimistic
  `camelai:chat-group-pinned` event (consumed by `use-chat-groups`, moves the row between the
  Pinned / Chat Groups sections immediately), pinned-count cookie hint, `PATCH { pinned }`,
  toast + revert on failure. Needs `workspaceId` and the current pinned count across **all** groups.
- Rename logic: `saveChatGroupRename` (`src/lib/chat-group-rename.client.ts`) — `PATCH { name, avatar? }`,
  toasts, optional avatar event. UI is `RenameChatGroupDialog`
  (`src/components/avatar/rename-chat-group-dialog.tsx`), lazy-loaded in `chat-tab-bar.tsx:62-66`.
- `ChatGroupsList` is consumed only by `AppSidebar` (`src/components/sidebar/app-sidebar.tsx`,
  twice: Pinned section and Chat Groups section). `AppSidebar` already has `revalidator`, all
  `groups`, and can get `workspaceId` from `useAuthData().currentWorkspace` (same hook
  `WorkspaceSwitcher` uses).
- Close-group flow in `AppSidebar` (`handleCloseGroup`): compute redirect via
  `getCloseGroupRedirect(groups, activeGroupId, groupId)` from `@/hooks/use-chat-groups`,
  navigate, `DELETE /api/chat-groups/:id`, revalidate.

### Menu surface colors — verified already consistent, do not override

`HoverCardContent` (`src/components/ui/hover-card.tsx:35`), `DropdownMenuContent`
(`src/components/ui/dropdown-menu.tsx:46`), and `ContextMenuContent` all render the identical
surface: `bg-popover text-popover-foreground rounded-lg shadow-md ring-1 ring-foreground/10`.
Inner row/item hovers all use the `accent` token (`hover:bg-accent` in the hover card rows,
`focus:bg-accent` in menu items). So the sidebar thread-preview card and the tab-bar settings
menu already share one surface, and the new sidebar menu inherits it automatically.

**Rule for this change:** use stock `DropdownMenuContent` / `DropdownMenuItem` with no color,
ring, radius, or shadow overrides anywhere (`className` limited to width, e.g. `w-56`). Both
menus and the hover card must come out of the same base components untouched.

### Destructive (red) styling — do NOT use it here

`variant="destructive"` on menu items is used in exactly three places, all permanent deletions
with a `Trash2` icon: "Delete" chat (`src/components/history/chat-row.tsx:399`), "Delete"
connection (`src/components/pages/connections/connection-row.tsx:202`), "Delete invitation"
(`src/components/admin/invitation-actions.tsx:92`). Closing a group is reversible (its chats
reopen from Chat History — the confirmation dialog says exactly that), so red would overstate
severity and dilute the delete signal. **Close group is a default-variant item.** The separator
above it is the only emphasis, matching how those menus separate their final action.

## UX design

### Sidebar row states (expanded sidebar)

```
IDLE (not hovered) — unchanged
┌────────────────────────────────────────┐
│  ◈  Marketing dashboard           ⟳ 3  │   status icon + open-chat count
└────────────────────────────────────────┘

HOVERED — count/status hidden behind a solid patch; two actions appear
┌────────────────────────────────────────┐
│  ◈  Marketing dashboard        [⋯] [✕] │   ⋯ = MoreHorizontal, ✕ = X (existing)
└────────────────────────────────────────┘
      X stays rightmost (muscle memory);  ⋯ sits immediately to its left
```

### The one menu (identical in sidebar and tab bar)

```
Unpinned group                      Pinned group
┌─────────────────────────┐         ┌─────────────────────────┐
│  📌  Pin group          │         │  📌  Unpin group        │
│  ✏️   Rename group       │         │  ✏️   Rename group       │
├─────────────────────────┤         ├─────────────────────────┤
│  ✕   Close group        │         │  ✕   Close group        │   default variant, NOT red
└─────────────────────────┘         └─────────────────────────┘
w-56, stock DropdownMenuContent — same bg/ring/radius as the thread-preview hover card
```

- **Pin first** in both menus: pin discovery is the reason this work exists. The tab-bar menu is
  currently Rename-first (`chat-tab-bar.tsx:545-557`) — reorder it to match.
- **Close group** goes through the *same* confirmation `AlertDialog` + localStorage suppression
  in both places (extracted to a shared component, below). The sidebar `X` button is unchanged.
- Sidebar menu opens `side="right" align="start"` (same side as the hover card); tab-bar menu
  keeps its current `align="end"` bottom placement.
- Collapsed (icon-only) sidebar: no change — `SidebarMenuAction` is already hidden there, and the
  new patch spans must be too.
- The thread-preview `HoverCard` must never overlap the sidebar dropdown: opening the menu closes
  the hover card and suppresses it until the menu closes.

### Sidebar menu open

```
┌────────────────────────────────────────┐   ┌─────────────────────────┐
│  ◈  Marketing dashboard        [⋯] [✕] │──▶│  📌  Pin group          │
└────────────────────────────────────────┘   │  ✏️   Rename group       │
   row keeps its hover (accent) background   ├─────────────────────────┤
   while the menu is open                    │  ✕   Close group        │
                                             └─────────────────────────┘
```

## Implementation

### 1. New shared file: `src/components/close-chat-group-dialog.tsx`

Extract the close-confirmation flow out of `chat-groups-list.tsx` so the tab bar can reuse it
(components-root placement matches `get-help-dialog.tsx`). Move these from
`chat-groups-list.tsx:36-62` verbatim and export them:

- `CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY`
- `readCloseGroupConfirmationSuppressed()`
- `writeCloseGroupConfirmationSuppressed()`

New component wrapping the existing `AlertDialog` JSX (`chat-groups-list.tsx:303-355`), with the
"Do not show again" checkbox state owned internally:

```tsx
export function CloseChatGroupDialog({
  open,
  onOpenChange,
  groupName,
  chatCount,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupName: string
  chatCount: number
  onConfirm: () => void
}) {
  const [rememberSuppression, setRememberSuppression] = useState(false)
  // AlertDialog content identical to today's: title `Close "{groupName}"?`,
  // description "Its {chatCount} {chat|chats} will be removed from this group.
  // You can reopen any of them from Chat History.", the suppression Checkbox,
  // Cancel, and a destructive "Close group" AlertDialogAction that:
  //   if (rememberSuppression) writeCloseGroupConfirmationSuppressed()
  //   onConfirm(); onOpenChange(false)
  // Reset rememberSuppression to false whenever the dialog closes.
}
```

(The dialog's confirm *button* keeps `variant="destructive"` — that is today's behavior and
`AlertDialogAction` destructive buttons are standard; only the *menu item* stays default.)

### 2. `src/components/sidebar/chat-groups-list.tsx`

**New imports:** `MoreHorizontal`, `Pencil`, `Pin`, `PinOff` from `lucide-react`; `lazy`, `Suspense`
from `react`; `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`,
`DropdownMenuTrigger` from `@/components/ui/dropdown-menu`; `CloseChatGroupDialog`,
`readCloseGroupConfirmationSuppressed` from `@/components/close-chat-group-dialog`; type
`ChatGroupRenameInput` from `@/lib/chat-group-rename.client`. Drop the now-unused `AlertDialog*`
and `Checkbox` imports and the moved helpers/constant.

**Lazy dialog** (mirror `chat-tab-bar.tsx:62-66`):

```tsx
const LazyRenameChatGroupDialog = lazy(() =>
  import("@/components/avatar/rename-chat-group-dialog").then((module) => ({
    default: module.RenameChatGroupDialog,
  })),
);
```

**New props** (required; both call sites are in `AppSidebar`):

```ts
interface ChatGroupsListProps {
  // ...existing...
  onTogglePinGroup: (group: ChatGroupView) => void;
  onRenameGroup: (groupId: string, next: ChatGroupRenameInput) => void;
}
```

**State changes:**

```ts
const [openMenuGroupId, setOpenMenuGroupId] = useState<string | null>(null);
const [renameTarget, setRenameTarget] = useState<ChatGroupView | null>(null);
const [isRenameOpen, setIsRenameOpen] = useState(false);
// confirmGroup stays; suppressCloseConfirmation + rememberSuppression state are DELETED —
// suppression is now read fresh at click time and written inside CloseChatGroupDialog.
```

**Close-request helper** used by both the `X` button and the menu item:

```ts
const requestCloseGroup = (group: ChatGroupView) => {
  if (readCloseGroupConfirmationSuppressed()) {
    onCloseGroup(group.id);
  } else {
    setConfirmGroup(group);
  }
};
```

Replace the inline `AlertDialog` block (`chat-groups-list.tsx:303-355`) with:

```tsx
<CloseChatGroupDialog
  open={confirmGroup !== null}
  onOpenChange={(open) => { if (!open) setConfirmGroup(null) }}
  groupName={confirmGroup?.name ?? "group"}
  chatCount={confirmGroup?.member_count ?? 0}
  onConfirm={() => { if (confirmGroup) onCloseGroup(confirmGroup.id) }}
/>
```

**Hover-card suppression while a menu is open** — change the `HoverCard` open prop:

```tsx
<HoverCard
  open={openHoverGroupId === group.id && openMenuGroupId === null}
  ...
```

**Row keeps its accent background while its menu is open** (so the actions never float on a
transparent row after the pointer leaves). Add to the `SidebarMenuButton`'s `cn(...)`:

```
"group-has-[[data-state=open]]/menu-item:bg-sidebar-accent"
```

(`data-state=open` also matches the hover-card trigger, which is only open while hovering anyway —
harmless.)

**Background patch under the actions** (tab-bar pattern, `chat-tab-bar.tsx:339-356`: solid patch +
thin gradient feather so long group names fade out under the buttons instead of colliding, with no
width/reflow change on hover). Insert these two spans inside `SidebarMenuItem`, after `</HoverCard>`
and before the actions:

```tsx
<span
  aria-hidden
  className="pointer-events-none absolute inset-y-0 right-0 w-12 rounded-r-md bg-sidebar-accent opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 group-data-[collapsible=icon]:hidden"
/>
<span
  aria-hidden
  className="pointer-events-none absolute inset-y-0 right-12 w-2.5 bg-gradient-to-l from-sidebar-accent to-transparent opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 group-data-[collapsible=icon]:hidden"
/>
```

No change to `ChatGroupRightSlot` — the patch covers the status icon and count area entirely
(the count's own fade classes stay; redundant but harmless).

**Options action + menu.** Insert before the existing `X` `SidebarMenuAction`:

```tsx
<DropdownMenu
  onOpenChange={(open) => {
    setOpenMenuGroupId(open ? group.id : null);
    setOpenHoverGroupId(null);
  }}
>
  <DropdownMenuTrigger asChild>
    <SidebarMenuAction
      type="button"
      aria-label={`Group options for ${group.name}`}
      className="right-6.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 focus-visible:opacity-100"
    >
      <MoreHorizontal className="size-3" />
    </SidebarMenuAction>
  </DropdownMenuTrigger>
  <DropdownMenuContent side="right" align="start" sideOffset={8} collisionPadding={8} className="w-56">
    <DropdownMenuItem onSelect={() => onTogglePinGroup(group)}>
      {group.pinned_at !== null ? <PinOff /> : <Pin />}
      {group.pinned_at !== null ? "Unpin group" : "Pin group"}
    </DropdownMenuItem>
    <DropdownMenuItem
      onSelect={() => {
        setRenameTarget(group);
        setIsRenameOpen(true);
      }}
    >
      <Pencil />
      Rename group
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={() => requestCloseGroup(group)}>
      <X />
      Close group
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Notes:
- `right-6.5` (26px) places the 20px-wide `⋯` with a 2px gap left of the `X` (`right-1` + `w-5`
  ends at 24px). Tailwind v4 dynamic spacing makes `right-6.5` valid.
- Opening a dialog directly from `onSelect` is the established, working pattern in this repo
  (`chat-tab-bar.tsx:545-549` does exactly this for the same rename dialog).
- The `X` action keeps its position/icon but its handler body becomes `requestCloseGroup(group)`;
  update its className to stay visible while the menu is open and when keyboard-focused:
  `"opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 focus-visible:opacity-100"`.
  (`focus-visible:opacity-100` on both actions is a 1-class a11y fix: today a keyboard-focused `X`
  shows a focus ring on an invisible button.)

**Rename dialog render.** At the end of the fragment (next to `CloseChatGroupDialog`):

```tsx
{renameTarget ? (
  <Suspense fallback={null}>
    <LazyRenameChatGroupDialog
      key={renameTarget.id}
      open={isRenameOpen}
      onOpenChange={setIsRenameOpen}
      initialName={renameTarget.name}
      initialAvatar={renameTarget.avatar}
      onSubmit={(next) => onRenameGroup(renameTarget.id, next)}
    />
  </Suspense>
) : null}
```

`renameTarget !== null` doubles as the lazy-mount gate (parity with `hasOpenedRenameGroupDialog` in
the tab bar); keeping `renameTarget` set on close preserves the dialog's exit animation.
`key={renameTarget.id}` resets the draft when the user renames a different group next.

### 3. `src/components/sidebar/app-sidebar.tsx`

**New imports:** `useAuthData` from `@/hooks/use-auth-data`; `saveChatGroupPinned` from
`@/lib/chat-group-pin.client`; `saveChatGroupRename` + type `ChatGroupRenameInput` from
`@/lib/chat-group-rename.client`.

Inside `AppSidebar` (near the existing `handleCloseGroup`):

```tsx
const { currentWorkspace } = useAuthData()

const handleTogglePinGroup = async (group: ChatGroupView) => {
  const workspaceId = currentWorkspace?.id
  if (!workspaceId) return
  await saveChatGroupPinned({
    groupId: group.id,
    workspaceId,
    pinned: group.pinned_at === null,
    currentPinnedAt: group.pinned_at,
    currentPinnedCount: groups.filter((entry) => entry.pinned_at !== null).length,
    revalidate: () => revalidator.revalidate(),
  })
}

const handleRenameGroup = async (groupId: string, next: ChatGroupRenameInput) => {
  await saveChatGroupRename(groupId, next, {
    revalidate: () => revalidator.revalidate(),
  })
}
```

`groups` here is the full list from `useChatGroups()` (both sections), so the pinned count is
correct regardless of which section the row is in.

Pass to **both** `ChatGroupsList` instances (Pinned section, `app-sidebar.tsx:365-378`, and Chat
Groups section, `app-sidebar.tsx:386-397`):

```tsx
onTogglePinGroup={handleTogglePinGroup}
onRenameGroup={handleRenameGroup}
```

### 4. `src/components/chat-tab-bar.tsx` — align the existing Group options menu

**New required props:**

```ts
interface ChatTabBarProps {
  // ...existing...
  groupMemberCount: number;        // = ChatGroupView.member_count, for the confirm dialog copy
  onCloseGroup: () => void;
}
```

**New state:** `const [isCloseGroupConfirmOpen, setIsCloseGroupConfirmOpen] = useState(false)`.

**Menu content** (`chat-tab-bar.tsx:544-558`) becomes — Pin first to match the sidebar, then the
new Close group item:

```tsx
<DropdownMenuContent align="end" className="w-56">
  <DropdownMenuItem onSelect={onTogglePin}>
    {groupPinnedAt !== null ? <PinOff /> : <Pin />}
    {groupPinnedAt !== null ? "Unpin group" : "Pin group"}
  </DropdownMenuItem>
  <DropdownMenuItem
    onSelect={() => {
      setHasOpenedRenameGroupDialog(true);
      setIsRenameGroupOpen(true);
    }}
  >
    <Pencil />
    Rename group
  </DropdownMenuItem>
  <DropdownMenuSeparator />
  <DropdownMenuItem
    onSelect={() => {
      if (readCloseGroupConfirmationSuppressed()) {
        onCloseGroup();
      } else {
        setIsCloseGroupConfirmOpen(true);
      }
    }}
  >
    <X />
    Close group
  </DropdownMenuItem>
</DropdownMenuContent>
```

Imports: add `DropdownMenuSeparator`; add `CloseChatGroupDialog`,
`readCloseGroupConfirmationSuppressed` from `@/components/close-chat-group-dialog`
(`Pin`/`PinOff`/`Pencil`/`X` are already imported).

**Dialog render** next to the lazy rename dialog:

```tsx
<CloseChatGroupDialog
  open={isCloseGroupConfirmOpen}
  onOpenChange={setIsCloseGroupConfirmOpen}
  groupName={groupName}
  chatCount={groupMemberCount}
  onConfirm={onCloseGroup}
/>
```

### 5. `src/routes/_app.chat._index.tsx` — wire tab-bar close

Add `getCloseGroupRedirect` to the existing `@/hooks/use-chat-groups` import. Next to
`toggleGroupPin` (`_app.chat._index.tsx:1148`):

```tsx
const closeGroup = async () => {
  const group = liveActiveChatGroup;
  if (!group) return;
  const redirect = getCloseGroupRedirect(liveChatGroups, group.id, group.id);
  if (redirect) navigate(redirect, { replace: true });
  await fetch(`/api/chat-groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
  refresh();
};
```

(Closing from the tab bar always closes the *active* group, so passing `group.id` as both
`activeGroupId` and `closingGroupId` makes `getCloseGroupRedirect` return the next group's landing
href or `/chat` — same navigation behavior as closing the active group from the sidebar.)

On the `<ChatTabBar>` element (`_app.chat._index.tsx:1192-1211`) add:

```tsx
groupMemberCount={liveActiveChatGroup.member_count}
onCloseGroup={closeGroup}
```

## Behavior details

- **Pin/unpin moves the sidebar row between sections immediately** — `saveChatGroupPinned`
  dispatches the optimistic `camelai:chat-group-pinned` event that `use-chat-groups` already
  consumes. The row unmounts from one `SidebarMenu` and mounts in the other; Radix closes the
  dropdown on unmount. No extra handling needed; on failure the helper reverts and toasts.
- **Menu vs hover card:** opening the menu sets `openMenuGroupId` and clears `openHoverGroupId`, so
  the computed `open` on every `HoverCard` is false while any row menu is open. When the menu
  closes, `openHoverGroupId` was already cleared, so the hover card doesn't instantly pop back —
  it re-opens only after fresh hover intent (250ms `openDelay`).
- **Clicking `⋯` must not select the group:** the action is a DOM sibling of the row button (not a
  child), so the row's `onClick` can't fire from it — same as the existing `X`.
- **Suppression is read at click time** (`readCloseGroupConfirmationSuppressed()`), not cached in
  component state as today — "Do not show again" set from either surface applies to the other
  immediately.
- **Touch devices:** the sidebar actions keep the existing `opacity-0` hover-reveal, matching the
  current `X` behavior on touch (invisible but tappable). Preexisting quirk, explicitly out of scope.
- **Collapsed rail:** no actions, no patch (all carry `group-data-[collapsible=icon]:hidden`,
  built into `SidebarMenuAction`).

## Out of scope

- A right-click `ContextMenu` on sidebar group rows.
- Making sidebar hover actions visible-by-default on touch devices (preexisting `X` behavior).
- Any restyling of menu/popover base components — surfaces are already consistent (see above).
- Any API/backend change — none is needed.

## Tests

All in `tests/chat-groups-ui.test.tsx` (it covers both `ChatGroupsList` ~line 713 and `ChatTabBar`
~line 379). Required-prop additions mean every existing render needs updating:
`ChatGroupsList` renders get `onTogglePinGroup={vi.fn()}` / `onRenameGroup={vi.fn()}`;
`ChatTabBar` renders get `groupMemberCount={...}` / `onCloseGroup={vi.fn()}`. The test file
imports `CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY` from `chat-groups-list` — update that
import to `@/components/close-chat-group-dialog`.

New cases (follow the existing `ChatTabBar` menu-test patterns in the same file, e.g.
"loads the rename group dialog when the group option is selected" and "toggles the pin menu label
and handler from group state" for lazy-dialog and menu-label assertions):

`ChatGroupsList`:
1. Hover actions render for each row: buttons with `aria-label` `Group options for {name}` and
   `Close {name}` both exist.
2. Opening the menu on an unpinned group shows "Pin group", "Rename group", "Close group";
   selecting "Pin group" calls `onTogglePinGroup` with that group.
3. A group with `pinned_at` set shows "Unpin group" (with `PinOff`) instead.
4. Selecting "Close group" opens the confirmation dialog; confirming calls `onCloseGroup` with the
   group id. With the localStorage suppression key set, it calls `onCloseGroup` directly.
5. Selecting "Rename group" lazily mounts `RenameChatGroupDialog` (`await screen.findByRole` /
   `findByLabelText`); submitting a new name calls `onRenameGroup(groupId, { name, ... })`.
6. The "Close group" menu item does NOT have `data-variant="destructive"` (guards the
   non-destructive decision).

`ChatTabBar`:
7. The group menu lists items in order Pin/Unpin → Rename group → Close group.
8. Selecting "Close group" opens the confirmation dialog; confirming calls `onCloseGroup`. With
   the suppression key set, `onCloseGroup` is called without a dialog.

Run:

```bash
bun run test:run -- tests/chat-groups-ui.test.tsx
bun run typecheck
```
