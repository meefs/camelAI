# Chat Group Pinning — Plan

**Date:** 2026-07-20
**Branch:** `illianaa/sun-valley`
**Scope:** Let a user pin/unpin a chat group from the group settings menu, surface pinned groups in a "Pinned" section at the top of the sidebar chat list, and keep the sidebar height stable during load via a cookie-cached pinned count that sizes the Pinned skeleton.

---

## 1. Objective

Chat groups are per-user and the sidebar only shows the 10 most-recently-active ones, so a group the user cares about can fall out of view. Add:

1. **Pin / Unpin** as a toggle item in the existing chat-group settings menu (the `⋯` "Group options" dropdown in the chat tab bar). Label reflects current state: "Pin group" / "Unpin group".
2. A **"Pinned" section** in the sidebar, above the existing "Chat Groups" section. Pinned groups always appear there regardless of recency, and are excluded from the recents list. The section renders only when the user has at least one pin.
3. A **fast pinned-count hint** (cookie, SSR-readable — same mechanism as the existing `sidebar_state` cookie) so that while the deferred chat-groups data loads, the Pinned section renders the right number of skeleton rows and the sidebar height does not jump when real data arrives.

Everything is per-user by construction: groups already live in each user's own `UserDO`, so a `pinned_at` column on `chat_groups` is inherently a personal preference. No OrgDO/WorkspaceDO changes.

---

## 2. Current State (one-screen recap)

```
Sidebar (src/components/sidebar/app-sidebar.tsx:259-419)      Tab bar (src/components/chat-tab-bar.tsx)
┌──────────────────────┐
│ [WS] Workspace ▾     │  SidebarHeader → WorkspaceSwitcher    ┌────────┬────────┐───┬───┬───┐
│                      │                                       │ Tab 1  │ Tab 2  │ + │ ⌄ │ ⋯ │
│ ＋ New chat          │  SidebarGroup (unlabeled)             └────────┴────────┘───┴───┴─┬─┘
│                      │                                                                  │
│ WORKSPACE            │  SidebarGroup "Workspace"                     ┌──────────────────┴┐
│ 💬 Chat History      │                                               │ Rename group      │ ← only item
│ 🔌 Connections       │                                               └───────────────────┘
│ ▦  Apps              │                                               DropdownMenu, chat-tab-bar.tsx:521-548
│ ⏰ Automations       │
│                      │
│ CHAT GROUPS          │  SidebarGroup "Chat Groups" (app-sidebar.tsx:318-332)
│ ◧ Data cleanup     1 │  <ChatGroupsList /> — top 10 by updated_at DESC
│ ◧ Q3 report ●      4 │  (chat-groups-list.tsx; rows = HoverCard + SidebarMenuButton,
│ ◧ Onboarding       2 │   avatar icon, truncated name, right slot = open count/status,
│ …                    │   hover X close action, FLIP reorder animation)
│ ⭡ Upgrade / ❓ / 👤  │  SidebarFooter
└──────────────────────┘
```

