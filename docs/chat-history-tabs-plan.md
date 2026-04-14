# Chat History: Pagination Fix + Per-Creator Filter Tabs

## Problems

1. **Pagination is broken.** The "show more" / infinite scroll sentinel exists in the UI but the `loadMore` callback is a no-op (`// TODO`). Users see at most 50 threads, and scrolling to the bottom does nothing.

2. **No personal vs. team filtering.** On multi-member orgs, users see every thread in the workspace with no way to focus on their own work or browse what teammates have been doing.

---

## Design

### Full Page Layout

The page has four vertical sections in order: search, workspace scope tabs, count + select row, creator filter tabs, then the scrollable thread list.

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 Search chats...                                          │
├──────────────────────────────────────────────────────────────┤
│  This workspace        All workspaces                        │
│  ──────────────                                              │
├──────────────────────────────────────────────────────────────┤
│  52 chats                                          [Select]  │
├──────────────────────────────────────────────────────────────┤
│  All       ⬤ You       ⬤ Alice C       ⬤ Bob               │
│  ───                                                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Fix login redirect bug                                 │  │
│  │ ⬤ You · 2 hours ago                                   │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Add Stripe webhook handler                             │  │
│  │ ⬤ Alice C · 5 hours ago                               │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Debug CSS grid layout                                  │  │
│  │ ⬤ Bob · yesterday                                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│              ◌  Loading more chats...                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

When the "You" tab is selected, notice the count updates and only your threads appear:

```
├──────────────────────────────────────────────────────────────┤
│  34 chats                                          [Select]  │
├──────────────────────────────────────────────────────────────┤
│  All       ⬤ You       ⬤ Alice C       ⬤ Bob               │
│            ─────                                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Fix login redirect bug                                 │  │
│  │ 2 hours ago                                            │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Set up CI pipeline                                     │  │
│  │ 3 hours ago                                            │  │
│  └────────────────────────────────────────────────────────┘  │
```

### Creator Tab Bar — Exact UI Spec

This is a second `<Tabs>` row using the existing shadcn `Tabs` + `TabsList` + `TabsTrigger` with `variant="line"`. It lives directly below the count/select controls row.

**Visibility rule:** This entire row is hidden when only one person has threads in the current scope. Solo users never see it. The check is: if the `threadCreators` array from the loader has length <= 1, do not render this `<Tabs>` at all.

**Tab items (left to right):**

1. **"All"** — plain text, no avatar. This is the default selected tab. Shows all threads (same as current behavior).

2. **"You"** — the current user's avatar + the label "You". Always present when the row is visible.

3. **One tab per teammate** — each teammate who has at least one thread in the current scope gets a tab. Ordered by most recent thread activity (the teammate whose most recent `updated_at` is newest appears first). Each tab shows avatar + first name.

**Each avatar tab trigger looks like this internally:**

```tsx
<TabsTrigger value={userId} className="gap-1.5">
  <Avatar size="2xs">
    <AvatarFallback
      content={avatarContent}
      style={{ backgroundColor: avatarColor, color: getContrastTextColor(avatarColor) }}
    >
      {avatarContent}
    </AvatarFallback>
  </Avatar>
  {label}
</TabsTrigger>
```

- Avatar size: `"2xs"` (the `size-3.5` / 14px variant — same size used for creator avatars in `ChatRow`).
- Avatar content and color: use the user's `avatar.content` and `avatar.color` from their profile. Fall back to `getInitials(name ?? email)` for content and `generateDefaultAvatar(name ?? email).color` for color if avatar is null.
- Label for current user: `"You"` (not their name).
- Label for teammates: first name only (`name.split(' ')[0]`). If name is null, use email prefix before `@`. Truncate with `className="truncate max-w-[100px]"` so a long name doesn't blow out the tab bar.
- The "All" tab has no avatar — just the text "All".

**Interaction:** Clicking a creator tab sets a `createdBy` URL search param. "All" clears it. This triggers a loader revalidation that passes `createdBy` to the paginated query (already supported by `OrgDO.getThreadsPaginated`). Pagination offset resets to 0.

### Chat Row Changes When a Specific Creator Is Selected

When the "All" tab is active, each `ChatRow` shows the creator avatar + name in the subtitle line (current behavior):

```
Fix login redirect bug
⬤ Alice C · 2 hours ago
```

