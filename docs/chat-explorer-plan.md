# Chat Explorer — Admin Plan

## Goal

Add a **Chat Explorer** tab to `/qaml-backdoor` that lets a superuser read through user threads quickly in one place: a metadata-rich, searchable, paginated thread list on the left, and the selected thread rendered **exactly as the user sees it** (existing admin read-only chat view) on the right. No new tabs per thread, minimal clicks, sticky filters.

Primary use case: the CEO reading through real usage — newest activity first, see who the user is (email, org, plan tier), how big the thread is, and what it's about, before/without opening it.

## Architecture decision: embed the existing read-only chat view in an iframe

The admin read-only chat view (`/chat/{id}?adminReadonly=1`) already works and renders the thread "totally normally" (transcript, preview tabs, read-only banner; composer hidden, no WebSocket). **Do not** re-mount `Chat.tsx` or `ChatMessagesView` inside the admin route — `Chat.tsx` is ~5k lines with deep coupling to `_app` providers and loader data. Instead:

- The explorer's right pane is an `<iframe src="/chat/{id}?adminReadonly=1&embed=1">` (same origin).
- Add a new `embed=1` mode that strips the viewer's own app chrome (the admin's `AppSidebar`, banners, paywall) so the iframe shows only the thread. **Embed mode is superuser-only at every layer** — see Part 2.
- Clicking a thread in the list swaps the iframe `src`. A full document load per click (~hundreds of ms) is acceptable and buys total isolation + zero risk of breaking the user-facing chat.

## ASCII design

```
/qaml-backdoor/chat-explorer
┌────────────────────────────────────────────────────────────────────────────────┐
│ QAML Backdoor › Chat Explorer                                                  │
│ [🔍 Search email, org, or title…]  [Plan: All ▾] [Sort: Last activity ▾]       │
│ [✦ First chats only ⬡]  [Hide internal ⬡]                       1,204 threads  │
├──────────────────────────────┬─────────────────────────────────────────────────┤
│ THREAD LIST (w-[360px])      │ READER PANE                                     │
│ ┌──────────────────────────┐ │ ┌─────────────────────────────────────────────┐ │
│ │ Fix my landing page  2h  │ │ │ Fix my landing page      [↑ Prev] [↓ Next]  │ │
│ │ “hey can you make the…”  │ │ │ jane@acme.com · Acme Inc · [Pro] · 14 msgs  │ │
│ │ jane@acme.com · Acme Inc │ │ │ created Mar 2 · [Open ↗] [Thread admin]     │ │
│ │ [Pro] · 14 msgs          │ │ ├─────────────────────────────────────────────┤ │
│ ├──────────────────────────┤ │ │                                             │ │
│ │ ✦ Build a CRM        5h  │◀┼─│  <iframe                                    │ │
│ │ “I want to track sales…” │ │ │   /chat/{id}?adminReadonly=1&embed=1 />     │ │
│ │ bob@example.com · Bob org  │ │ │                                             │ │
│ │ [PAYG] · 3 msgs · slack  │ │ │  …the thread rendered exactly as the user   │ │
│ ├──────────────────────────┤ │ │  sees it: read-only banner, transcript,     │ │
│ │ ✓ visited (dimmed)   1d  │ │ │  preview panel — no composer, no app        │ │
│ │ …                        │ │ │  sidebar…                                   │ │
│ ├──────────────────────────┤ │ │                                             │ │
│ │ 50 of 1,204  [Load more] │ │ │                                             │ │
│ └──────────────────────────┘ │ └─────────────────────────────────────────────┘ │
└──────────────────────────────┴─────────────────────────────────────────────────┘
  ↑/↓ or j/k (or the Prev/Next buttons) move selection · list end auto-loads more
  ✦ = user's first-ever thread · all filters/search/selection live in the URL
```

---

## Part 1 — Data layer: enrich the D1 admin index