- **Storage:** `chat_groups` table in `workers/main/src/identity/user-do.ts:534-542` (per-user DO SQLite, schema V11, `CURRENT_SCHEMA_VERSION = 11` at `user-do.ts:719`). Columns: `id, org_id, workspace_id, name, last_active_thread_id, created_at, updated_at` + avatar columns added by V10/V11 ALTERs (`user-do.ts:576-597, 639-653`). No pin concept exists anywhere in the repo.
- **List query:** `UserDO.listChatGroups` (`user-do.ts:1304-1324`) — `ORDER BY updated_at DESC LIMIT ?`, default limit 10. Called by `listGroupsForWorkspace` (`src/lib/chat-groups.server.ts:278-305`), which hydrates into `ChatGroupView[]`.
- **Loader:** `src/routes/_app.tsx:179-216` returns `chatGroups` as a **deferred promise**. `ChatGroupsProvider` (`src/hooks/use-chat-groups.tsx:908`) resolves it; while unresolved, `ChatGroupsList` renders **5 hardcoded `SidebarMenuSkeleton` rows** (`chat-groups-list.tsx:181-191`). This is the height-jump the pinned-count hint must fix.
- **Group mutations:** `PATCH /api/chat-groups/:id` (`src/routes/api/chat-groups.$id.ts:21-57`) accepts `{ name?, avatar? }` → `userStub.updateChatGroup(groupId, updates)` (`user-do.ts:1373-1424`). Client pattern: `fetch` → `useRevalidator().revalidate()` (see `src/lib/chat-group-rename.client.ts:17-56`). Avatar changes also dispatch a `CustomEvent("camelai:chat-group-avatar")` for an optimistic local patch (`use-chat-groups.tsx:1087`).
- **Settings menu:** the `⋯` DropdownMenu in `chat-tab-bar.tsx:521-548` has exactly one item, "Rename group". The rename handler is wired from both chat routes (`_app.chat.$id.tsx:1201-1206`, `_app.chat._index.tsx:1156`).
- **Cookie precedent:** sidebar collapsed state is the `sidebar_state` cookie, written client-side (`src/components/ui/sidebar.tsx:85`) and read server-side in the `_app` loader via `parseCookies(request)` (`_app.tsx:79-85`) so SSR renders the right state with no flash. The pinned-count hint copies this mechanism.
- **Client ordering:** `orderChatGroupsForDisplay(groups, pinnedFirstGroupId, …)` (`use-chat-groups.tsx:318-339`) — despite the name, `pinnedFirstGroupId` is only a *transient* "float the active group to the top when it fell outside the limit window" affordance, unrelated to this feature. **Rename that parameter to `activeFirstGroupId`** as part of this work to avoid terminology collision.

---

## 3. Target Design

### 3.1 Sidebar — loaded, loading, and collapsed states

```
LOADED (2 pins)                    LOADING (cookie hint = 2)          COLLAPSED RAIL
┌──────────────────────┐           ┌──────────────────────┐           ┌────┐
│ [WS] Workspace ▾     │           │ [WS] Workspace ▾     │           │ WS │
│                      │           │                      │           │ ＋ │
│ ＋ New chat          │           │ ＋ New chat          │           │────│
│                      │           │                      │           │ 💬 │
│ WORKSPACE            │           │ WORKSPACE            │           │ 🔌 │
│ 💬 Chat History      │           │ 💬 Chat History      │           │ ▦  │
│ 🔌 Connections       │           │ 🔌 Connections       │           │ ⏰ │
│ ▦  Apps              │           │ ▦  Apps              │           │────│
│ ⏰ Automations       │           │ ⏰ Automations       │           │ ◧  │ ← pinned rows
│                      │           │                      │           │ ◧  │
│ PINNED               │           │ PINNED               │           │────│ ← CollapsedRailSeparator
│ ◧ Marketing site   3 │           │ ▢ ▁▁▁▁▁▁▁▁          │           │ ◧  │ ← recent rows
│ ◧ Support bot ●    2 │           │ ▢ ▁▁▁▁▁             │           │ ◧  │
│                      │           │                      │           │ ◧  │
│ CHAT GROUPS          │           │ CHAT GROUPS          │           └────┘
│ ◧ Data cleanup     1 │           │ ▢ ▁▁▁▁▁▁▁▁▁         │
│ ◧ Q3 report        4 │           │ ▢ ▁▁▁▁▁▁            │
│ ◧ Onboarding flow  2 │           │ ▢ ▁▁▁▁▁▁▁▁          │  ← 5 skeleton rows (existing count)
│                      │           │ ▢ ▁▁▁▁▁             │
│ ⭡ Upgrade            │           │ ▢ ▁▁▁▁▁▁▁           │
│ ❓ Get Help          │           │                      │
│ 👤 User              │           │ …footer…             │
└──────────────────────┘           └──────────────────────┘
```

Rules:

