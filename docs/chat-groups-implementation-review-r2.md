# Chat Groups Implementation Review - 2026-05-08

## Scope

Reviewed the current working tree against `origin/main`, with emphasis on the follow-up implementation after the first review and the reported drag/drop nit.

Overall, the active chat layout looks much healthier in the diff. The prior flex wrapper regression is fixed in both chat routes: `Chat` is again mounted inside a `flex min-h-0 flex-1 flex-col` parent.

## Findings

### P2 - Chat tab drags trigger the file-drop overlay

Refs:

- `src/components/Chat.tsx:4778`
- `src/components/Chat.tsx:6247`
- `src/components/chat-tab-bar.tsx:108`

The user's nit is valid. `Chat` treats every drag over the chat panel as a file drag:

```ts
e.preventDefault();
e.stopPropagation();
setIsDragOver(true);
```

`ChatTabBar` sets a custom tab-drag MIME type (`application/x-camelai-thread-id`), but `Chat` never checks whether the drag contains files before showing "Drop files here to upload". Dragging a chat tab across the chat panel therefore trips the upload overlay.

Recommendation:

- Add a small helper such as `isFileDrag(dataTransfer)` that returns true only for `dataTransfer.types.includes("Files")` or file-kind `dataTransfer.items`.
- In `handleDragOver`, return immediately for non-file drags before calling `preventDefault`, `stopPropagation`, or `setIsDragOver(true)`.
- In `handleDrop`, only prevent/default-handle drops that actually contain files.
- Add a regression test that tab drags do not render `Drop files here to upload`, while file drags still do.

### P1 - Reorder route can reopen closed tabs and accepts malformed tab order

Refs:

- `src/routes/api/chat-groups.$id.reorder-tabs.ts:23`
- `src/routes/api/chat-groups.$id.reorder-tabs.ts:34`
- `workers/main/src/auth.ts:1301`

The reorder API accepts any string array and passes it straight to `userStub.reorderThreadTabs`. The UserDO method then runs:

```sql
UPDATE chat_group_members
SET position = ?, is_open = 1, closed_at = NULL
WHERE group_id = ? AND thread_id = ?
```

That means a stale or malformed client can include a closed tab ID and silently reopen it through the reorder endpoint, bypassing the explicit reopen route. It can also omit open IDs or send duplicates, leaving inconsistent positions.

Recommendation:

- In the route, load the group summary and verify `orderedThreadIds` is exactly the current open tab set: no closed IDs, no unknown IDs, no duplicates, no omissions.
- In `reorderThreadTabs`, update positions only; do not change `is_open` or `closed_at`.
- Add route/UserDO tests for closed IDs, duplicate IDs, missing open IDs, and valid reorder.

### P2 - Workspace status socket is fragile across reconnect/DO lifecycle

Refs:

- `workers/main/src/workspace.ts:340`
- `workers/main/src/workspace.ts:366`
- `src/hooks/use-chat-groups.tsx:73`

The new workspace status WebSocket keeps connected clients in an instance field `Set<WebSocket>` and accepts sockets with `server.accept()`. Other DO WebSocket code in this repo uses the hibernation APIs (`ctx.acceptWebSocket` and `ctx.getWebSockets`). The current approach can lose broadcast targets if the object instance is restarted, and the client hook clears state on `close`/`error` without attempting to reconnect.

Recommendation:

- Use `this.ctx.acceptWebSocket(server, ["status"])` and broadcast via `this.ctx.getWebSockets("status")` or the repo's equivalent pattern.
- Add a lightweight reconnect loop in `ChatGroupsProvider` so transient socket closes do not permanently disable running indicators.
- Add a focused test around status snapshot/broadcast behavior if practical; the existing e2e socket-count test does not cover reconnect or broadcast delivery.

## Verification Run

Passed:

- `bun run typecheck`
- `bun run test:run -- tests/chat-groups-ui.test.tsx tests/chat-groups-routes.test.ts`
- `bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/workspace-do-thread-status.test.ts`
- `bun run test:run -- tests/Chat.test.tsx`

Not run:

- Full test suite.
- Playwright e2e. The new e2e file exists, but I did not start a dev server for this review pass.