The explorer list is served entirely from the D1-backed admin index (`workers/main/src/app-index-db.ts`), same as `/qaml-backdoor/threads`. The index is missing the metadata the sidebar needs, but **the upstream events already carry it**: every `thread_upsert` dispatch in `workers/main/src/identity/org-do.ts` spreads the full OrgDO thread row (`payload: { ...thread, org_id }`), which includes `user_message_count`, `first_user_message`, `last_user_message_at`, `source`, `channel_kind`, and `channel_kinds`. The D1 handler currently drops those fields. Likewise `org_upsert` payloads are the full org info including `billing_plan`, which D1 drops (it only stores `billing_status`).

### 1a. New columns and indexes

Apply in **both** places in `app-index-db.ts` `ensureSchema()`:

1. The `CREATE TABLE IF NOT EXISTS threads/orgs` statements (~line 148 and ~line 177) — so fresh databases get the full schema.
2. `try { ALTER TABLE … } catch {}` statements in the post-batch migration block (~line 252, follow the existing `apps.project_id` pattern) — so existing databases migrate.

```sql
-- threads
ALTER TABLE threads ADD COLUMN user_message_count INTEGER;
ALTER TABLE threads ADD COLUMN first_user_message TEXT;     -- truncated, see 1b
ALTER TABLE threads ADD COLUMN last_user_message_at INTEGER;
ALTER TABLE threads ADD COLUMN source TEXT;                 -- 'web' | 'api' | 'channel' | …
ALTER TABLE threads ADD COLUMN channel_kind TEXT;           -- e.g. 'slack' | 'email' | 'telegram'
ALTER TABLE threads ADD COLUMN channel_kinds TEXT;          -- JSON array string, mirrors OrgDO
-- orgs
ALTER TABLE orgs ADD COLUMN billing_plan TEXT;              -- raw stored value incl. legacy 'free'
```

New indexes (`CREATE INDEX IF NOT EXISTS`, alongside the existing ones at ~line 232). The current thread indexes are org/workspace-scoped only — the explorer's default global-recency query would otherwise sort the entire table:

```sql
CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_created_by_created_at ON threads(created_by, created_at, id);
```

The third index fully covers the first-thread `NOT EXISTS` probe including its `id` tie-break.

### 1b. Event handlers

- `applyAdminEvent` `case 'thread_upsert'` (~line 416): bind the new fields and add them to the `ON CONFLICT(id) DO UPDATE SET` clause. Details:
  - Truncate `first_user_message` to **300 chars** at write time — this is an index, not a transcript store; keep only enough for a 2-line snippet.
  - `channel_kinds` may arrive as an array or an already-encoded string depending on the payload path; normalize to a JSON array string (`Array.isArray(v) ? JSON.stringify(v) : v ?? null`).
- `applyAdminEvent` `case 'org_upsert'` (~line 363): persist `billing_plan` **raw, unnormalized** (insert + update clause), same null-handling as `billing_status`. Normalization happens at query time (see 1d) so the index stays a faithful mirror.

No changes needed in `org-do.ts` — payloads already contain everything.

### 1c. Backfill existing rows

The bootstrap (`workers/main/src/admin-index-bootstrap.ts`) already re-applies `thread_upsert`/`org_upsert` for every org, so the extended handlers backfill automatically on a full re-sync. Trigger it with an **explicit version marker**, not by sniffing ALTER results:

- In `ensureSchema()`, after migrations: read `app_index_metadata` key `threads_index_version`. If the value is not `'2'`: delete the `bootstrap_complete` and `ready` rows, then write `threads_index_version = '2'`.
- This is retry-safe: the marker only suppresses *re-triggering*; actual bootstrap completion is still driven by `bootstrap_complete`, and if a bootstrap attempt fails, `ensureAdminIndexReady()` retries via the existing lock-protected path (300s TTL) until `markBootstrapComplete()` runs.
- Fresh databases: the marker is written on first `ensureSchema()`; deleting the (nonexistent) bootstrap keys is a no-op and the normal first bootstrap proceeds.

Regardless, the UI must tolerate `NULL` in every new column (old threads, threads pre-dating `user_message_count`): render `—` / omit the row line rather than `0` or `undefined`.

### 1d. New query method + row type