- The **Pinned section sits directly above the "Chat Groups" section** (between the "Workspace" `SidebarGroup` and the "Chat Groups" `SidebarGroup`), with a `CollapsedRailSeparator` between Pinned and Chat Groups so the collapsed icon rail shows a hairline between the two clusters — exactly like the existing separators at `app-sidebar.tsx:279, 317`.
- Pinned rows are **visually identical** to recent rows (same avatar icon, name, status, open-count right slot, hover X close, hover card). The section header is the only pin indicator. No pin glyph on the row itself.
- The Pinned section renders **only when** there is ≥1 pinned group, or during loading when the cookie hint says ≥1 (see §7). Zero pins → sidebar looks exactly like today.
- **Loading:** Pinned shows `min(cookieHint, 20)` skeleton rows under a "Pinned" label; Chat Groups keeps its existing 5 skeleton rows. When real data resolves, skeletons swap in place. If the hint was stale the height adjusts once at that moment (unavoidable; the cookie is then rewritten).
- **Empty recents edge:** if every group the user has is pinned, hide the "Chat Groups" `SidebarGroup` entirely (label included) rather than showing a dangling header. The existing "No groups yet" empty state renders only when the user has **no groups at all** (pinned + recent = 0, not loading), inside the Chat Groups section as today.

### 3.2 Settings menu — Pin/Unpin item

```
tab bar:   [◧ Group name]  [Tab 1][Tab 2]  [+] [⌄] [⋯]
                                                    │
                                     ┌──────────────┴──────┐
                                     │ ✎   Rename group    │   Pencil (existing)
                                     │ 📌  Pin group       │   Pin        — when pinned_at == null
                                     └─────────────────────┘
                                     ┌─────────────────────┐
                                     │ ✎   Rename group    │
                                     │ 📌̷  Unpin group     │   PinOff     — when pinned_at != null
                                     └─────────────────────┘
```

- One `DropdownMenuItem` added **after** "Rename group" in the existing menu (`chat-tab-bar.tsx:539-546`). No separator needed for a two-item menu.
- Icons: Lucide `Pin` / `PinOff` (not yet used anywhere in the app; import them in `chat-tab-bar.tsx` alongside the existing `Pencil`/`MoreHorizontal` imports). Follow the exact markup pattern of the Rename item so icon sizing/spacing matches.
- Labels: `Pin group` / `Unpin group`. The state comes from the group's `pinned_at` (§4).
- Selecting the item performs the toggle immediately — no dialog, no confirm.

---

## 4. Data Model — UserDO schema V12

**File:** `workers/main/src/identity/user-do.ts`

```sql
ALTER TABLE chat_groups ADD COLUMN pinned_at INTEGER
```

- `pinned_at` is NULL (unpinned, default for all existing and new groups) or an epoch-ms timestamp (pinned).
- Bump `CURRENT_SCHEMA_VERSION` from 11 → 12 (`user-do.ts:719`) and add the `if (version < 12)` block **following the exact pattern of the V10/V11 avatar-column migrations** (`user-do.ts:576-597, 639-653`) — including whatever the V10/V11 pattern does for fresh-DO table creation (if the canonical `CREATE TABLE chat_groups` block was updated to include avatar columns, add `pinned_at` there too; if fresh DOs replay V9→V12 sequentially, the ALTER alone is enough — match what V10/V11 did).
- No new index. Per-user group tables are tiny (tens of rows) and every query already filters on the indexed `(org_id, workspace_id)`.

**Type change** — `src/types.ts:34-43`, `ChatGroup`:

```ts
export interface ChatGroup {
  // ...existing fields...
  pinned_at: number | null;   // NEW
}
```

`ChatGroupSummary` / `ChatGroupView` inherit it. Update the row→object mapper `toChatGroup()` (`user-do.ts:1169-1206`) to map `pinned_at: row.pinned_at ?? null`.

### 4.1 `updateChatGroup` extension

Extend `UserDO.updateChatGroup(groupId, updates)` (`user-do.ts:1373-1424`) to accept `pinned?: boolean` alongside `name?`/`avatar?`:

- `pinned: true` → `pinned_at = Date.now()`. **No-op if already pinned** (do not overwrite the existing `pinned_at`, or the pinned-section order would shuffle on a redundant pin).
- `pinned: false` → `pinned_at = NULL`. No-op if already unpinned.
- A pin-state change must **not bump `updated_at`**. Unpinning returns the group to its natural recency position: a recently-active group re-enters the recents list, while a stale one falls out of the top-10 window and off the sidebar entirely (still reachable via Chat History). This is deliberate — a long-pinned stale group is usually one the user forgot was pinned; don't resurface it. Check how `updateChatGroup` handles `updated_at` for rename today; if it bumps unconditionally, skip the bump when the update only changes `pinned`. (Note: while pinned, normal activity still bumps `updated_at` via the existing touch paths, so an actively-used group unpins into recents naturally.)