## Suggested Next Patch

Fix the file-drag detection first because it maps directly to the observed UX bug and should be low risk. Then tighten the reorder API validation, since that is the main remaining state-integrity issue I found in this pass.

---

# UI Refinements

These follow the backend findings above and target the visual/layout polish of the chat tab bar and sidebar. The implementation agent should treat them as one connected pass — the tab bar redesign drives most of the work and the others are small companion changes.

## Target end-state at a glance

```
Desktop (≥768px) — no breadcrumb header on the chat surface:

┌──────────────────┬─────────────────────────────────────────────────────────────┐
│   Workspace ▾    │ ┌──────────┬──────────┬──────────┬─┐                       │
│   (no dot)       │ │ Build dsh│ API e... │ Fix lay  │+│        ⌄  ⋯           │
│                  │ │   logo  ◐│  ●logo   │  logo  ●│ │                        │
│  + New chat      │ ╞══════════╧═══════════════════════                          │
│                  │ │  ↑ active "API endpoints" lifts above the rule;            │
│ CHAT GROUPS      │ │     its bottom edge merges with the chat content below     │
│  Build dsh   3   │ │                                                            │
│  Marketing ⟳ 2   │ │   Chat messages                                            │
│  Customer  ● 5   │ │                                                            │
│                  │ │   (existing — preview panel unchanged)                     │
│ WORKSPACE        │ │                                                            │
│ 🖥  Computer      │ │                                                            │
│ 💬 Chat History  │ │                                                            │
│ 🔌 Connections   │ │                                                            │
│ 🗂  Apps          │ └────────────────────────────────────────────────────────────┘
│                  │
│ ❓ Get Help      │
│ 👤 User          │
└──────────────────┴─────────────────────────────────────────────────────────────┘

Mobile (<768px) — keep the existing PageHeader so users can still toggle the sidebar:

┌──────────────────────────────────────────────────────────────────────────────┐
│ ☰  Chat / Untitled chat                                                      │  ← <PageHeader> stays
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────┬──────────┬─┐                                                    │
│ │ Build dsh│ API e... │+│   ⌄  ⋯                                             │
│ ╞══════════╧══════════════                                                   │
│ │  Chat messages                                                              │
│ │                                                                             │
└──────────────────────────────────────────────────────────────────────────────┘

Notes:
- On desktop the breadcrumb header is hidden; cmd+B and the <SidebarRail /> edge
  toggle the sidebar. On mobile the existing <PageHeader> is preserved as-is.
- Workspace switcher avatar has NO status dot — chat-group rows below convey the
  same info without redundancy.
- Tab right slot reserves a fixed 20px square: model logo when idle, animated
  spinner when running, red dot when unread. Title text never shifts.
- "+" sits inline immediately after the last open tab (not on the right corner).
- "⌄" (closed-chats popover) and "⋯" (group settings) stay on the right.
- Chat group rows: name on the left, RIGHT slot = optional status icon + count.
  Count is always visible. No chevron. Status priority: running > unread > idle.
- Collapsed sidebar: each group renders a single-icon affordance — first-letter
  avatar (idle), spinner (running), red dot (unread). Tooltip on hover shows
  the group name. New "Workspace" subheader above Computer/etc.
```

## R2-UI-1 — Hide the breadcrumb header on desktop, keep it on mobile

Refs:

- `src/components/Chat.tsx:5874-5877` (`chatBreadcrumbs` array)
- `src/components/Chat.tsx:6083` (`<PageHeader breadcrumbs={chatBreadcrumbs} />`)
- `src/components/page-header.tsx:26-56`

`<PageHeader>` does double duty: it shows the breadcrumb *and* hosts the `<SidebarTrigger />`. On desktop the trigger is redundant — `cmd+B` and the `<SidebarRail />` edge both toggle the sidebar — so the header is pure chrome once the new tab bar identifies the chat. On mobile (below the `md` breakpoint, 768px) the sidebar swaps to a Sheet/drawer and the keyboard shortcut + rail are unavailable, so the trigger is the only way back in.

Recommendation: render the chat-surface `<PageHeader>` only below `md`. Don't relocate the trigger into the tab bar.