Add to `workers/main/src/admin-index-types.ts`:

```ts
export interface AdminChatExplorerRow {
  id: string;
  title: string | null;
  model: string | null;
  org_id: string;
  workspace_id: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  user_message_count: number | null;
  first_user_message: string | null;
  last_user_message_at: number | null;
  source: string | null;
  channel_kind: string | null;
  channel_kinds: string | null;        // JSON array string
  org_name: string | null;
  org_billing_plan: string | null;     // raw stored value
  org_billing_status: string | null;   // raw stored value
  org_plan: string;                    // normalized tier, see below
  workspace_name: string | null;
  user_email: string | null;
  user_name: string | null;
  is_first_thread: boolean;            // user's earliest thread by created_at
}

export interface ChatExplorerFilters {
  plan?: 'payg' | 'starter' | 'pro' | 'team' | 'enterprise'; // normalized tier
  first_chats_only?: boolean;
  exclude_internal?: boolean;    // drop threads whose author email is on an internal domain
  sort_by?: 'updated_at' | 'created_at';
}
```

Add to `AppIndexDatabase` (model on `getThreadsPaginated`, ~line 674):

```ts
async getChatExplorerThreads(offset: number, limit: number, search?: string, filters?: ChatExplorerFilters)
```

- Base query joins users for the author: `FROM threads t LEFT JOIN orgs o ON … LEFT JOIN workspaces w ON … LEFT JOIN users u ON t.created_by = u.id`.
- **Search** (single query string, OR across the three vectors): `(u.email LIKE ? OR o.name LIKE ? OR t.title LIKE ?)` with `%term%`.
- **Normalized plan tier** — the stored `billing_plan` has legacy semantics (`'free'` historically meant the pay-as-you-go plan; `normalizeBillingPlan('free')` returns `'payg'` — see `src/lib/billing-plans.ts:145`). Mirror that function as a SQL `CASE` expression, defined **once** as a constant in `app-index-db.ts` and used for both the SELECT alias and the plan filter:
  ```sql
  CASE
    WHEN o.billing_status = 'enterprise' OR o.billing_plan = 'enterprise' THEN 'enterprise'
    WHEN o.billing_plan = 'free' THEN 'payg'
    WHEN o.billing_plan IN ('payg','starter','pro','team') THEN o.billing_plan
    WHEN o.billing_status IN ('trialing','active','past_due') THEN 'starter'
    ELSE 'payg'
  END AS org_plan
  ```
  Each branch matches `normalizeBillingPlan(plan, status)` line by line; a worker test must pin them together (see Testing). The filter `plan` compares against this expression (repeated in `WHERE`, since SQLite can't reference select aliases there). There is intentionally no separate "free" filter — the normalized universe is `{payg, starter, pro, team, enterprise}`.
- **First-chat flag**, computed per row and also used by the filter. "First chat" means **first human user chat**: `createThread` falls back to `created_by = "system"` when no creator is passed (`org-do.ts` ~line 4188, `createdBy?.trim() || "system"`), so guard on the joined `users` row (`u.id IS NOT NULL`) rather than on `t.created_by IS NOT NULL` — pseudo-authors like `system` have no users row and must never get the badge or appear in first-chats mode:
  ```sql
  (u.id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM threads t2
     WHERE t2.created_by = t.created_by
       AND (t2.created_at < t.created_at
            OR (t2.created_at = t.created_at AND t2.id < t.id))
  )) AS is_first_thread
  ```
  When `first_chats_only` is set, repeat the expression in `WHERE`. (System-authored threads still appear in the normal list — they just can't be "first chats". A scheduled-automation thread attributed to a *real* user id can in principle surface as that user's first chat; this is rare, the row carries the "Automated" badge, and it's deliberately not excluded here — historical rows lack the `scheduled` source so the exclusion couldn't be reliable anyway.) Covered by `idx_threads_created_by_created_at`.
- **Internal exclusion**: when `exclude_internal`, add `(u.email IS NULL OR u.email NOT LIKE '%@' || ?)` per domain. Reuse the domain handling from `normalizeInternalDomains` (`workers/main/src/routes/admin/metrics.ts:140`) with default `['camelai.com']`, matching how `routes/admin/routes.ts:1750` uses it.
- **Sort**: `ORDER BY t.updated_at DESC` for "last activity" (default), or `t.created_at DESC` for "created". Do **not** sort by `COALESCE(last_user_message_at, updated_at)` — it can't use an index, and OrgDO already bumps `updated_at` on every user message, assistant completion, and activity touch (`org-do.ts` ~4705/4838/4870), so `updated_at` *is* last activity. `last_user_message_at` is display metadata only. Allowlist sort columns like the existing `THREAD_SORT_COLS`.
- Return `{ items, total, offset, limit, hasMore }` like `getThreadsPaginated`, with a matching `COUNT(*)` query sharing the same WHERE.
- Map `is_first_thread` from SQLite's 0/1 to a boolean before returning.

This is a **read** method, so nothing needs registering in the `writeMethods` proxy in `workers/main/src/routes/admin/helpers.ts`.

### 1e. App-side wrapper

In `src/lib/auth-do.server.ts`, add `adminGetChatExplorerThreads(context, params)` following `adminGetThreadsPaginated` (line 495): `getEnv` → `ensureAdminIndexReady(env)` → `getAdminIndex(env).getChatExplorerThreads(…)`. Type the result with `AdminChatExplorerRow`.

### 1f. Mark scheduled-automation threads at the source

Scheduled prompts (automations) create threads in `workers/main/src/workspace-cron.ts` (~lines 916 and 939) with `createdBy || "system"` / `"system"` and a `Scheduled: {name}` title — but they do **not** pass `CreateThreadOptions.source`, so they're stored as `source = 'web'`, indistinguishable from human threads. Fix it upstream: both `createThread` calls must pass `{ source: 'scheduled' }` (the options argument is 7th — pass `undefined` for the `provider` argument; `CreateThreadOptions.source` already accepts arbitrary strings, see `org-do.ts:282`). This flows through `thread_upsert` into the D1 `source` column with no further plumbing.

These threads **must appear in the explorer list** (they already do — nothing filters them out) and get an "Automated" badge (see item anatomy in Part 3). Since historical scheduled threads can't be re-attributed, badge detection is layered: `source === 'scheduled'` (honest signal going forward) OR no joined `users` row (`system`-style pseudo-authors) OR title starting with `Scheduled: ` (historical fallback only — titles can be renamed, so it's best-effort).