When a specific creator tab is selected (e.g. "You" or "Alice C"), the creator avatar and name are redundant — every row belongs to the same person. Hide them and show only the timestamp:

```
Fix login redirect bug
2 hours ago
```

This is controlled by a new `hideCreator` boolean prop on `ChatRow` / `ChatsList`. When `true`, skip rendering `creatorWithTooltip` and the `·` separator.

### Count Label Behavior

The count label (`"52 chats"`) in the controls row always reflects the `total` from the current paginated query — which accounts for the active workspace scope AND the active creator filter. When the user switches tabs, the loader returns a new `total` scoped to that filter.

---

## Implementation

### Step 1: Fix Pagination (the actual bug)

The infinite-scroll plumbing exists but `loadMore()` is empty. Fix it using `useFetcher` to append pages without full-page revalidation.

**File: `src/components/pages/history/history-client.tsx`**

Current broken state:
```typescript
const loadingMore = false; // TODO: Implement load more with URL params
const loadMore = useCallback(() => {
  // TODO: Implement pagination with URL params
}, []);
```

Fix approach:
- Add a **resource route** at `src/routes/api/history.tsx` that returns the next page of threads as JSON.
- In `history-client.tsx`, use a second `useFetcher` (separate from the existing action fetcher) to call `fetcher.load('/api/history?offset=...&...')` when the intersection observer fires.
- Maintain a local `allThreads` state, seeded from `initialThreads`. When the load fetcher returns data, append the new threads.
- Track `currentOffset` in state. Increment by `PAGE_SIZE` on each successful load.
- Guard against double-fetching: only call `fetcher.load()` when `fetcher.state === 'idle'`.
- Reset `allThreads` and `currentOffset` back to initial values whenever the filter URL params change (workspace scope or creator tab). Use the `initialThreads` prop as the reset source — React Router re-runs the loader on param changes, so `initialThreads` will be fresh.

**New file: `src/routes/api/history.tsx`**

A resource route (no default export / no UI) that returns paginated threads as JSON. Accepts query params:
- `offset` (number, default 0)
- `limit` (number, default 50)
- `scope` (`this-workspace` | `all-workspaces`)
- `createdBy` (optional user ID string)
- `workspaceId` (string, for workspace-scoped queries)

This route reuses the same `chatDO.getThreadsPaginated()` / `chatDO.getThreadsPaginatedAllWorkspaces()` calls plus creator hydration logic extracted from the existing loader into a shared helper. Returns `{ threads: Thread[], total: number, offset: number, limit: number }`.

Add this route to `src/routes.ts` as a layout-less API route: `route("api/history", "routes/api/history.tsx")`.

### Step 2: Add `getThreadCreators` Method to OrgDO

**File: `workers/main/src/auth.ts`** (OrgDO class)

Add a new method that returns the list of unique creators who have threads, with their thread count and most recent activity:

```typescript
getThreadCreators(
  workspaceId?: string
): Array<{ created_by: string; thread_count: number; latest_updated_at: number }> {
  this.ensureThreadSchemaColumns();
  const whereSql = workspaceId ? 'WHERE workspace_id = ?' : '';
  const params = workspaceId ? [workspaceId] : [];
  return this.sql.exec(
    `SELECT created_by, COUNT(*) as thread_count, MAX(updated_at) as latest_updated_at
     FROM threads ${whereSql}
     GROUP BY created_by
     ORDER BY latest_updated_at DESC`,
    ...params
  ).toArray() as Array<{ created_by: string; thread_count: number; latest_updated_at: number }>;
}
```

For the "All workspaces" scope, add an overload that accepts `workspaceIds: string[]`:

```typescript
getThreadCreatorsAllWorkspaces(
  workspaceIds: string[]
): Array<{ created_by: string; thread_count: number; latest_updated_at: number }> {
  this.ensureThreadSchemaColumns();
  if (workspaceIds.length === 0) return [];
  const placeholders = workspaceIds.map(() => '?').join(', ');
  return this.sql.exec(
    `SELECT created_by, COUNT(*) as thread_count, MAX(updated_at) as latest_updated_at
     FROM threads WHERE workspace_id IN (${placeholders})
     GROUP BY created_by
     ORDER BY latest_updated_at DESC`,
    ...workspaceIds
  ).toArray() as Array<{ created_by: string; thread_count: number; latest_updated_at: number }>;
}
```