```tsx
// src/components/Chat.tsx — at the top of chatPanelContent, replace
//   <PageHeader breadcrumbs={chatBreadcrumbs} />
// with:
<PageHeader breadcrumbs={chatBreadcrumbs} className="md:hidden" />
```

`<PageHeader>` already accepts and forwards a `className` (`page-header.tsx:23,28`), so this is a one-line change. Keep the `chatBreadcrumbs` array — the mobile render still uses it.

Leave `<PageHeader>` itself untouched. Other routes (history, apps, connections, settings, …) continue to render it at all sizes.

Verification:

- Desktop ≥768px: `/chat/:id` shows zero `<PageHeader>` instances; the tab bar sits at the very top of the chat panel. Sidebar can still be toggled via cmd+B and the rail.
- Mobile <768px: existing breadcrumb + sidebar trigger render exactly as today, above the tab bar.
- `tests/Chat.test.tsx` regression: assert that the chat panel's `<PageHeader>` wrapper has the `md:hidden` class (or, if the implementer renders conditionally, that no `<PageHeader>` is rendered at desktop widths).

## R2-UI-2 — Tab bar redesign: folder shape + standardized tab layout

Refs:

- `src/components/chat-tab-bar.tsx` (whole file)
- `src/components/thread-status-dot.tsx`
- `src/components/model-logo.tsx`
- `src/types.ts` — `ChatGroupView` / tab shape

This is the largest change. The current bar uses a flat `border-b-2` underline for the active tab, places the `+` on the far right, and renders the rename/close icons in a way that pushes the title text. The new design takes the "folder" metaphor from `folder-tab-design.png` and the standardized tab layout from `standardize-tab-size-and-placement.png`, but uses our design system (Tailwind v4 + shadcn).

### 2.1 Outer bar

```tsx
// chat-tab-bar.tsx — outer container
<div className="relative flex h-11 shrink-0 items-end gap-0 border-b bg-muted/20 pl-2 pr-1">
  {/* tabs scroller */}
  <div className="flex min-w-0 flex-1 items-end gap-0 overflow-x-auto">
    {openTabs.map(...)}            {/* see §2.2 */}
    <NewTabButton />               {/* §2.4 — inline, immediately after the last tab */}
  </div>

  {/* trailing actions */}
  <div className="mb-1 ml-1 flex shrink-0 items-center gap-0">
    <ClosedChatsPopover />          {/* ⌄ — unchanged behavior */}
    <GroupSettingsMenu />           {/* ⋯ — unchanged behavior */}
  </div>
</div>
```

No `<SidebarTrigger>` inside the tab bar — per R2-UI-1, the trigger lives in the mobile-only `<PageHeader>` and isn't needed on desktop.

Key points:

- Bar height grows from `h-10` to `h-11` so the active tab can lift 4px above the inactive tabs without clipping.
- Children are anchored to the bottom (`items-end`) so the active tab grows *upward*.
- The `border-b` on the outer container is the rule that the active tab visually punches through (see §2.3).

### 2.2 Tab inner layout (standardized for every tab)

```
fixed width: w-44 (176px)
┌────────────────────────────────┐
│ Title.................. [slot] │   ← always 3 zones
└────────────────────────────────┘
   left: title (truncate)         right slot: 20×20, fixed

On hover (any tab):
┌────────────────────────────────┐
│ Title........[✎][×]    [slot] │   ← edit/close in a chip overlaying
└────────────────────────────────┘     the right side of the title text
```

```tsx
// One tab
<button
  type="button"
  data-active={isActive}
  className={cn(
    "group/tab relative flex w-44 shrink-0 items-center gap-2 px-3 text-xs outline-none transition-colors",
    "rounded-t-md",
    isActive
      ? "z-10 -mb-px h-11 border border-b-0 bg-background font-medium text-foreground shadow-[0_-1px_0_0_var(--border)]"
      : "h-9 mb-1 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
  )}
>
  <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>

  {/* fixed right slot — reserves space so title never jumps */}
  <span className="grid size-5 shrink-0 place-items-center" aria-hidden={false}>
    <TabRightSlot status={tab.status} model={tab.model} />
  </span>

  {/* hover overlay: pencil + close, anchored just before the slot */}
  <span
    className={cn(
      "absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded-md px-1 py-0.5",
      "bg-background/95 shadow-sm ring-1 ring-border opacity-0 transition-opacity",
      "group-hover/tab:opacity-100 focus-within:opacity-100",
    )}
  >
    <button onClick={onEdit}><Pencil className="size-3" /></button>
    <button onClick={onClose}><X     className="size-3" /></button>
  </span>
</button>
```