### 4.2 `listChatGroups` — pinned always included

Replace the single query in `UserDO.listChatGroups` (`user-do.ts:1304-1324`) with two, returning pinned-first concatenation:

```sql
-- all pinned groups, oldest pin first (stable positions; new pins append at the bottom)
SELECT * FROM chat_groups
WHERE org_id = ? AND workspace_id = ? AND pinned_at IS NOT NULL
ORDER BY pinned_at ASC;

-- recents: unpinned only, existing limit semantics (default 10)
SELECT * FROM chat_groups
WHERE org_id = ? AND workspace_id = ? AND pinned_at IS NULL
ORDER BY updated_at DESC LIMIT ?;
```

- The `limit` parameter now bounds **unpinned recents only**; pinned groups are always all returned (no cap on how many a user may pin — pathological counts are self-limiting since each pin is a manual per-user action).
- Pinned order is `pinned_at ASC` — the first group you pinned stays at the top forever, new pins append at the bottom. Chosen for positional muscle memory over "newest pin first".
- `listChatGroupsForMove` (`user-do.ts:1326-1338`) is **unchanged** (already unbounded; the move-picker doesn't need pin awareness).
- `getGroupForWorkspace` and single-group fetches are unchanged apart from the new field flowing through `toChatGroup()`.

---

## 5. API — extend the existing PATCH

**File:** `src/routes/api/chat-groups.$id.ts` (PATCH branch, `:21-57`)

Accept `pinned` in the JSON body alongside `name`/`avatar`:

```ts
{ name?: string, avatar?: ..., pinned?: boolean }
```

- Validate `typeof pinned === "boolean"` when present; 400 otherwise. At least one of `name` / `avatar` / `pinned` must be present (extend the existing "nothing to update" validation).
- Pass through to `userStub.updateChatGroup(groupId, { ...existing, pinned })`.
- Auth is already handled (`requireSessionWorkspaceAccess(..., { requireWrite: true })` + group-ownership check in the existing handler). No new route, no changes to `src/routes.ts`.

No websocket work: group metadata (rename/avatar) already propagates via revalidation only, and pin follows the identical path.

---

## 6. Server Hydration

**File:** `src/lib/chat-groups.server.ts`

- `hydrateChatGroups` (`:157-276`) and `listGroupsForWorkspace` (`:278-305`): pass `pinned_at` through onto `ChatGroupView`. No other logic changes — hydration (thread loads, streaming statuses, viewed timestamps) is orthogonal to pinning.
- Note the payload grows only by the pinned rows that were previously outside the top-10 window. For typical users (0–5 pins) this is negligible.

---

## 7. Fast Pinned Count — cookie hint

**Goal:** during the deferred `chatGroups` load, render the Pinned section (header + N skeleton rows) at the correct height from the very first paint, SSR included.

**Mechanism:** a cookie, mirroring `sidebar_state` (`src/components/ui/sidebar.tsx:27-28, 85` written client-side; read server-side at `_app.tsx:79-85`). A cookie — not localStorage — because the `_app` loader runs server-side and localStorage would cause an SSR/hydration mismatch (server renders 0 pinned skeletons, client wants N). A cookie read in the loader flows through loader data, so server and client render identically. Not a server-side KV/DO count either: that would add a blocking DO roundtrip to every app-shell load, while the cookie costs nothing and staleness is benign (a one-time height adjustment when data resolves).

**New file:** `src/lib/pinned-groups-cookie.ts`

```ts
export const PINNED_GROUPS_COOKIE_NAME = "pinned_groups";
const MAX_WORKSPACE_ENTRIES = 8;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // match SIDEBAR_COOKIE_MAX_AGE

// Server-safe. Parses the cookie value (encodeURIComponent'd JSON map of
// workspaceId -> count), returns the count for this workspace clamped to 0..20.
// Malformed/absent cookie -> 0.
export function readPinnedGroupCountHint(
  cookieValue: string | undefined,
  workspaceId: string,
): number;

// Client-only (document.cookie; path=/; max-age above). Upserts this workspace's
// count into the map. Moves the key to the end (JSON key order = insertion order)
// and prunes oldest entries beyond MAX_WORKSPACE_ENTRIES. Writes only when the
// stored value actually changes.
export function writePinnedGroupCountHint(workspaceId: string, count: number): void;
```

**Wiring:**

- `_app.tsx` loader: read the cookie with the same `parseCookies(request)` helper already used for `sidebar_state`, and add a **resolved** (non-deferred) field to loader data: `pinnedGroupCountHint: readPinnedGroupCountHint(cookies[PINNED_GROUPS_COOKIE_NAME], workspaceId)`.
- `ChatGroupsProvider` (`use-chat-groups.tsx`): in an effect, whenever the resolved group list changes, call `writePinnedGroupCountHint(workspaceId, groups.filter(g => g.pinned_at !== null).length)`. The provider already knows the current `workspaceId` (it builds the status-WS URL from it).
- The pin/unpin client helper (§8.3) also rewrites the cookie immediately on a successful toggle so a reload right after pinning is already correct.

**Staleness behavior (acceptable, by design):** if the user changed pins in another browser, the first paint shows the old count's skeletons; when data resolves the section corrects itself once and the cookie is rewritten. A workspace not present in the map hints 0 → pinned section appears only when data resolves (same as today's behavior for the whole list).