---

## Part 2 — `embed=1` chrome-stripping for the read-only chat view

Goal: inside the iframe, show only the thread — no admin-user `AppSidebar`, no legacy banner, no paywall takeover. The read-only chat route already hides the composer, tab bar, fork actions, and skips the WebSocket when `readOnly: true` (see `src/routes/_app.chat.$id.tsx` loader, `adminReadonly` branch at ~line 511, and `src/components/Chat.tsx`).

**Security model — superuser-only at every layer.** `embed=1` must never grant access or alter behavior for non-superusers:

- Thread access enforcement is unchanged: the chat child loader's `adminReadonly` branch calls `requireSuperuser` and that remains the gate on thread *content*.
- The **parent** `_app.tsx` loader must independently verify superuser before honoring embed mode. For anyone else, `embed=1` is ignored entirely — normal chrome, normal paywall, and the child loader then rejects the `adminReadonly` request as today. A random user must not be able to strip their own paywall/chrome by appending query params.

Changes:

1. **`src/routes/_app.tsx` (layout loader, ~line 55)**: compute, **immediately after `requireAuthContext` and the onboarding/email-verification redirects** (i.e. before any org/provider/billing work):
   ```ts
   const embedMode =
     /^\/chat\/[^/]+$/.test(url.pathname) &&            // only the chat route, _app.tsx is shared
     url.searchParams.get('adminReadonly') === '1' &&
     url.searchParams.get('embed') === '1' &&
     authContext.user.is_superuser === true;
   ```
   When `embedMode`, **return early with inert values, skipping the expensive loader work entirely** — every thread click loads this loader fresh inside the iframe, so it must be cheap. Specifically, do not run:
   - the `ORG` DO fetch (`orgStub.getInfo()` / `getLlmProviderConfig()`) — build `authState` from `authContext.currentOrg` directly
   - `resolveOrgBillingAccess` / paywall computation → `billingAccessReady: true`, `appRouteAccessible: true`, `paywallContext: null`
   - `getWorkspaceMigrationGate` → `projectMigrationGate: null` (match whatever shape the component treats as "no gate")
   - `listGroupsForWorkspace` → `chatGroups: Promise.resolve([])`
   - legacy-banner KV reads + `getVerifiedLegacyStripeMigrationEligibility` → `showLegacyBanner: false`, `legacyMigration: null`
   Return `embedMode` in the response data. (The non-embed path is untouched and runs exactly as today.)
