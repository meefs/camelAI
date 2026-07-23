# Chat History Search Plan

Implementation plan for server-side chat history search. Two stages; ship Stage 1 first (it is independently valuable), then Stage 2.

## Problem

Users cannot find old chats. They remember *content* ("the chat where I asked for a pomodoro timer"), not titles. Today search is:

- Client-side only: `thread.title.toLowerCase().includes(query)` over threads already loaded into the page — `src/components/pages/history/history-client.tsx:197-204`.
- Scoped to loaded pages only: `/api/history` pages 50 at a time via infinite scroll, so a chat from months ago is not even in the searched set until the user scrolls all the way down.

Hard constraints (CTO): **no transcript indexing, no new model calls, no new infrastructure, no search vendor, no embeddings.** Cost must be bounded by thread count, never transcript length.

## Approach

The org's `threads` table (OrgDO SQLite) already stores searchable content for every thread: `title`, `first_user_message` (full text), `last_user_message` (full text, refreshed on every user turn), and `last_assistant_summary` (already generated after every turn).

- **Stage 1** — add an optional search filter to the existing OrgDO pagination queries over those four columns, thread it through `/api/history`, and turn the history search box into a debounced server-side search with "why it matched" snippets. Zero schema changes, zero new writes, retroactive over all historical threads.
- **Stage 2** — one new byte-capped column `user_ask_log` on `threads`, appended in `recordThreadUserMessage` (which already receives every user message's text), included in the same search clause. Extends coverage from first/last message to *everything the user typed*, with a hard ~8 KB/thread ceiling. No new model calls, no new cross-DO traffic.

Explicitly out of scope: FTS5 (possible later drop-in if LIKE ever gets slow), embeddings/semantic search, searching assistant transcript content, backfilling old chats' middle messages, changes to `AdminIndexDO` search, changes to `_app.settings.workspace.chats.tsx`.

## Current code map

| Concern | Location |
| --- | --- |
| History page route + loader | `src/routes/_app.history.tsx` (loader builds `queryKey`, loads page 0) |
| History client component | `src/components/pages/history/history-client.tsx` (search state, infinite scroll via `loadFetcher` → `/api/history`, client-side title filter at line 197) |
| Toolbar with search input | `src/components/history/chats-toolbar.tsx` (shadcn `Input`, placeholder "Search chats...") |
| List + row components | `src/components/history/chats-list.tsx`, `src/components/history/chat-row.tsx` |
| History page API | `src/routes/api/history.tsx` (loader; params `scope`, `workspaceId`, `createdBy`, `offset`, `limit`, `queryKey`) |
| History server helpers | `src/lib/history.server.ts` (`fetchHistoryThreadsPage`, `HistoryPageQuery`) |
| DO client wrappers | `src/lib/chat-do.server.ts` — `getThreadsPaginated` (~line 407), `getThreadsPaginatedAllWorkspaces` (~line 439), `toThread` (~line 105), `toThreadListPreview` (~line 134, truncates message previews to 500 chars for serialization) |
| OrgDO queries | `workers/main/src/identity/org-do.ts` — `getThreadsPaginated` (~line 6569), `getThreadsAllWorkspacesPaginated` (~line 6619); both build `whereClauses`/`whereParams` arrays and reuse the WHERE for the COUNT query |
| OrgDO user-message write path | `workers/main/src/identity/org-do.ts` — `recordThreadUserMessage` (~line 7343); receives every user message, normalizes via `normalizeThreadUserMessageText`, updates `last_user_message`, dispatches a `thread_upsert` admin event |
| OrgDO schema migrations | `workers/main/src/identity/org-do.ts` — numbered `if (version < N)` blocks in `migrate()`; `CURRENT_SCHEMA_VERSION = 44` (~line 1789); defensive `ensureThreadSchemaColumns()` (~line 1893) does PRAGMA-guarded `ALTER TABLE` per column |
| Message text normalization | `src/lib/thread-preview.ts` (`normalizeThreadUserMessageText`; OrgDO already imports from here via `../../../../src/lib/thread-preview`) |
| `Thread` type | `src/types/index.ts` (interface `Thread`, line 4); `OrgThread` type in `org-do.ts` (~line 410) |
| Existing DO pagination tests | `workers/main/tests/thread-pagination-filter.test.ts` (uses `createUser`/`createOrg`/`createWorkspace` from `./test-helpers`, calls org stub methods directly) |

Two useful facts:

- `first_user_message` / `last_user_message` are stored **untruncated**; the 500-char cap in `toThreadListPreview` applies only at serialization. Search and snippet extraction therefore run over full text server-side.
- SQLite `LIKE` is case-insensitive for ASCII by default. `NULL LIKE ?` evaluates to NULL (falsy), so NULL columns are safely skipped by an OR chain — no COALESCE needed.

---

## Stage 1 — server-side search over existing columns

### 1.1 New shared helper module: `src/lib/thread-search.ts`

Pure functions, no imports from worker code (this module is imported by both `chat-do.server.ts` and `org-do.ts`, like `thread-preview.ts` is today).

```ts
export const THREAD_SEARCH_QUERY_MAX_CHARS = 200;
export const THREAD_SEARCH_MAX_TERMS = 5;

/** Trim, cap at 200 chars, split on whitespace, drop empties, dedupe, cap at 5 terms. */
export function parseThreadSearchTerms(query: string | null | undefined): string[];

export interface ThreadSearchMatch {
  field:
    | "title"
    | "first_user_message"
    | "last_user_message"
    | "last_assistant_summary"
    | "user_ask_log"; // stage 2
  /** null for title matches (the title is already visible in the row) */
  snippet: string | null;
  /** highlight range within `snippet`; both 0 when snippet is null */
  matchStart: number;
  matchEnd: number;
}

/**
 * Pick the matched field and build a display snippet. Priority: title first
 * (snippet null), then first_user_message, last_user_message, user_ask_log,
 * last_assistant_summary — first field containing any term wins. Returns null
 * if no field contains any term (defensive; rows come pre-filtered by SQL).
 */
export function buildThreadSearchMatch(
  row: {
    title: string;
    first_user_message?: string | null;
    last_user_message?: string | null;
    last_assistant_summary?: string | null;
    user_ask_log?: string | null;
  },
  terms: string[],
): ThreadSearchMatch | null;
```

Snippet rules (implement inside `buildThreadSearchMatch`):

- Case-insensitive `indexOf` of the first term that occurs in the chosen field; anchor the snippet on its first occurrence.
- Collapse all whitespace runs (including newlines) to single spaces before extracting.
- Window: up to 30 chars before the match and up to 90 after; extend/shrink to the nearest whitespace boundary when one exists within 10 chars, so words aren't cut mid-way.
- Prepend `…` if clipped at the start, append `…` if clipped at the end. `matchStart`/`matchEnd` are indices into the *returned* snippet string (ellipsis included), so the row component can highlight without re-searching.

### 1.2 OrgDO: add `searchQuery` to both pagination methods

`workers/main/src/identity/org-do.ts`. Extend signatures with a trailing optional param (RPC-compatible — existing callers pass fewer args):

```ts
getThreadsPaginated(offset = 0, limit = 50, workspaceId?: string, createdBy?: string, searchQuery?: string)
getThreadsAllWorkspacesPaginated(workspaceIds: string[], offset = 0, limit = 50, createdBy?: string, searchQuery?: string)
```

In both methods, after the existing `workspace_id` / `created_by` clauses:

```ts
const terms = parseThreadSearchTerms(searchQuery);
const SEARCHABLE_THREAD_COLUMNS = [
  "title",
  "first_user_message",
  "last_user_message",
  "last_assistant_summary",
  // "user_ask_log",  ← added in stage 2
];
for (const term of terms) {
  const like = `%${term.replace(/([\\%_])/g, "\\$1")}%`;
  whereClauses.push(
    `(${SEARCHABLE_THREAD_COLUMNS.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
  );
  for (let i = 0; i < SEARCHABLE_THREAD_COLUMNS.length; i++) whereParams.push(like);
}
```

Semantics: AND across terms, OR across columns per term ("pomodoro timer" matches a thread with "pomodoro" in the title and "timer" in a message). Note the TS string `"ESCAPE '\\'"` produces SQL `ESCAPE '\'`; the char-class replace escapes `\`, `%`, `_` in one pass.

Both methods already reuse the same WHERE for the COUNT query — the search clause must be included there too (it falls out naturally from the shared `whereClauses` array in `getThreadsPaginated`; in `getThreadsAllWorkspacesPaginated` the clauses array is also shared). `total` therefore becomes the filtered count, which the client relies on for `hasMore` and the toolbar count.

Do not touch `getThreads()`, `getThreadsByWorkspace()`, or anything in `AdminIndexDO`.

### 1.3 Wrappers: `src/lib/chat-do.server.ts`

- `PaginationParams` gains `searchQuery?: string`.
- Both `getThreadsPaginated` and `getThreadsPaginatedAllWorkspaces` pass `params.searchQuery` as the new trailing RPC arg.
- When search is active, attach the match info **before** preview truncation (the raw `OrgThread` has full text):

```ts
const terms = parseThreadSearchTerms(params.searchQuery);
// in the return:
items: result.items.map((t) => {
  const preview = toThreadListPreview(t);
  return terms.length > 0
    ? { ...preview, search_match: buildThreadSearchMatch(t, terms) }
    : preview;
}),
```

### 1.4 Type: `src/types/index.ts`

Add to `Thread`:

```ts
search_match?: ThreadSearchMatch | null;
```

Import (or re-export) `ThreadSearchMatch` from `@/lib/thread-search`.

### 1.5 API + server helpers

`src/routes/api/history.tsx` loader:

- Parse: `const q = (url.searchParams.get('q') ?? '').trim().slice(0, THREAD_SEARCH_QUERY_MAX_CHARS);`
- Pass `searchQuery: q || undefined` into `fetchHistoryThreadsPage`.
- Echo it back: add `q` to the JSON response next to `queryKey` (the client uses it to drop stale responses).

`src/lib/history.server.ts`: `HistoryPageQuery` gains `searchQuery?: string | null`; `fetchHistoryThreadsPage` forwards it into `params` for both scope branches.

The SSR loader in `src/routes/_app.history.tsx` is untouched — search is client-side state, not a URL param, and the initial page load is always unfiltered.

### 1.6 New hook: `src/hooks/use-debounced-value.ts`

No debounce hook exists in the repo yet. Add a minimal one:

```ts
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}
```

### 1.7 Client rewiring: `src/components/pages/history/history-client.tsx`

State model changes:

```ts
const [searchQuery, setSearchQuery] = useState('');
const effectiveQuery = useDebouncedValue(searchQuery, 250).trim().slice(0, 200);
// the query the currently displayed list corresponds to ('' = unfiltered)
const [listQuery, setListQuery] = useState('');
const searchPending = effectiveQuery !== listQuery;
```

1. **Delete the client-side filter** (`filteredThreads` memo, lines 197-204). Every place that used `filteredThreads` uses `allThreads` instead (`ChatsList threads`, `handleSelectAll`, `allSelected`). Toolbar count becomes simply `totalCount={total}` — the server total is already filtered.

2. **Extract a param builder** (plain function in the component body, used by both `loadMore` and the new search effect):

```ts
const buildPageParams = (offset: number) => {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(initialLimit || PAGE_SIZE),
    scope,
    queryKey: initialQueryKey,
  });
  if (scope === 'this-workspace' && currentWorkspace?.id) {
    params.set('workspaceId', currentWorkspace.id);
  }
  if (activeCreatorId) params.set('createdBy', activeCreatorId);
  if (effectiveQuery) params.set('q', effectiveQuery);
  return params;
};
```

3. **Replace the reset effect** (currently at lines 123-127, keyed on `initialQueryKey`/initial props) with one effect that owns "what dataset should the list show":

```ts
useEffect(() => {
  if (!effectiveQuery) {
    setAllThreads(initialThreads);
    setCurrentOffset(initialOffset + initialThreads.length);
    setTotal(initialTotal);
    setListQuery('');
    return;
  }
  loadFetcher.load(`/api/history?${buildPageParams(0).toString()}`);
}, [initialQueryKey, effectiveQuery, initialThreads, initialOffset, initialTotal]);
```

Keying on `initialQueryKey` too means a scope/creator switch while a search is active re-fetches the search under the new scope (the loader has already re-run and reset `initialQueryKey`).

4. **Response effect** (currently lines 129-143) — three changes: guard on the echoed `q`, treat `offset === 0` as *replace*, and record `listQuery`:

```ts
useEffect(() => {
  const data = loadFetcher.data;
  if (!data?.threads) return;
  if (data.queryKey !== initialQueryKey) return;
  if ((data.q ?? '') !== effectiveQuery) return;   // stale search response

  if (data.offset === 0) {
    setAllThreads(data.threads);
  } else {
    setAllThreads((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      return [...prev, ...data.threads.filter((t) => !existingIds.has(t.id))];
    });
  }
  setCurrentOffset(data.offset + data.threads.length);
  setTotal(data.total);
  setListQuery(data.q ?? '');
}, [loadFetcher.data, initialQueryKey, effectiveQuery]);
```

`HistoryPageResponse` (top of the file) gains `q?: string`.

5. **`loadMore`**: replace its inline URLSearchParams block with `buildPageParams(currentOffset)` (which now carries `q`). Infinite scroll during a search keeps working unchanged — server-side WHERE + `ORDER BY updated_at DESC` paginates consistently and `total` is the filtered count.

6. **Loading state**: pass `loading={loading || searchPending}` to `ChatsList` so the skeleton shows while a new search is in flight, and pass a new `searchActive={listQuery !== ''}` prop for the empty state.

### 1.8 UI: empty state and match snippet

`src/components/history/chats-list.tsx` — add `searchActive?: boolean` prop. When `threads.length === 0 && searchActive`, render a search-specific empty state instead of "No chats yet" (keep the same layout/classes as `EmptyState`, swap the icon to `Search` from lucide):

- Title: `No matching chats`
- Body: `Search covers chat titles, your messages, and chat summaries. Try different keywords.`

`src/components/history/chat-row.tsx` — when `thread.search_match` is present with a non-null `snippet`, insert one line between the title row and the meta row. Row anatomy after the change:

```
┌────────────────────────────────────────────────────────────────────┐
│ Pomerium authentication fixes                     [ws badge]   ⋮  │   ← title row (unchanged)
│ You: …can you fix the ES256 groups bug in proxy-auth-core…         │   ← NEW match line (only when search_match.snippet)
│ (avatar) 3 days ago  [channel icons]                               │   ← meta row (unchanged)
└────────────────────────────────────────────────────────────────────┘
```

Implementation in the non-editing branch, directly after the title `<div className="flex items-center gap-2 min-w-0">…</div>`:

```tsx
{thread.search_match?.snippet ? (
  <p className="mt-0.5 text-xs text-muted-foreground truncate">
    <span className="shrink-0">
      {thread.search_match.field === 'last_assistant_summary' ? 'Summary: ' : 'You: '}
    </span>
    {thread.search_match.snippet.slice(0, thread.search_match.matchStart)}
    <span className="text-foreground font-medium">
      {thread.search_match.snippet.slice(
        thread.search_match.matchStart,
        thread.search_match.matchEnd,
      )}
    </span>
    {thread.search_match.snippet.slice(thread.search_match.matchEnd)}
  </p>
) : null}
```

Label mapping: `first_user_message`, `last_user_message`, `user_ask_log` → `You:`; `last_assistant_summary` → `Summary:`. Title matches render no extra line (snippet is null) — the title itself is visible. Do not highlight inside the title.

`src/components/history/chats-toolbar.tsx` is unchanged (input, placeholder, and `totalCount` prop all keep their current shape).

### 1.9 Stage 1 tests

Extend `workers/main/tests/thread-pagination-filter.test.ts` (same helpers/style as the existing cases; set `first_user_message` via `createThread(workspaceId, title, userId, firstUserMessage)`, set `last_user_message` via `orgStub.recordThreadUserMessage(threadId, text)`):

1. Search finds a title match beyond the first page: create 60 threads, search a term unique to an old one; assert it's in `items` and `total === 1`.
2. Match on `first_user_message` only (term absent from title).
3. Match on `last_user_message` only (recorded after creation).
4. Match on `last_assistant_summary` only (set it via the OrgDO method that `persistThreadAssistantCompletion` in `workers/main/src/chat-thread/metadata.ts` calls; find it by following that dep).
5. LIKE escaping: with threads present, `searchQuery = "%"` returns only threads whose text literally contains `%` (i.e. 0 for plain-text fixtures — not everything).
6. Multi-term AND across fields: term A in title + term B in `last_user_message` matches; A + absent-term does not.
7. Search composes with `createdBy` and with workspace scoping (a matching thread in another workspace is excluded from `getThreadsPaginated` for this workspace, included in `getThreadsAllWorkspacesPaginated` when its workspace id is passed).
8. Case-insensitive: uppercase query matches lowercase content.
9. No `searchQuery` → byte-identical behavior to today (existing tests keep passing).

New unit test `tests/thread-search.test.ts` for `parseThreadSearchTerms` (trim, cap, dedupe, 5-term limit) and `buildThreadSearchMatch` (field priority, whitespace collapsing, ellipses, `matchStart`/`matchEnd` correctness, title → null snippet, no-match → null).

Commands: `bun run typecheck`, `bun run test:run -- thread-search`, `bun run test:workers -- thread-pagination-filter`.

---

## Stage 2 — `user_ask_log`: bounded log of everything the user asked

### 2.1 Column + migration

`workers/main/src/identity/org-do.ts`, following the documented migration recipe (comment block ~line 670):

1. New block in `migrate()`:

```ts
if (version < 45) {
  // V45: bounded rolling log of user messages for history search (stage 2 of
  // docs/chat-history-search-plan.md)
  try {
    this.sql.exec("ALTER TABLE threads ADD COLUMN user_ask_log TEXT");
  } catch {}
}
```

2. Bump `CURRENT_SCHEMA_VERSION` to `45`.
3. Add a matching PRAGMA-guarded entry in `ensureThreadSchemaColumns()` next to the `first_user_message` one.
4. `OrgThread` type (~line 410) gains `user_ask_log?: string | null`.

No backfill: the log accrues as threads get new user messages. Old dormant threads keep Stage 1 coverage (title/first/last/summary).

### 2.2 Append helper in `src/lib/thread-search.ts`

```ts
export const THREAD_ASK_LOG_MAX_BYTES = 8192;
export const THREAD_ASK_LOG_ENTRY_MAX_CHARS = 500;

/**
 * Append one normalized user message to the newline-delimited ask log.
 * Returns the byte-bounded existing log when there is nothing to append.
 */
export function appendToThreadAskLog(
  existing: string | null,
  message: string | null,
): string | null;
```

Rules:

- `message` is the already-normalized text (`normalizeThreadUserMessageText` output). If null/empty after collapsing whitespace runs to single spaces and trimming → return the byte-bounded existing log.
- Entry = collapsed text truncated to `THREAD_ASK_LOG_ENTRY_MAX_CHARS` Unicode code points.
- Skip if identical to the log's current last line (consecutive-duplicate suppression; retries and steer re-sends are common).
- Append as a new `\n`-separated line, then while its UTF-8 encoding exceeds `THREAD_ASK_LOG_MAX_BYTES`, drop the oldest line. A single entry is always ≤ 500 code points, so the loop terminates with content under the hard 8 KB storage and scan ceiling.

### 2.3 Write path: `recordThreadUserMessage` (org-do.ts ~line 7343)

After computing `lastUserMessage`:

```ts
const askLog = appendToThreadAskLog(existing.user_ask_log ?? null, lastUserMessage);
if (askLog !== (existing.user_ask_log ?? null)) {
  setClauses.push("user_ask_log = ?");
  params.push(askLog);
}
```

(Insert before the `params.push(id)` line; `updated` should carry `user_ask_log: askLog` so the row object stays accurate.)

**Keep the log inside OrgDO.** Two containment points:

- The `thread_upsert` admin dispatch in this method spreads the whole row; strip it: `const { user_ask_log: _omitted, ...adminPayload } = updated;` and dispatch `adminPayload`. AdminIndexDO has no use for it.
- `toThread` in `src/lib/chat-do.server.ts` picks fields explicitly, so the column never serializes to the browser. Leave that as-is; do not add `user_ask_log` to the `Thread` type.

`createThread` stays untouched — the first message is already covered by `first_user_message`, and the log fills from the first `recordThreadUserMessage` call onward.

### 2.4 Search integration

- Add `"user_ask_log"` to `SEARCHABLE_THREAD_COLUMNS` in both OrgDO pagination methods (one array if you hoist it to module scope).
- `buildThreadSearchMatch` already defines the priority slot (after `last_user_message`, before `last_assistant_summary`); pass `user_ask_log: t.user_ask_log` through from the raw `OrgThread` in `chat-do.server.ts` when building the match. Snippets from the log render with the `You:` label like other user-message matches.

### 2.5 Stage 2 tests

`workers/main/tests/thread-pagination-filter.test.ts`:

1. Mid-history recall: record messages A, B, C on one thread; search a term unique to A (no longer in `last_user_message`) → thread found; `search` on the raw row confirms the match came from `user_ask_log` coverage.
2. Cap: record enough 500-code-point messages to exceed 8 KB; assert `new TextEncoder().encode(user_ask_log).byteLength <= 8192`, a term from the oldest message no longer matches, a term from the newest does.
3. Consecutive duplicate suppressed (record same text twice → one line).
4. Admin dispatch payload has no `user_ask_log` (assert via the dispatched event if the test harness exposes it; otherwise assert at the unit level that the destructure exists — lowest-value test of the four, drop it if awkward).

`tests/thread-search.test.ts`: `appendToThreadAskLog` — null/empty passthrough, whitespace collapsing, entry truncation at 500, FIFO trim at 8192 UTF-8 bytes preserving newest, multibyte input, consecutive-dup skip, first append to null log.

Commands: same as Stage 1.

---

## Behavior notes and accepted limitations

- Assistant transcript content is not searched (except via the per-turn summary). A rare term only the agent said stays unfindable — accepted trade-off of not indexing transcripts.
- Old threads' mid-conversation content is only searchable once they receive new messages (Stage 2 accrues going forward). Threads predating the V14 OrgDO migration may have NULL `first_user_message`; NULL columns are safely skipped by the LIKE OR-chain.
- LIKE substring match, recency-ordered (`updated_at DESC`), no relevance ranking. Case-insensitivity is ASCII-only (SQLite default). If a very large org ever makes the scan slow, FTS5 on DO SQLite is the upgrade path — do not build it now.
- Cost ceiling: per search request, one SQL scan over the org's own `threads` rows (columns bounded: title + two messages + summary + 8 KB log). Per user message write, one string append bounded at 8 KB. Nothing scales with transcript length.
- Rollout is order-free: the OrgDO migration applies lazily per-DO; the `q` param is optional so old/new client+server combinations degrade to today's behavior.