---

## 8. UI Implementation

### 8.1 `AppSidebar` — two sections

**File:** `src/components/sidebar/app-sidebar.tsx`

Split the group list where the single "Chat Groups" `SidebarGroup` renders today (`:318-332`):

```tsx
const { groups, activeGroupId, isLoading } = useChatGroups();
const pinnedGroupCountHint = /* from useRouteLoaderData("routes/_app") */;

const pinnedGroups = groups.filter((g) => g.pinned_at !== null);
// server already orders pinned_at ASC, but re-sort defensively after client-side
// optimistic patches:
pinnedGroups.sort((a, b) => (a.pinned_at ?? 0) - (b.pinned_at ?? 0));
const recentGroups = groups.filter((g) => g.pinned_at === null);

const pinnedSkeletonCount = Math.min(pinnedGroupCountHint, 20);
const showPinnedSection =
  pinnedGroups.length > 0 || (isLoading && groups.length === 0 && pinnedSkeletonCount > 0);
const showRecentsSection =
  isLoading || recentGroups.length > 0 || pinnedGroups.length === 0; // hide only when all groups are pinned
```

```tsx
{showPinnedSection && (
  <>
    <SidebarGroup>
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      <ChatGroupsList
        groups={pinnedGroups}
        skeletonCount={pinnedSkeletonCount}
        emptyState={null}
        /* ...same handler props as the existing list... */
      />
    </SidebarGroup>
    <CollapsedRailSeparator />
  </>
)}
{showRecentsSection && (
  <SidebarGroup>
    <SidebarGroupLabel>Chat Groups</SidebarGroupLabel>
    <ChatGroupsList
      groups={recentGroups}
      /* skeletonCount defaults to 5, emptyState defaults to existing "No groups yet" */
      /* ...existing handler props unchanged... */
    />
  </SidebarGroup>
)}
```

All existing handlers (`onSelectGroup`, `handleCloseGroup`, move/reopen, `onSelectThread` for the hover card) are passed to **both** lists unchanged — pinned rows keep every existing behavior, including the hover X close (closing a pinned group deletes it like any other; the pin dies with the row; the existing AlertDialog confirm already guards this).

### 8.2 `ChatGroupsList` — two small props

**File:** `src/components/sidebar/chat-groups-list.tsx`

```ts
interface ChatGroupsListProps {
  // ...existing props...
  skeletonCount?: number;        // default 5 (current hardcoded value at :181-191)
  emptyState?: ReactNode | null; // default: existing "No groups yet" div; null renders nothing
}
```

- Skeleton branch (`isLoading && groups.length === 0`): render `skeletonCount` `SidebarMenuSkeleton showIcon` rows instead of the literal 5. When `skeletonCount === 0`, render nothing (the caller hides the whole section anyway).
- Empty branch: render `emptyState` (so the pinned list never shows "No groups yet").
- Everything else (row markup, HoverCard, FLIP via `useFlipList`) is untouched. Each list instance gets its own FLIP scope; a group moving between sections unmounts from one list and mounts in the other with **no cross-section animation** — acceptable, do not build one.