**File: `src/lib/chat-do.server.ts`**

Add wrappers:

```typescript
export async function getThreadCreators(
  context: AppLoadContext,
  workspaceId: string
): Promise<Array<{ created_by: string; thread_count: number; latest_updated_at: number }>> { ... }

export async function getThreadCreatorsAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[]
): Promise<Array<{ created_by: string; thread_count: number; latest_updated_at: number }>> { ... }
```

### Step 3: Update the Loader

**File: `src/routes/_app.history.tsx`**

The loader now:

1. Reads `scope` param (`this-workspace` | `all-workspaces`, default `this-workspace`) — same as the current `filter` param, just renamed for clarity.
2. Reads `createdBy` param (optional user ID).
3. Fetches paginated threads using existing `chatDO.getThreadsPaginated()` with the `createdBy` param when present. The OrgDO method already supports this filter.
4. **In parallel**, fetches the thread creators list via `chatDO.getThreadCreators()`.
5. Hydrates both the thread list and the creator list with user profiles (name, avatar).

Run the thread fetch and creator fetch in parallel with `Promise.all`:

```typescript
const [page, rawCreators] = await Promise.all([
  fetchThreads(scope, createdBy, ...),
  scope === 'all-workspaces'
    ? chatDO.getThreadCreatorsAllWorkspaces(context, accessibleWorkspaceIds)
    : chatDO.getThreadCreators(context, workspaceId),
]);
```

The hydrated creators are returned as:

```typescript
interface ThreadCreator {
  userId: string;
  name: string | null;
  email: string;
  avatar: { color: string; content: string } | null;
  threadCount: number;
}
```

Return shape adds:
```typescript
return {
  threads,
  total: page.total,
  offset: page.offset,
  limit: page.limit,
  orgId: authContext.currentOrg.id,
  hasWorkspace: true,
  threadCreators,       // ThreadCreator[]
  currentUserId,        // string — the logged-in user's ID
};
```

**Creator hydration reuse:** The loader already hydrates creator profiles for the thread list. Extract the profile-fetching logic into a shared helper (`hydrateUserProfiles(env, userIds)`) that both the thread list hydration and the creator tab hydration can call. Deduplicate user IDs across both so we never fetch the same profile twice.

### Step 4: Update the Toolbar — Workspace Scope Tabs

**File: `src/components/history/chats-toolbar.tsx`**

Rename the `filter` prop to `scope` for clarity. The workspace scope tabs stay exactly as they are today:

```tsx
<Tabs value={scope} onValueChange={(v) => onScopeChange(v as 'this-workspace' | 'all-workspaces')}>
  <TabsList variant="line">
    <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
    <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
  </TabsList>
</Tabs>
```

No visual changes to this row.

### Step 5: Add the Creator Filter Tabs

**File: `src/components/history/chats-toolbar.tsx`** (or a new `src/components/history/creator-tabs.tsx` — your call)

Add a new `<Tabs>` component below the count/select controls row. This is a completely separate `<Tabs>` instance from the workspace scope tabs.

**Props needed:**

```typescript
interface CreatorTabsProps {
  creators: ThreadCreator[];    // from loader, sorted by latest activity
  currentUserId: string;
  activeCreatorId: string | null;  // null = "All"
  onCreatorChange: (userId: string | null) => void;
}
```

**Rendering rules:**

1. If `creators.length <= 1`, return `null` — don't render the row at all.

2. Otherwise, render:

```tsx
<Tabs
  value={activeCreatorId ?? 'all'}
  onValueChange={(v) => onCreatorChange(v === 'all' ? null : v)}
>
  <TabsList variant="line">
    {/* "All" tab — no avatar, just text */}
    <TabsTrigger value="all">All</TabsTrigger>

    {/* Current user tab — avatar + "You" */}
    <TabsTrigger value={currentUserId} className="gap-1.5">
      <Avatar size="2xs">
        <AvatarFallback
          content={currentUserAvatar.content}
          style={{
            backgroundColor: currentUserAvatar.color,
            color: getContrastTextColor(currentUserAvatar.color),
          }}
        >
          {currentUserAvatar.content}
        </AvatarFallback>
      </Avatar>
      You
    </TabsTrigger>

    {/* Teammate tabs — avatar + first name, sorted by recent activity */}
    {teammates.map((creator) => (
      <TabsTrigger key={creator.userId} value={creator.userId} className="gap-1.5">
        <Avatar size="2xs">
          <AvatarFallback
            content={creatorAvatar.content}
            style={{
              backgroundColor: creatorAvatar.color,
              color: getContrastTextColor(creatorAvatar.color),
            }}
          >
            {creatorAvatar.content}
          </AvatarFallback>
        </Avatar>
        <span className="truncate max-w-[100px]">{firstName}</span>
      </TabsTrigger>
    ))}
  </TabsList>
</Tabs>
```