Style intent (mapping back to the user's prototype description):

- **Same width for every tab** — `w-44`. The title truncates with `min-w-0 flex-1 truncate`. No more dynamic widths.
- **Reserved right slot, fixed 20×20** — `<TabRightSlot>` always occupies that space so the title doesn't jump when status changes.
- **Hover icons overlay the title text** — they live in an absolutely-positioned chip with `bg-background/95 ring-1 ring-border` so they read as "floating over" the rightmost characters rather than reserving an empty area. The chip is anchored `right-8` (i.e., immediately to the left of the 20px slot + ~8px gap).
- **Active tab "lifts"** — `h-11` (vs inactive `h-9`), `bg-background`, `border-x border-t border-b-0`, rounded top corners, `-mb-px` so its bottom edge sits *on top of* the bar's bottom border. The inactive tabs use `mb-1` so they sit below that line. The visual result is the active tab merging with the chat-content panel beneath it — no horizontal seam between the tab and the chat.

### 2.3 The folder-merge effect (how the active tab joins the content)

The trick is sequencing borders:

- The outer bar has `border-b` (color `var(--border)`).
- The active tab has `border-x border-t border-b-0` (no bottom border) plus `-mb-px` to overlap the bar's bottom border by 1px.
- The chat content area below the bar uses `bg-background` so the active tab's `bg-background` fill flows directly into the content with no visible seam.
- Inactive tabs are `bg-transparent` so the bar's `bg-muted/20` shows through.

If the implementer needs a sanity check: an inactive→active transition should look like the tab lifts up by 2-3 pixels, gains rounded top corners, and gains visible left/right edges, while its bottom edge "disappears" into the content beneath it.

Optional but nice: add a subtle `transition-[height,background-color] duration-150` to soften the lift/fall on tab switch.

### 2.4 Inline `+` button (immediately after the last tab)

Currently the `+` button lives in the right-side action cluster (`chat-tab-bar.tsx:208-218`). Move it inline.

```tsx
// Right after openTabs.map(...)
<Button
  type="button"
  aria-label="New chat in this group"
  variant="ghost"
  size="icon-sm"
  onClick={onNewTab}
  className="mb-1 ml-0.5 h-9 w-8 shrink-0 rounded-t-md text-muted-foreground hover:text-foreground"
>
  <Plus className="size-4" />
</Button>
```

The closed-chats popover (`⌄`) and group settings (`⋯`) **stay on the right** in the trailing actions cluster — they aren't tab-flow actions, they're bar-level affordances and shouldn't compete with the inline `+`.

### 2.5 `<TabRightSlot>` — the reserved slot component

New tiny component (could live inline in `chat-tab-bar.tsx`, or as `src/components/tab-right-slot.tsx` — implementer's call):

```tsx
import { Loader2 } from "lucide-react";
import { ModelLogo } from "@/components/model-logo";
import type { LlmModel, ThreadStatus } from "@/types";

interface Props {
  status: ThreadStatus;
  model: LlmModel;
}

export function TabRightSlot({ status, model }: Props) {
  if (status === "running") {
    return (
      <Loader2
        className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none"
        aria-label="Agent is working"
      />
    );
  }
  if (status === "unread") {
    return (
      <span
        aria-label="Awaiting your review"
        className="size-2 rounded-full bg-red-500"
      />
    );
  }
  return <ModelLogo model={model} size={16} className="opacity-80" />;
}
```

State priority is preserved (`running > unread > idle`), but rendered at higher fidelity than the existing `<ThreadStatusDot>`:

- `running` → animated `<Loader2>` (small spinner) instead of a pulsing dot. Reads as "the agent is doing work" more clearly at this size.
- `unread` → red dot (the user's preferred color in this iteration; see R2-UI-6 for the global palette change).
- `idle` → the model's provider logo via the existing `<ModelLogo />` (`src/components/model-logo.tsx`) at 16px, dimmed slightly (`opacity-80`) so it sits behind the title visually.

### 2.6 Data plumbing for the model logo

The slot needs `tab.model: LlmModel`. Today the open-tabs prop in `ChatTabBarProps.openTabs` is `{ threadId, title, status? }`. Extend it:

```ts
interface ChatTab {
  threadId: string;
  title: string;
  status?: ThreadStatus;
  model: LlmModel;            // NEW
}
```

Source: `threads.model` already exists in OrgDO (`workers/main/src/auth.ts:1700-1707`) and in the `Thread` interface (`workers/main/src/durable-objects.ts:99-106`). The chat-groups loader / `useChatGroups` hook needs to thread the per-thread `model` through `ChatGroupView` → `ChatTab`. No new RPC needed — the existing thread fetch path already returns the model.

If the model is missing for some legacy thread (very unlikely given V20 backfill), default to the org's effective default model rather than leaving the slot blank — the slot must always render something idle.

### 2.7 What goes away

Once the slot moves to the right, **delete** the leftmost `<ThreadStatusDot status={tab.status ?? "idle"} />` in `chat-tab-bar.tsx:135`. Status now lives exclusively in the right slot for tabs.

After R2-UI-3 (sidebar group row redesign) and R2-UI-5 (workspace switcher dot removed), `<ThreadStatusDot>` may have **no consumers left**. The implementer should run `rg "ThreadStatusDot" src/` after those changes — if zero hits, delete `src/components/thread-status-dot.tsx` and its import in any test file. If something else picked it up, just leave the component in place.

## R2-UI-3 — Sidebar: standardize chat group row layout

Refs:

- `src/components/sidebar/chat-groups-list.tsx:60-114`
- `src/components/sidebar/app-sidebar.tsx:86-99` (new chat button — for tooltip verification)
- `src/types.ts` — `ChatGroupView.member_count`

Today's row (`chat-groups-list.tsx:86-93`):

```tsx
<ChevronRight ... />
<ThreadStatusDot status={group.status} />
<span className="min-w-0 truncate">{group.name}</span>
```

Three problems:

1. The chevron implies expand/collapse, but rows don't expand.
2. The status dot on the left causes the name to shift when status changes.
3. We never tell the user how many chats are in a group — visual density is invisible.

Plus the collapsed sidebar state is undesigned: with the chevron gone, the row has nothing meaningful to render at icon-size.

### 3.1 Redesigned row, expanded state

```
┌────────────────────────────────────────┐
│ Build dashboard                    3   │   idle (status hidden, count visible)
│ Marketing                      ⟳   2   │   running (spinner before count)
│ Customer ops                   ●   5   │   unread (red dot before count)
└────────────────────────────────────────┘
   ↑ name (truncate, flex-1)        ↑ right slot: optional status icon + count
```

```tsx
<SidebarMenuButton
  type="button"
  isActive={isActive}
  tooltip={group.name}                          // ← NEW: shows in collapsed sidebar
  className="group/chat-group h-7 gap-2"
  onClick={...}
  onDragOver={...}
  onDrop={...}
>
  <ChatGroupCollapsedIcon group={group} />      {/* visible only in collapsed state — see §3.2 */}
  <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
  <ChatGroupRightSlot status={group.status} count={group.member_count} />
</SidebarMenuButton>
```

`<SidebarMenuButton>` already hides text children when the sidebar collapses (per shadcn convention), so the `<span>` and the right slot disappear automatically; only `<ChatGroupCollapsedIcon>` remains visible.

`<ChatGroupRightSlot>` — new tiny component (inline in `chat-groups-list.tsx` is fine):

```tsx
import { Loader2 } from "lucide-react";
import type { ThreadStatus } from "@/types";

interface Props {
  status: ThreadStatus;
  count: number;
}

export function ChatGroupRightSlot({ status, count }: Props) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
      {status === "running" ? (
        <Loader2
          className="size-3 animate-spin text-blue-500 motion-reduce:animate-none"
          aria-label="Agent is working"
        />
      ) : status === "unread" ? (
        <span
          aria-label="Awaiting your review"
          className="size-1.5 rounded-full bg-red-500"
        />
      ) : null}
      <span aria-label={`${count} chats`}>{count}</span>
    </span>
  );
}
```

Behavior:

- **Count is always rendered** in `tabular-nums` so digits align across rows. Gives an at-a-glance density signal per group.
- **Status icon, when present, sits to the LEFT of the count.** When idle, no icon — the count sits flush to the right edge. Because the parent uses `ml-auto` to right-align the *whole* slot, the count itself never shifts position; only the slot widens leftward when an icon appears.
- **Status priority: `running > unread > idle`.** When both running and unread apply, the spinner wins. (Same priority as collapsed-state — see §3.2.)

> The existing leading `<ThreadStatusDot>` at `chat-groups-list.tsx:92` is removed in this redesign. Drop the `<ChevronRight>` import (`chat-groups-list.tsx:4`) and the `ChevronRight` block (lines 86-91) at the same time.

### 3.2 Collapsed sidebar state

When `useSidebar().state === "collapsed"`, only the leading icon of each row is visible. We need a meaningful one for chat groups, since names are user-defined and there's no obvious universal icon.

```tsx
function ChatGroupCollapsedIcon({ group }: { group: ChatGroupView }) {
  if (group.status === "running") {
    return (
      <Loader2
        className="size-4 animate-spin text-blue-500 motion-reduce:animate-none"
        aria-label="Agent is working"
      />
    );
  }
  if (group.status === "unread") {
    return (
      <span
        aria-label="Awaiting your review"
        className="size-2 rounded-full bg-red-500"
      />
    );
  }
  // idle → first-letter avatar
  const letter = (group.name?.trim()?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="grid size-4 place-items-center rounded bg-sidebar-accent text-[10px] font-medium text-sidebar-accent-foreground"
    >
      {letter}
    </span>
  );
}
```

Resolution rules in collapsed state:

- **Idle** → first-letter avatar (`bg-sidebar-accent` chip; falls back to `?` during the brief auto-naming window when name is empty).
- **Running** → blue animated spinner.
- **Unread** → red dot.
- **Both running + unread** → spinner only. (Per your call: show one indicator, not both.)
- **Hover** → `<SidebarMenuButton tooltip={group.name}>` provides the tooltip; shadcn already routes that prop to a Radix tooltip rendered next to the icon when the sidebar is collapsed. No extra wiring.

ASCII of collapsed sidebar:

```
┌──────┐
│ [W]  │   workspace switcher (icon-only, no status dot per R2-UI-5)
│ [+]  │   new chat (Plus icon, tooltip "New chat")
│      │
│ [B]  │   Build dashboard, idle
│ [⟳] │   Marketing, running (spinner replaces "M" avatar)
│ [●]  │   Customer ops, unread (red dot replaces "C" avatar)
│      │
│ [🖥] │   Computer
│ [💬] │   Chat history
│ ...  │
└──────┘
```

### 3.3 Hover affordances in expanded state

The close `×` action lives on `<SidebarMenuAction>` (`chat-groups-list.tsx:95-110`) and reveals on hover. Keep that unchanged — `<SidebarMenuAction>` renders *outside* the `<SidebarMenuButton>` content area, so it doesn't disturb the new count/status layout. While hovered, the `×` button visually overlaps the right slot, which is fine — it's a momentary state and the `×` is the action the user is aiming for.

If you want the right slot to politely fade while the close `×` is exposed, add `group-hover/menu-item:opacity-0` to `<ChatGroupRightSlot>`'s outer `<span>`. Optional polish.

### 3.4 Verify the "+ New chat" tooltip

Refs: `src/components/sidebar/app-sidebar.tsx:86-99`

`<SidebarMenuButton tooltip="New chat">` is already set on this button (line 90). shadcn only displays `tooltip` when `useSidebar().state === "collapsed"`; in expanded state the label is already visible next to the `+` icon, so no tooltip pops up — that's intended behavior.

If hovering the `+` icon in collapsed state still shows nothing, that's a bug worth investigating, not a missing prop. Most likely culprits:

1. Some ancestor isn't wrapped in a `TooltipProvider` (shadcn's sidebar usually mounts one, but verify).
2. The button is being rendered outside the sidebar tree somehow, breaking the collapsed-state context.

Fix in place rather than adding a redundant `<Tooltip>` wrapper.

In expanded state we intentionally keep tooltips off for sidebar items to avoid duplicating the visible label. If we ever decide to add expanded-state tooltips, do it for *all* sidebar items at once for consistency, not just New Chat.

### 3.5 Data plumbing (small)

`<ChatGroupRightSlot>` needs `count: number`. `ChatGroupView` already exposes `member_count` (used today at `chat-groups-list.tsx:58`), so no API or RPC change is needed — pass `count={group.member_count}` directly.

If we'd rather show "open tabs" instead of "all members" (excluding closed-tabs popover), use `open_thread_ids.length` from `ChatGroupSummary`. I'd recommend `member_count` (total) — closed tabs still belong to the group conceptually and the higher number gives a more honest sense of the folder's contents. Easy to flip later if the team prefers the other reading.

## R2-UI-4 — Sidebar: add a "Workspace" subheader above Computer / Chat History / Connections / Apps

Refs:

- `src/components/sidebar/app-sidebar.tsx:113-148`

The third `<SidebarGroup>` currently has no `<SidebarGroupLabel>`, so it floats below the chat groups list with no visual hierarchy. Add a label that mirrors the "Chat Groups" label style.

```tsx
<SidebarGroup>
  <SidebarGroupLabel>Workspace</SidebarGroupLabel>
  <SidebarMenu>
    {/* Computer / Chat History / Connections / Apps — unchanged */}
  </SidebarMenu>
</SidebarGroup>
```

Suggested label: **"Workspace"** — Computer, Chat History, Connections, and Apps are all workspace-scoped surfaces, and the label echoes the workspace switcher above. Open to alternatives (e.g., "Browse"); implementer can ship with "Workspace" and we'll iterate.

While here: the existing first `<SidebarGroup>` (the "+ New chat" button at `app-sidebar.tsx:86-99`) intentionally has *no* label — it's a primary action, not a list. Leave that as-is.

## R2-UI-5 — Drop the workspace switcher status dot entirely

Refs:

- `src/components/sidebar/workspace-switcher.tsx`
- `src/routes/_app.tsx` (the workspace-status roll-up loaded for the dropdown)

The original spec added a status dot on the workspace switcher's trigger avatar that aggregated activity across the active workspace. With the chat-groups list directly below the switcher — and now showing per-group running/unread indicators in its right slot per R2-UI-3 — the avatar dot becomes redundant. The same information is one row away.

Recommendation:

- **Remove the trigger overlay.** The avatar reverts to its pre-feature appearance: just the workspace's letter on its colored background, with no `<ThreadStatusDot>` ring.
- **Remove per-row dots in the dropdown** for non-current workspaces too. Cross-workspace status doesn't have a peer surface in this dropdown (chat groups for other workspaces aren't visible here), but it's still extra visual weight and inconsistent with the trigger now being clean. Drop it.
- **Delete the workspace-status roll-up** in the layout loader (`Record<workspaceId, ThreadStatus>`) once nothing consumes it. The implementer should grep for that field's name post-change; if zero hits, delete the loader code and the typed field on the layout context.

This simplifies §5.5 of the original plan: status aggregation now stops at the group level. No "workspace status" concept needed.

If we later decide we *do* want a cross-workspace activity hint (e.g., "Marketing has running chats while you're in Production"), do it as a separate, deliberate affordance on the workspace switcher dropdown items — not a dot on the trigger.

## R2-UI-6 — Unread color: red everywhere (and possibly delete `<ThreadStatusDot>`)

The original plan used emerald for "completed, awaiting review." This iteration switches that to red, matching the standardize-tab-size prototype behavior.

The new components built in this pass — `<TabRightSlot>` (R2-UI-2.5), `<ChatGroupRightSlot>` (R2-UI-3.1), `<ChatGroupCollapsedIcon>` (R2-UI-3.2) — all hard-code `bg-red-500` on the unread state directly, so they're already on the new color.

That leaves `<ThreadStatusDot>` (`src/components/thread-status-dot.tsx:21`) as the only place still using `bg-emerald-500`. After R2-UI-3 and R2-UI-5 land, it has no consumers (tabs use `<TabRightSlot>`, sidebar groups use `<ChatGroupRightSlot>` / `<ChatGroupCollapsedIcon>`, workspace switcher has no dot at all). So the implementer's choice is:

- **Preferred:** delete `src/components/thread-status-dot.tsx`. Confirm with `rg "ThreadStatusDot" src/` first — expected output is zero references after R2-UI-2/3/5. Remove any test imports too.
- **Fallback (only if some other surface picked it up):** flip the constant.

  ```diff
  - status === "unread" && "bg-emerald-500",
  + status === "unread" && "bg-red-500",
  ```

Either way the visible result is the same: every "awaiting your review" indicator across the app is now red.

## Implementation order

Suggested batching for one PR (or a tight pair of PRs):

1. **Tab bar redesign (R2-UI-2)** — biggest change. Includes the data-plumbing tweak to add `model: LlmModel` to `ChatTab`, the inline `+`, the `<TabRightSlot>` component, the folder-merge styling, and removing the leftmost `<ThreadStatusDot>` from each tab.
2. **Sidebar group row redesign (R2-UI-3)** — `<ChatGroupRightSlot>`, `<ChatGroupCollapsedIcon>`, drop chevron, drop leading `<ThreadStatusDot>`, add `tooltip={group.name}`, verify the existing New Chat tooltip works in collapsed mode.
3. **Sidebar Workspace label (R2-UI-4)** — one line.
4. **Drop the workspace switcher dot (R2-UI-5)** — strip the avatar overlay, the dropdown-row dots, and the workspace-status roll-up loader code if nothing else consumes it.
5. **Hide the breadcrumb header on desktop (R2-UI-1)** — one-line `className="md:hidden"` on the chat-surface `<PageHeader>`. Do this *after* steps 1-4 so the desktop chat surface looks clean in the same screenshot.
6. **Cleanup (R2-UI-6)** — `rg "ThreadStatusDot" src/`; delete the component if unused, otherwise flip emerald → red.

## Tests / verification

- Update `tests/chat-groups-ui.test.tsx`: add cases for
  - (a) `<TabRightSlot>` rendering each of `idle` (model logo) / `running` (spinner) / `unread` (red dot).
  - (b) Hover overlay revealing pencil + close without changing layout width.
  - (c) Inline `+` adding a new tab in the active group.
  - (d) `<ChatGroupRightSlot>` rendering `count` always, status icon only when non-idle, and the count's right-edge position not shifting between states.
  - (e) Group row carries `tooltip={group.name}` (assert the underlying button receives the prop; the actual collapsed-mode rendering is shadcn's responsibility).
  - (f) Sidebar group row no longer renders `<ChevronRight>`; "Workspace" `<SidebarGroupLabel>` is present.
  - (g) Workspace switcher trigger renders no `<ThreadStatusDot>`; dropdown rows render no per-row dot.
- `tests/Chat.test.tsx`: assert the chat surface's `<PageHeader>` wrapper has `md:hidden` (or that no `<PageHeader>` is rendered at desktop widths if the implementer goes the conditional-render route).
- Manual checks (no e2e change required): cmd+B + sidebar rail toggle work on desktop without a header; `<PageHeader>` still appears below 768px and the trigger inside it works; tab overflow scroll with 8+ tabs; long titles truncating before the right slot; running/unread/idle transitions on tab and group rows not shifting any other content; folder-merge visual on light and dark themes; collapsed sidebar — first-letter avatar / spinner / red dot priorities, tooltips on hover for groups and the New Chat button.

## Out of scope (defer to a follow-up)

- Drag-to-reorder visual feedback (insertion line, ghost preview). Drag still works via the existing handlers; the visual polish can wait.
- Animated tab open/close (slide-in/out). The current instant swap is fine for v1 of this redesign.
- Per-tab provider logo themed for light/dark. `<ModelLogo>` already handles this via `IntegrationIcon`, so verify rather than build.