### 8.3 Pin/unpin client helper + menu wiring

**New file:** `src/lib/chat-group-pin.client.ts` — mirror `chat-group-rename.client.ts:17-56`:

```ts
export async function saveChatGroupPinned(opts: {
  groupId: string;
  workspaceId: string;
  pinned: boolean;
  currentPinnedCount: number;   // pinned count before the toggle, for the cookie
  revalidate?: () => void;
}): Promise<boolean>
```

Behavior, in order:

1. Dispatch the optimistic `CustomEvent("camelai:chat-group-pinned", { detail: { groupId, pinnedAt: pinned ? Date.now() : null } })` (see §8.4).
2. `writePinnedGroupCountHint(workspaceId, currentPinnedCount + (pinned ? 1 : -1))`.
3. `fetch(\`/api/chat-groups/${id}\`, { method: "PATCH", body: JSON.stringify({ pinned }) })`.
4. On failure: dispatch the event again with the reverted value, restore the cookie, and show a sonner toast — `"Couldn't pin group. Please try again."` / `"Couldn't unpin group. Please try again."`. **No success toast** — the group visibly moving into/out of the Pinned section is the feedback.
5. `revalidate?.()` (success and failure both, to settle on server truth).

**Menu wiring** — `src/components/chat-tab-bar.tsx`:

- Add props `groupPinnedAt: number | null` and `onTogglePin: () => void` to `ChatTabBar`, wired from both chat routes exactly like the existing rename wiring (`_app.chat.$id.tsx:1201-1206`, `_app.chat._index.tsx:1156`) — both routes already hold the authoritative group record in loader data.
- The new `DropdownMenuItem` (placed after "Rename group"):

```tsx
<DropdownMenuItem onSelect={onTogglePin}>
  {groupPinnedAt !== null ? <PinOff /> : <Pin />}
  {groupPinnedAt !== null ? "Unpin group" : "Pin group"}
</DropdownMenuItem>
```

- The route-level `onTogglePin` calls `saveChatGroupPinned` with the group's current state and `useRevalidator().revalidate`.

### 8.4 Optimistic local patch in the provider

**File:** `src/hooks/use-chat-groups.tsx`

Copy the existing avatar-patch mechanism (`camelai:chat-group-avatar` listener at `:1087` and its patch application) for a new `camelai:chat-group-pinned` event:

- Maintain a `Map<groupId, number | null>` of pinned patches; apply them onto resolved groups in the same place avatar patches are applied (overriding `pinned_at`).
- Clear a group's patch when a fresh loader result already reflects it (same lifecycle as avatar patches).
- Also in this file: rename `orderChatGroupsForDisplay`'s `pinnedFirstGroupId` parameter (and the local `pinned` variable at `:334`) to `activeFirstGroupId` / `activeFirst`. Its behavior is unchanged — it still floats the *active* group into view when the loader's bounded list missed it; after the split, that injected group lands in whichever section its `pinned_at` says. No logic change needed beyond the rename: `AppSidebar` splits *after* ordering.
- **Unpinning the active group:** the `⋯` menu lives in the tab bar, so the group being unpinned is always the active one. If it's stale (outside the recents window), the post-revalidation server list no longer contains it — the existing active-group injection keeps it visible in the recents section until the user navigates elsewhere, at which point it drops off the sidebar. This is the same mechanism that keeps a history-opened, out-of-window group visible today; verify it covers this case during implementation.

### 8.5 Single-placement invariant

A group id must never render in both sections:

- **Server:** the recents query excludes pinned rows (`AND pinned_at IS NULL`, §4.2), so the loader list contains each group at most once.
- **Client split:** `AppSidebar` partitions one array by `pinned_at` (§8.1) — a group lands in exactly one section, including while an optimistic pin patch is applied (the patch rewrites `pinned_at` before the split happens).
- **Active-group injection:** when `orderChatGroupsForDisplay` merges the active group into the list because the bounded loader list missed it, it must dedupe by id — a pinned active group is already present from the pinned query and must not be inserted a second time into recents. Verify the existing merge already dedupes by id; add the guard if it doesn't.