**Styling details (important — read carefully):**

- Use `variant="line"` on `TabsList` to match the workspace scope tabs above it. Both tab rows should use the same underline style.
- Avatar size is `"2xs"` (`size-3.5`, 14px). This is the same size used in `ChatRow` for inline creator attribution.
- `gap-1.5` on each `TabsTrigger` creates 6px between the avatar and the label text.
- The avatar uses `AvatarFallback` with inline `style` for `backgroundColor` and `color`, using `getContrastTextColor()` from `@/lib/avatar`. This is the exact same pattern used in `chat-row.tsx` lines 180-185 and `nav-user.tsx` lines 51-56.
- Teammate label: `creator.name ? creator.name.split(' ')[0] : creator.email.split('@')[0]`. Use only the first name / email prefix to keep tabs compact.
- Add `truncate max-w-[100px]` on the teammate label `<span>` to prevent long names from overflowing.
- The "You" tab always appears second (after "All"), regardless of activity order. Teammates follow in `latest_updated_at` descending order.
- If there are many teammates (>6), consider whether horizontal scroll on the `TabsList` is sufficient or if we need an overflow menu. For v1, horizontal scroll is fine — the `TabsList` with `variant="line"` already handles overflow gracefully.

### Step 6: Wire Up the Client

**File: `src/components/pages/history/history-client.tsx`**

**New props:**

```typescript
interface HistoryClientProps {
  initialThreads: Thread[];
  initialOrgId: string;
  initialTotal: number;
  initialOffset: number;
  initialLimit: number;
  threadCreators: ThreadCreator[];
  currentUserId: string;
}
```

**URL search params:** The component now manages two search params:
- `scope` — `this-workspace` (default) | `all-workspaces`
- `createdBy` — user ID string or absent

**Pagination state:**

```typescript
const [allThreads, setAllThreads] = useState(initialThreads);
const [currentOffset, setCurrentOffset] = useState(initialOffset + initialThreads.length);
const [total, setTotal] = useState(initialTotal);
const loadFetcher = useFetcher<{ threads: Thread[]; total: number }>();
const loadingMore = loadFetcher.state !== 'idle';
const hasMore = allThreads.length < total;
```

**Reset on filter change:** When `scope` or `createdBy` URL params change, the loader re-runs and `initialThreads` / `initialTotal` change. Detect this with a `useEffect` keyed on `initialThreads` (by reference) and reset local pagination state:

```typescript
useEffect(() => {
  setAllThreads(initialThreads);
  setCurrentOffset(initialOffset + initialThreads.length);
  setTotal(initialTotal);
}, [initialThreads, initialOffset, initialTotal]);
```

**`loadMore` implementation:**

```typescript
const loadMore = useCallback(() => {
  if (loadingMore || !hasMore) return;
  const params = new URLSearchParams({
    offset: String(currentOffset),
    limit: String(PAGE_SIZE),
    scope,
    workspaceId: currentWorkspace?.id ?? '',
  });
  if (createdBy) params.set('createdBy', createdBy);
  loadFetcher.load(`/api/history?${params}`);
}, [currentOffset, scope, createdBy, loadingMore, hasMore, currentWorkspace?.id]);
```

**Merge fetched pages:**

```typescript
useEffect(() => {
  if (loadFetcher.data?.threads) {
    setAllThreads(prev => [...prev, ...loadFetcher.data.threads]);
    setCurrentOffset(prev => prev + loadFetcher.data.threads.length);
    setTotal(loadFetcher.data.total);
  }
}, [loadFetcher.data]);
```

**Creator tab change handler:**

```typescript
const handleCreatorChange = useCallback((userId: string | null) => {
  setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    if (userId) {
      next.set('createdBy', userId);
    } else {
      next.delete('createdBy');
    }
    return next;
  });
}, [setSearchParams]);
```

**Pass `hideCreator` to `ChatsList`:**