2. **`src/routes/_app.tsx` (component)**: when `embedMode`, render the providers (`ChatGroupsProvider`, `ChatThreadSnapshotsProvider`, `SidebarProvider`) and `<Outlet/>` inside `SidebarInset` as usual, but **skip** `AppSidebar`, `LegacyUserBanner`, `LegacyMigrationDialog`, and `PaywallTakeover`. Keep all providers — `Chat.tsx` consumes their contexts (chat groups resolve to `[]`, which the provider must tolerate; verify it does).
3. **`src/lib/chat-route-revalidation.ts`**: add `"embed"` to `ACTIVE_CHAT_LOADER_SEARCH_PARAMS` so the param participates in revalidation like `adminReadonly`.
4. Verify `ChatTabBar` is already suppressed in read-only mode (it should be — `_app.chat.$id.tsx` renders it only when not read-only, ~line 1326). If it isn't, gate it on `readOnly`.
5. Do **not** change the existing `?adminReadonly=1` new-tab behavior used by `/qaml-backdoor/threads` — `embed` is additive.

---

## Part 3 — The explorer route

### Route registration

- New module `src/routes/_admin.chat-explorer.tsx`, registered in `src/routes.ts` next to the other `/qaml-backdoor` children as `/qaml-backdoor/chat-explorer`. It inherits the `_admin.tsx` layout, whose loader already runs `requireSuperuser`; the route's own loader calls it again (same as every other admin route).
- Nav entry in `src/components/admin/admin-sidebar.tsx`, placed directly under "Threads": label **"Chat Explorer"**, icon `MessagesSquare` (Lucide — distinct from Threads' `MessageSquare`).

### URL state (everything sticky / deep-linkable)

| Param | Meaning | Default |
|---|---|---|
| `search` | one query across user email, org name, thread title | empty |
| `plan` | `payg` \| `starter` \| `pro` \| `team` \| `enterprise` (normalized tier) | all |
| `first` | `1` = first-chats-only | off |
| `internal` | `0` = hide internal-domain authors | shown |
| `sort` | `activity` (default, → `updated_at`) \| `created` | `activity` |
| `thread` | selected thread id (drives the iframe) | none |

`offset` is a **loader query param only, never browser-URL state**: the route loader accepts `?offset=` (defaulting to 0), but Load More passes it via `useFetcher` requests exclusively and never writes it into the address bar. The browser URL always represents the top of the filtered list; deep-linked offsets are intentionally unsupported (a shared link starts at page 1).

**Invariant: any change to `search`/`plan`/`first`/`internal`/`sort` clears `thread` (and resets accumulated pages)** — otherwise the reader can show a chat that's outside the filtered list. `AdminSearch` (`src/components/admin/admin-search.tsx`) currently clears only `offset` (~line 35–44); add an optional backwards-compatible prop `clearParams?: string[]` that deletes the listed params alongside `offset`, and pass `clearParams={["thread"]}` here. The plan/first/internal/sort control handlers do the same.

### Loader / action

```ts
export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);
  // parse params above; PAGE_SIZE = 50
  const page = await adminGetChatExplorerThreads(context, { offset, limit: PAGE_SIZE, search, filters });
  return { ...page, search, plan, first, internal, sort };
}
```

- No action needed (read-only feature).
- Add a `shouldRevalidate` export that returns `false` when **only** the `thread` search param changed (compare `currentUrl`/`nextUrl` like `src/lib/chat-route-revalidation.ts` does). Selecting a thread must not re-run the list query — that's what makes click-through feel instant.

### Component structure & behavior

Layout (fills the admin `SidebarInset`, no page scroll — the two panes scroll internally):

```
<div className="flex h-svh flex-col overflow-hidden">
  <header>            ← AdminPageHeader (breadcrumb: "Chat Explorer") + controls row
  <div className="flex min-h-0 flex-1">
    <aside className="flex w-[360px] shrink-0 flex-col border-r">  ← list
    <main className="flex min-w-0 flex-1 flex-col">                ← reader pane
```

(If `_admin.tsx`'s `SidebarInset` already constrains height, use `h-full`; the requirement is: viewport-height page, no outer scrollbar.)

**Controls row** (one horizontal row under the header, `flex items-center gap-2 px-4 py-2 border-b`):

- `AdminSearch` with `placeholder="Search by user email, org, or title…"` and `clearParams={["thread"]}` — it already debounces and writes `?search=`. Give it `className="w-72"`.
- Plan filter: `Select` (`src/components/ui/select.tsx`), items "All plans / Pay as you go / Starter / Pro / Team / Enterprise" (labels from `BILLING_PLAN_LIMITS[plan].label` in `src/lib/billing-plans.ts`). On change, set/delete `?plan=` and delete `offset` + `thread`.
- "First chats only": `Switch` + `Label` (or a toggle `Button` with the `Sparkles` icon). Writes `?first=1`. When active, every visible row is some user's first-ever thread — the fastest way to read "everybody's first chat".
- "Hide internal": `Switch` + `Label`. Writes `?internal=0`.
- Sort: `Select` with "Last activity" / "Created". Writes `?sort=`.
- Right-aligned total: `text-sm text-muted-foreground`, e.g. `1,204 threads`.

**Thread list** (left pane):

- `ScrollArea` filling the pane; items are full-width `<button>`s (not `<Link>` — selection goes through a handler so keyboard nav and Prev/Next share the code path), `text-left px-3 py-2.5 border-b border-border/50`.
- Selected item: `bg-accent`. Visited (but not selected): title in `text-muted-foreground` plus a small `Check` icon next to the timestamp.
- **Item anatomy** (4 compact lines):
  1. `flex items-baseline justify-between gap-2`: title — `text-sm font-medium truncate` (fallback `Untitled`, italic muted) — and relative last-activity time (`2h`, `3d`, from `updated_at`) — `text-xs text-muted-foreground shrink-0`. Wrap the time in a `Tooltip` showing absolute created / last-user-message datetimes.
  2. First-message snippet: `text-xs text-muted-foreground line-clamp-2` rendering `“{first_user_message}”`. Omit the line if null.
  3. `text-xs text-muted-foreground truncate`: `{user_email ?? created_by ?? 'unknown'} · {org_name}`.
  4. Badge row, `flex items-center gap-1.5 pt-1`, all `Badge variant="outline"` at `text-[10px] px-1.5 py-0`:
     - Plan badge — shows the **normalized** tier label from `org_plan` (paid tiers tinted via className: Starter `border-sky-500/50 text-sky-600 dark:text-sky-400`, Pro violet, Team amber, Enterprise emerald; PAYG plain). `Tooltip` on the badge shows raw `billing_plan` + `billing_status` (e.g. "plan: free · status: trialing") for debugging legacy values.
     - `{user_message_count} msgs` when non-null.
     - Channel badge: derive from `channel_kinds` (JSON array) the same way `getThreadChannelKinds` does in `src/components/history/chat-row.tsx:79` (reuse `normalizeChannelIndicatorKind` and fall back to `channel_kind`) — this is what surfaces "slack" / "email" / "telegram". Only if no channel kinds resolve and `source` is non-null and ∉ {`web`, `scheduled`}, show `source` instead. Plain web threads get no badge.
     - **"Automated" badge** (`Clock` icon, `text-muted-foreground`) for scheduled-automation threads, per the layered detection in 1f: `source === 'scheduled'`, or `user_email` is null with a non-null `created_by` (system-style pseudo-author), or title starts with `Scheduled: `. Extract this as a small `isAutomatedThread(row)` helper in the route module so the reader-pane header can reuse it.
     - `✦ first chat` badge when `is_first_thread` (use `Sparkles` icon, `text-amber-500`) — visible even outside first-chats mode, so first contacts stand out while scrolling.
- **Pagination — "Load more" accumulation, not page links** (a click-through reader shouldn't lose scroll position): the route's loader returns one page; the component keeps `items` in state seeded from loader data. "Load more" (`Button variant="ghost"` full-width at the list bottom, with `Loader2` spinner while fetching) uses a `useFetcher` against the same route with `offset += 50` and identical filter params, appending `fetcher.data.items` — fetcher-only, the browser URL is never mutated (see URL state above). Footer shows `{loaded} of {total}`. When `search`/`plan`/`first`/`internal`/`sort` change (loader data revalidates), reset the accumulated list to the fresh first page and scroll the list to top.
- Loading state for the initial page: 6–8 `Skeleton` rows matching the item shape. Empty state: centered `text-sm text-muted-foreground` "No threads match" + a "Clear filters" ghost button.
- **Selection**: clicking a row sets `?thread={id}` via `navigate` with `{ preventScrollReset: true }` (and the `shouldRevalidate` guard above keeps the loader idle). Also push the id into the visited set.
- **Visited tracking**: `localStorage` key `qaml-chat-explorer-visited-v1`, a JSON array of thread ids capped at 1000 (drop oldest). Read once on mount into a `Set` in state.
- **Keyboard navigation**: a `keydown` listener (active when focus isn't in an input): `ArrowDown`/`j` selects the next row, `ArrowUp`/`k` the previous; scroll the row into view (`scrollIntoView({ block: 'nearest' })`); selecting past the last loaded row triggers Load more first. Caveat: once the user clicks inside the iframe, focus lives in the iframe document and parent-level keydown won't fire — that's why the reader header has Prev/Next buttons (below) as the always-reliable affordance; clicking them returns focus to the parent.

**Reader pane** (right):

- Empty state (no `?thread=`): centered muted block — `MessagesSquare` icon, "Select a thread to read", and the keyboard hint "↑/↓ to move between threads".
- With a selection, find the row in the loaded list (fall back to just the id if the row isn't loaded, e.g. deep link — render what's available and let the iframe carry the content):
  - **Header strip** (`border-b px-4 py-2 flex items-center justify-between gap-3`): left — title (`text-sm font-medium truncate`) and a second line `text-xs text-muted-foreground truncate` with `{user_email} · {org_name} · {plan label} · {n msgs} · created {date}`; right — actions:
    - **Prev/Next**: two `Button variant="outline" size="icon-sm"` with `ChevronUp`/`ChevronDown` and tooltips "Previous thread" / "Next thread". They call the same move-selection handler as the keyboard shortcuts; Prev disabled on the first row; Next on the last loaded row triggers Load more then advances.
    - `Button variant="outline" size="sm" asChild` → `<a href={/chat/${id}?adminReadonly=1} target="_blank" rel="noopener noreferrer">` with `ExternalLink` icon, label "Open".
    - `Button variant="ghost" size="sm" asChild` → `Link to={/qaml-backdoor/threads/${id}}`, label "Thread admin".
    - Org name links to `/qaml-backdoor/orgs/{org_id}`.
  - **Iframe**: `<iframe key={threadId} src={`/chat/${threadId}?adminReadonly=1&embed=1`} title="Thread preview" className="h-full w-full flex-1 border-0 bg-background" />`. The `key` forces a clean document per thread. While loading, overlay a `Skeleton`/spinner until the iframe `onLoad` fires.

### Non-goals (keep scope tight)

- No full-text search over message bodies (index only stores the truncated first message).
- No writes of any kind from this page (the iframe's read-only mode already blocks actions).
- No virtualized list — 50-row pages with Load more is fine at this scale.
- Don't touch the existing `/qaml-backdoor/threads` table page.

---

## Files to touch (summary)

| File | Change |
|---|---|
| `workers/main/src/app-index-db.ts` | CREATE TABLE + ALTER TABLE columns, global indexes, extend `thread_upsert`/`org_upsert` handlers, `threads_index_version` marker + bootstrap reset, plan-normalization SQL CASE, new `getChatExplorerThreads` |
| `workers/main/src/admin-index-types.ts` | `AdminChatExplorerRow`, `ChatExplorerFilters` |
| `workers/main/src/workspace-cron.ts` | pass `{ source: 'scheduled' }` in both `createThread` calls (~lines 916, 939) |
| `src/lib/auth-do.server.ts` | `adminGetChatExplorerThreads` wrapper |
| `src/routes/_app.tsx` | superuser-gated `embed` mode: skip `AppSidebar`/banners/paywall and short-circuit billing/migration/chat-group/KV loader work; keep providers |
| `src/lib/chat-route-revalidation.ts` | add `"embed"` to tracked params |
| `src/components/admin/admin-search.tsx` | optional `clearParams` prop |
| `src/routes/_admin.chat-explorer.tsx` | new route module (loader + UI above) |
| `src/routes.ts` | register `/qaml-backdoor/chat-explorer` |
| `src/components/admin/admin-sidebar.tsx` | nav item "Chat Explorer" (`MessagesSquare`) |

## Testing

- Worker tests (extend the existing admin-index tests in `workers/main/tests/` — grep for `getThreadsPaginated` to find the right file):
  - `thread_upsert` persists and updates `user_message_count`, `first_user_message` (verify 300-char truncation), `last_user_message_at`, `source`, `channel_kind`, `channel_kinds` (array → JSON string); `org_upsert` persists raw `billing_plan` (including legacy `'free'`).
  - Scheduled prompts: extend the existing `workspace-cron` tests to assert both thread-creation paths produce threads with `source = 'scheduled'` (and that the value survives into the D1 index via `thread_upsert`).
  - `getChatExplorerThreads`: search matches each vector independently (email-only term, org-name-only term, title-only term); `first_chats_only` returns exactly one (the earliest) thread per human author with the `id` tie-break, and a `created_by = 'system'` thread is neither flagged `is_first_thread` nor returned in first-chats mode; plan filter; `exclude_internal` drops `@camelai.com` authors; sort orders by `updated_at` / `created_at`; pagination `total`/`hasMore` are consistent with filters applied.
  - **Plan normalization parity**: a table-driven test asserting the SQL CASE result equals `normalizeBillingPlan(plan, status)` for representative inputs — `(null,null)`, `('free','trialing')`, `('free',null)`, `('payg','active')`, `('starter','active')`, `('pro',null)`, `('team','past_due')`, `(null,'trialing')`, `(null,'enterprise')`, `('enterprise',null)`, `('garbage','active')`.
  - Migration path: an index DB created with the old schema gets the new columns, clears `bootstrap_complete`/`ready` exactly once, and writes `threads_index_version`; a second `ensureSchema()` run does not reset bootstrap again.
- **Embed security**: a test (worker or route-level, wherever `_app` loader behavior is testable) asserting that for a non-superuser, `?adminReadonly=1&embed=1` does not set embed mode (normal chrome/paywall data returned) and the chat child loader still rejects via `requireSuperuser`; for a superuser, embed mode is set and paywall context is null; and embed mode is not set on non-`/chat/:id` paths even for a superuser.
- `bun run typecheck` and a focused Vitest run for any touched `src/lib` code.
- Manual: `/qaml-backdoor/chat-explorer` → search an email → click through 3 threads with arrow keys and the Prev/Next buttons → confirm the iframe shows the read-only view without the app sidebar, changing a filter clears the selected thread, search/filters persist across selection, and "Open" still launches the classic full view in a new tab.