Covered by tests in §12.1 and §12.3.

---

## 9. Decisions (settled — do not re-open)

| Question | Decision | Why |
|---|---|---|
| Per-user or shared pin? | Per-user | Groups themselves are per-user UserDO rows; there is no shared entity to pin. |
| Boolean or timestamp? | `pinned_at INTEGER NULL` | One column gives both the flag and a stable section order. |
| Pinned section order | `pinned_at ASC`, new pins append at bottom | Positional muscle memory; existing pins never shuffle. |
| Pin/unpin bumps `updated_at`? | No | Unpin returns the group to its natural recency; a stale group drops off the sidebar (Chat History still has it). A long-pinned stale group is usually a forgotten pin — don't resurface it. |
| Recents limit | Still 10, unpinned only; pinned uncapped | Pinning something shouldn't evict a recent group from view. |
| Can a group show in both sections? | Never | Server excludes pinned from recents; client splits one array by `pinned_at`; active-group injection dedupes by id (§8.5). |
| Where is Pin/Unpin? | Tab-bar `⋯` menu only | That is "the chat group settings" per the ask. No sidebar-row context menu in this change. |
| Section visibility | Pinned section hidden at 0 pins; Chat Groups section hidden only when all groups are pinned | Zero-pin users see today's exact sidebar. |
| Fast count | Cookie (`pinned_groups`), SSR-read in `_app` loader | Matches `sidebar_state` precedent; zero server latency; no hydration mismatch; stale = one-time benign height adjustment. |
| Pin indicator on rows | None | The section header is the indicator; rows stay identical/reusable. |
| Confirm/toast on pin | No confirm; toast on failure only | The section move is the success feedback. |

---

## 10. Required vs cuttable

**Required (the feature):** §4 migration + `updateChatGroup` + `listChatGroups`; §5 PATCH extension; §6 hydration passthrough; §8.1/8.2 sidebar sections; §8.3 helper + menu item.

**Required per the ask, but severable if it fights back:** §7 cookie hint + skeleton sizing. If cut, the Pinned section simply appears when data resolves (height jump on cold load only) — ship the rest regardless.

**Cuttable:** §8.4 optimistic CustomEvent patch (without it, the section move lands after the revalidation roundtrip — the cookie write in §8.3 still happens). Cut this before cutting anything else.

**Explicitly not in scope:** drag-to-reorder pins, pinning individual threads/tabs, a sidebar-row context menu, pin state in the tab bar UI, cross-section FLIP animation, caching the recents skeleton count (stays 5).

---

## 11. Implementation Order

1. UserDO V12 migration, `toChatGroup` mapping, `updateChatGroup({ pinned })`, split `listChatGroups` queries. Tests alongside (§12.1).
2. `ChatGroup` type + `chat-groups.server.ts` passthrough + PATCH route extension. Tests (§12.2).
3. `pinned-groups-cookie.ts` + `_app.tsx` loader hint + provider cookie-write effect.
4. `ChatGroupsList` `skeletonCount`/`emptyState` props; `AppSidebar` two-section split.
5. `chat-group-pin.client.ts` + tab-bar menu item + wiring in both chat routes.
6. Provider optimistic patch + `pinnedFirstGroupId` → `activeFirstGroupId` rename.
7. `bun run typecheck`, focused test suites, and a manual pass: pin from menu → group moves from recents into Pinned (never both); reload → skeleton height stable; unpin a recently-active group → it re-enters recents; unpin a stale group → it stays visible only while active and leaves the sidebar after navigating away; zero pins → sidebar identical to today; collapsed rail shows separated clusters.

Each step leaves the app working; steps 1–2 are shippable dark (no UI reads `pinned_at` yet).

---

## 12. Tests

### 12.1 UserDO — extend `workers/main/tests/user-do-chat-groups.test.ts`