```typescript
const activeCreatorId = searchParams.get('createdBy') ?? null;

<ChatsList
  threads={filteredThreads}
  hideCreator={activeCreatorId !== null}
  // ... rest of existing props
/>
```

### Step 7: Update ChatRow to Support `hideCreator`

**File: `src/components/history/chat-row.tsx`**

Add `hideCreator?: boolean` prop to `ChatRowProps`.

When `hideCreator` is true, change the subtitle line from:

```tsx
<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
  {creatorWithTooltip}
  <span>{formatRelativeTime(thread.updated_at)}</span>
</div>
```

to:

```tsx
<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
  {!hideCreator && creatorWithTooltip}
  <span>{formatRelativeTime(thread.updated_at)}</span>
</div>
```

This removes the creator avatar and name from each row when filtering by a specific creator (since every row belongs to the same person — showing their avatar on every row is redundant noise).

**File: `src/components/history/chats-list.tsx`**

Thread `hideCreator` through: add it to `ChatsListProps`, pass it to each `<ChatRow hideCreator={hideCreator} />`.

---

## Files to Modify

| File | Change |
|------|--------|
| `workers/main/src/auth.ts` | Add `getThreadCreators()` and `getThreadCreatorsAllWorkspaces()` methods to OrgDO |
| `src/lib/chat-do.server.ts` | Add `getThreadCreators()` and `getThreadCreatorsAllWorkspaces()` wrappers |
| `src/routes/_app.history.tsx` | Update loader: add `createdBy` param, fetch creators in parallel, return `threadCreators` + `currentUserId`. Rename `filter` param to `scope`. |
| `src/routes/api/history.tsx` | **New file** — resource route for paginated thread fetching (JSON response) |
| `src/routes.ts` | Add route entry for `api/history` |
| `src/components/pages/history/history-client.tsx` | Implement pagination with `useFetcher`, wire creator tabs, manage `scope` + `createdBy` URL params |
| `src/components/history/chats-toolbar.tsx` | Rename `filter` → `scope`, add `CreatorTabs` section (or import from new file) |
| `src/components/history/chats-list.tsx` | Add `hideCreator` prop, pass through to `ChatRow` |
| `src/components/history/chat-row.tsx` | Add `hideCreator` prop, conditionally hide creator avatar + name in subtitle |

## Edge Cases

- **Solo user, no teammates:** Creator tabs row is hidden entirely. UI looks identical to today except pagination works.
- **User switches org/workspace:** `revalidator.revalidate()` already fires on org/workspace change (existing `useEffect`). The loader returns fresh `threadCreators` for the new scope. Local pagination state resets via the `initialThreads` `useEffect`.
- **Empty "All" tab:** Show existing `EmptyState` component — "No chats yet."
- **Empty specific creator tab:** Show the same `EmptyState`. The count label shows "0 chats".
- **Search + pagination:** Search filters the already-loaded `allThreads` client-side. If the user searches while not all pages are loaded, they only search what's loaded. This matches current behavior. Do NOT add server-side search.
- **Thread deletion while paginated:** Remove from `allThreads` optimistically. Decrement `total` locally so `hasMore` stays accurate.
- **Creator tab after deletion:** If deleting a thread makes a creator's count drop to 0, the creator tab will disappear on next loader revalidation (which happens after the delete action). No special handling needed.
- **Workspace scope + creator filter interaction:** Both filters compose naturally. Switching workspace scope revalidates the loader, which returns new `threadCreators` for that scope. If the active `createdBy` user has no threads in the new scope, they won't appear in `threadCreators` — the UI will show "All" as active (since the `createdBy` param points to a user not in the list). Handle this: if `activeCreatorId` is not in `threadCreators`, treat it as "All" and clear the param.

## Testing

- Verify infinite scroll loads pages 2, 3, ... by scrolling down with >50 threads
- Verify creator tabs only appear when >1 creator has threads
- Verify "You" tab only shows current user's threads
- Verify teammate tabs show correct threads
- Verify avatars in tabs match the avatars shown in chat rows
- Verify switching workspace scope resets creator tabs
- Verify switching creator tab resets pagination offset
- Verify count label updates on tab switch
- Verify `hideCreator` removes redundant avatars when a specific creator is selected
- Verify search still works within loaded threads
- Verify select-all / bulk delete work with paginated + filtered results