- V12 migration: idempotent; existing V11 group/avatar data survives; fresh DO creates the column.
- `updateChatGroup({ pinned: true })` sets `pinned_at` and leaves `updated_at` unchanged; repeat call is a no-op (same `pinned_at`); `{ pinned: false }` clears `pinned_at`, `updated_at` still unchanged; combined `{ name, pinned }` updates both fields (name keeps rename's existing `updated_at` behavior).
- `listChatGroups`: returns all pinned (even when unpinned count exceeds the limit); a pinned group never appears in the recents result, even when its `updated_at` is in the top 10; pinned ordered `pinned_at ASC`; unpinned ordered `updated_at DESC` capped at limit; a workspace with only pinned groups returns them with no recents; pin state does not leak across `(org_id, workspace_id)` scopes.

### 12.2 Route — extend the chat-groups route tests (`tests/chat-groups-routes.test.ts` or current equivalent)

- PATCH with `{ pinned: true }` / `{ pinned: false }` toggles the flag; response reflects it.
- PATCH with non-boolean `pinned` → 400; empty body still → 400; existing `{ name }`-only and `{ avatar }`-only behavior unchanged.
- Auth: non-member and read-only access rejected (existing helpers; verify pin path inherits them).

### 12.3 UI — extend `tests/chat-groups-ui.test.tsx` + new cookie test

- `readPinnedGroupCountHint`: absent/malformed cookie → 0; clamps to 0..20; per-workspace lookup. `writePinnedGroupCountHint`: upsert, insertion-order pruning at 8 entries, no-op write when unchanged.
- Sidebar split: pinned section renders only when pins exist; ordering `pinned_at ASC`; all-pinned hides the Chat Groups section; zero groups shows existing empty state; loading with hint N renders N pinned skeletons + 5 recent skeletons; hint 0 renders no pinned section while loading.
- Menu item: label/icon flips on `groupPinnedAt`; select calls the helper with the right `pinned` value.
- Optimistic patch: `camelai:chat-group-pinned` event moves a group between sections (never rendering in both) before revalidation; failure path reverts.
- No duplicates: a pinned group that is also the active group renders once, in the Pinned section only, even when the active-group injection path runs; a just-unpinned stale active group renders once in recents (injected) until navigation.

Commands:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts
bun run test:run -- tests/chat-groups-ui.test.tsx tests/pinned-groups-cookie.test.ts
```

---

## 13. Key Files

| File | Change |
|---|---|
| `workers/main/src/identity/user-do.ts` | V12 migration (`pinned_at`); `updateChatGroup` accepts `pinned`; `listChatGroups` pinned-first split queries; `toChatGroup` maps the field. |
| `src/types.ts` | `ChatGroup.pinned_at: number \| null`. |
| `src/lib/chat-groups.server.ts` | Pass `pinned_at` through hydration. |
| `src/routes/api/chat-groups.$id.ts` | PATCH accepts/validates `pinned?: boolean`. |
| `src/lib/pinned-groups-cookie.ts` | **New.** Cookie read (server-safe) / write (client) helpers. |
| `src/routes/_app.tsx` | Loader reads cookie → resolved `pinnedGroupCountHint` in loader data. |
| `src/hooks/use-chat-groups.tsx` | Cookie-write effect on resolve; optimistic `camelai:chat-group-pinned` patch; rename `pinnedFirstGroupId` → `activeFirstGroupId`. |
| `src/components/sidebar/app-sidebar.tsx` | Split into Pinned + Chat Groups sections with visibility rules and skeleton counts; `CollapsedRailSeparator` between them. |
| `src/components/sidebar/chat-groups-list.tsx` | `skeletonCount` / `emptyState` props. |
| `src/lib/chat-group-pin.client.ts` | **New.** `saveChatGroupPinned` (optimistic event → cookie → PATCH → revert/toast on failure → revalidate). |
| `src/components/chat-tab-bar.tsx` | `Pin`/`PinOff` imports; `groupPinnedAt`/`onTogglePin` props; menu item after "Rename group". |
| `src/routes/_app.chat.$id.tsx`, `src/routes/_app.chat._index.tsx` | Wire `groupPinnedAt` + `onTogglePin` into `ChatTabBar` (mirror the rename wiring). |
| `workers/main/tests/user-do-chat-groups.test.ts`, `tests/chat-groups-ui.test.tsx`, `tests/pinned-groups-cookie.test.ts` | Tests per §12. |
