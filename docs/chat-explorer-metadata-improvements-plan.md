# Chat Explorer Metadata Improvements Plan

## Goal

Improve `/qaml-backdoor/chat-explorer` so employees can scan real chats with higher-signal metadata:

- a reliable user-sent message count on most threads, with a cheap `20+` display cap if needed;
- an error tag/filter for threads that have shown user-visible chat errors;
- the set of models used in a thread, not only the latest selected model.
- an admin Errors dashboard that surfaces the top bugs over common time windows and links directly to affected threads.

This plan is for an implementation agent. Keep the existing iframe reader architecture and the current admin-only access model.

## Current State

The Chat Explorer route is `src/routes/_admin.chat-explorer.tsx`. Its loader calls `src/lib/auth-do.server.ts#adminGetChatExplorerThreads`, which reads the D1 admin index via `workers/main/src/app-index-db.ts#getChatExplorerThreads`.

Message counts are rendered only when `AdminChatExplorerRow.user_message_count !== null`. The D1 `threads` table already has `user_message_count`, `first_user_message`, `last_user_message_at`, `source`, `channel_kind`, and `channel_kinds`, but historical D1 rows can still have null metadata until a backfill or later `thread_upsert` reaches them.

`OrgDO` is the fast source of truth for thread metadata. `workers/main/src/identity/org-do.ts` stores `user_message_count`, `first_user_message`, `last_user_message`, and `last_user_message_at` on each thread. `recordThreadUserMessage` and `touchThread` increment the count and dispatch `thread_upsert` to the admin index.

Do not change `createThread` to initialize `user_message_count = 1` when `firstUserMessage` is present. New-thread loading depends on `user_message_count === 0` to submit the deferred first message in `src/routes/_app.chat.$id.tsx`.

Errors are not currently persisted as thread metadata. `ChatThreadDO` emits user-visible errors through `pushChatEvent({ type: "error", ... })`, `emitChatError`, `piProviderErrorEvent`, and some direct `sendDirect` error paths. Provider/agent errors also go to observability, but Analytics Engine is not a good backing store for the Chat Explorer list.

Model switching currently updates only the thread's latest `model` through `OrgDO.updateThreadModel`. There is no durable thread-level history of models selected or used earlier in the thread.

## Design Principles

Use the D1 admin index for list queries. Do not parse transcripts as part of every normal explorer query.

Use OrgDO thread rows as the primary repair source for missing list metadata. Only call `ChatThreadDO` as a bounded fallback for rows that OrgDO cannot repair.

Store small, diagnostic summaries on thread rows. Do not store transcript-like content, full error stacks, request bodies, auth headers, or secrets in D1.

Prefer forward-looking durable collection plus bounded backfill. Historical transient chat errors that were only in WebSocket event buffers cannot be perfectly reconstructed.

## Phase 1: Message Count Reliability

### 1. Add Display Semantics

Keep `user_message_count` as the exact count when the system knows it. Add display helpers in `src/routes/_admin.chat-explorer.tsx`:

- `0` -> `0 msgs`
- `1` -> `1 msg`
- `2..20` -> `{n} msgs`
- `>20` -> `20+ msgs`
- `null` -> omit only after repair attempts fail

If the fallback counter stops at a cap, return a display-only capped value rather than overwriting an exact count with `20`.

Suggested row additions in `workers/main/src/admin-index-types.ts`:

```ts
user_message_count_source?: "admin_index" | "org_thread" | "pi_core_fallback" | "unknown";
user_message_count_capped?: boolean;
```

These can be computed in the app-side loader rather than stored in D1.

### 2. Rehydrate Missing D1 Rows From OrgDO

Add a helper under `src/lib/auth-do.server.ts`, called by `adminGetChatExplorerThreads` after the D1 page loads:

```ts
hydrateMissingChatExplorerThreadMetadata(context, page)
```

For a bounded page of rows, repair rows where:

- `user_message_count === null`;
- or `first_user_message` is present but `user_message_count === 0` and the thread is older than a short grace window, for example 2 minutes;
- or future error/model fields are null while OrgDO has them.

Group rows by `org_id` and `workspace_id`, then call `OrgDO.getThreadsByIds(workspaceId, ids)`. Merge returned metadata into the page response and schedule `AppIndexDatabase.applyAdminEvent({ type: "thread_upsert", payload: { ...thread, org_id } })` so D1 repairs itself.

Keep this bounded to the returned page, usually 50 rows. Catch/log repair failures and still return the D1 page.

This should fix the common "count does not populate" case caused by old or missed admin-index metadata without making the list depend on full transcript reads.

### 3. Add a Bounded ChatThreadDO Fallback

Add a new admin-only/lightweight RPC on `workers/main/src/chat-thread-do.ts`:

```ts
getAdminExplorerSummary(input?: { userMessageCap?: number }): Promise<{
  userMessageCount: number;
  userMessageCountCapped: boolean;
  hasError: boolean;
  errorCount: number;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  models: string[];
}>;
```

For the count, reuse the same visible-message rules as `getPiCoreParsedMessages`:

- count role `"user"`;
- skip hidden/internal Pi recovery messages via the existing `isInternalPiClientMessage` logic;
- skip compact summary/meta messages;
- include in-flight messages if they are visible;
- stop at `cap + 1` and return `userMessageCountCapped = true` when over cap.

Use this fallback only for rows still unknown after OrgDO repair, or for a selected row when the user opens it. Do not call it for every row that already has `user_message_count`.

If the fallback returns an uncapped exact count, repair OrgDO/admin-index metadata. If it returns capped, use it for display only (`20+`) unless a separate capped-display column is added.

### 4. Backfill/Repair Workflow

The admin index already has `threads_index_backfill_required` in `workers/main/src/app-index-db.ts` and background backfill in `workers/main/src/admin-index-bootstrap.ts`. Audit that path during implementation:

- verify a failed background backfill leaves the marker set;
- add observability around start/success/failure and repaired row count;
- add a small admin-only way to trigger/retry the explorer metadata backfill if production needs it.

Do not block ordinary Chat Explorer requests on a full production backfill.

## Phase 2: Error Tags, Filter, and Future Dashboard Data

### 1. Persist Both Error Events and Thread Summary

Store errors in two layers:

- `threads` summary fields for fast Chat Explorer badges and filters;
- a normalized `chat_error_events` table in the D1 admin index for future dashboard queries such as "top errors by day" and "threads hit by this error."

The summary answers "does this thread have an error?" quickly. The event table answers "what errors are happening across the product over time?"

### 2. Thread Summary Fields

Extend `OrgThread` and the OrgDO `threads` table with small error-summary fields:

```sql
chat_error_count INTEGER NOT NULL DEFAULT 0,
last_chat_error_at INTEGER,
last_chat_error_message TEXT,
last_chat_error_source TEXT,
last_chat_error_status INTEGER,
last_chat_error_provider TEXT,
last_chat_error_model TEXT
```

Add `OrgDO.recordThreadError(id, input)`:

- increments `chat_error_count`;
- stores `last_chat_error_*`;
- truncates `last_chat_error_message` to about 300 chars;
- dispatches `thread_upsert` to the admin index;
- dispatches a separate `thread_error_recorded` admin event for the D1 event table.

The error timestamp should update thread metadata. It is reasonable to bump `updated_at` because a user-visible error is thread activity.

### 3. D1 Error Event Table

Add an exact, append-only table to `workers/main/src/app-index-db.ts`:

```sql
CREATE TABLE IF NOT EXISTS chat_error_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  error_kind TEXT,
  status INTEGER,
  provider TEXT,
  model TEXT,
  message_normalized TEXT NOT NULL,
  message_sample TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_error_events_created_at
ON chat_error_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_error_events_fingerprint_created_at
ON chat_error_events(fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_error_events_thread_created_at
ON chat_error_events(thread_id, created_at DESC);
```

Field semantics:

- `id`: deterministic id for idempotency, for example `${threadId}:${createdAt}:${fingerprint}` plus a short random suffix when needed.
- `fingerprint`: stable hash of normalized error attributes, for grouping common errors.
- `message_normalized`: normalized grouping string, capped around 300 chars. Strip ids, UUIDs, request ids, long hex/base64 blobs, exact line/column numbers, and quoted user text where practical.
- `message_sample`: one safe truncated human-readable sample, capped around 300 chars.
- `source`: high-level source such as `chat_event`, `runner_send`, `pi_provider`, `pi_agent_loop`, or `assistant_error_message`.
- `error_kind`: optional low-cardinality type such as `billing`, `provider`, `rate_limit`, `auth`, `runtime`, `unknown`.

Do not store stack traces, request/response bodies, chat message contents, auth headers, provider payloads, or secrets. The dashboard can link to threads through `thread_id` instead of storing transcript excerpts.

Add an admin-index read method for future use, even if the dashboard is not built in this pass:

```ts
getChatErrorGroups(options: {
  startAt: number;
  endAt: number;
  limit?: number;
  fingerprint?: string;
}): Promise<Array<{
  fingerprint: string;
  message_sample: string;
  source: string;
  error_kind: string | null;
  provider: string | null;
  model: string | null;
  count: number;
  affected_thread_count: number;
  first_seen_at: number;
  last_seen_at: number;
}>>;

getChatErrorThreads(options: {
  fingerprint: string;
  startAt: number;
  endAt: number;
  limit?: number;
  offset?: number;
}): Promise<Array<{
  thread_id: string;
  org_id: string;
  workspace_id: string;
  user_id: string | null;
  last_seen_at: number;
  count: number;
}>>;
```

These methods are enough to power a later errors dashboard without changing the write path again.

### 4. Capture Errors in ChatThreadDO

Add a helper in `ChatThreadDO`:

```ts
recordCurrentThreadError(input)
```

Call it from the central paths that create user-visible chat errors:

- inside `pushChatEvent` when `payload.type === "error"`;
- direct send-error paths in `handleRunnerClientUserMessage` where the browser sees an error but the event is not persisted through `pushChatEvent`;
- provider stream/agent failures that call `piProviderErrorEvent`;
- persisted assistant messages with `errorMessage` when they are annotated.

Avoid double-counting by fingerprinting `{source, normalizedMessage, status, provider, model}` for a short window, similar to `piRecordedProviderErrors`. The short-window dedupe should prevent a single failure from producing several identical records, but should not collapse repeated occurrences across different turns or days.

### 5. Mirror Error Summary Fields Into AdminIndex

Add matching nullable columns to the D1 `threads` table in `workers/main/src/app-index-db.ts`, update `thread_upsert`, and extend `AdminChatExplorerRow`.

Add `ChatExplorerFilters.errors_only?: boolean` and apply:

```sql
t.chat_error_count > 0
```

Add an index such as:

```sql
CREATE INDEX IF NOT EXISTS idx_threads_chat_error_updated_at
ON threads(chat_error_count, updated_at DESC);
```

### 6. UI

In `src/routes/_admin.chat-explorer.tsx`:

- add an "Errors only" switch next to the existing filters;
- show a red/destructive outline `Error` badge on rows with `chat_error_count > 0`;
- show count when greater than 1, for example `Error x3`;
- tooltip/header metadata should include last error source/status/model and the truncated message.

Do not show full stack traces or raw request/provider payloads.

### 7. Historical Backfill

Use `getAdminExplorerSummary` as a best-effort historical backfill for selected or explicitly repaired rows. It can detect persisted assistant messages with `errorMessage` or parsed error content blocks.

Backfill should repair thread summaries and may insert `chat_error_events` for persisted assistant errors when a stable timestamp/fingerprint is available. Document the limitation: old transient WebSocket errors that were never persisted in messages cannot be reconstructed.

## Phase 3: Models Used in Thread

### 1. Store Distinct Model History

Keep existing `threads.model` as the latest/current model. Add a JSON array string for distinct model history:

```sql
model_history TEXT
last_model_changed_at INTEGER
```

Recommended semantics:

- on `createThread`, initialize `model_history` to `[normalizedModel]`;
- on `updateThreadModel`, merge the normalized selected model into `model_history` in first-seen order and set `last_model_changed_at`;
- cap the stored list to a reasonable size, for example 12 distinct values;
- accept arbitrary trimmed strings for provider/custom model ids, but never store secrets.

Also consider recording actual response models in `recordPiAssistantUsage`, using `assistant.responseModel || assistant.model`, because custom/BYOK providers can route to model ids that differ from the picker value. If both are stored, name them clearly:

- `model_history`: picker/current thread model ids;
- `response_model_history`: actual provider response model ids.

If implementation scope needs to stay small, start with `model_history` only.

### 2. Mirror to AdminIndex

Add `model_history` and `last_model_changed_at` to D1 `threads`, `thread_upsert`, `AdminChatExplorerRow`, and the OrgDO-to-D1 backfill path.

For old rows, default `model_history` to `[thread.model]` during OrgDO schema migration or admin-index repair.

### 3. UI

In Chat Explorer rows and the reader header:

- continue showing the latest `model`;
- show a compact models badge group from `model_history`;
- if more than 3 models, show first 2 plus `+N`;
- tooltip shows the full ordered list and marks the current/latest model.

Avoid adding a model filter in the first implementation unless product asks for it. The immediate request is visibility while scanning.

## Phase 4: Errors Dashboard

### 1. Goal

Add a superuser-only dashboard for discovering the top chat/runtime bugs quickly. The primary workflow is:

1. Pick a time window.
2. See the most common normalized errors in that window.
3. Open the list of threads affected by a selected error.
4. Jump into Chat Explorer or the existing thread admin page to inspect examples.

This dashboard should use the `chat_error_events` table from Phase 2. Do not query Analytics Engine for the normal page load.

### 2. Route and Sidebar

Add a new route:

```text
/qaml-backdoor/errors
```

Register it in `src/routes.ts` next to the other `/qaml-backdoor` children.

In `src/components/admin/admin-sidebar.tsx`, add a sidebar item directly under the current `Dashboard` item in `adminRoutes`:

- label: `Errors`
- href: `/qaml-backdoor/errors`
- icon: use a Lucide bug/error icon such as `Bug` or `CircleAlert`

Keep `Chat Explorer` where it is under the model/entity routes.

### 3. Time Windows

Use a compact segmented control or tabs with exactly these windows:

- `Last 24h` (default)
- `Last 7d`
- `Last 30d`

Represent the selected window in the URL, for example:

```text
/qaml-backdoor/errors?range=24h
/qaml-backdoor/errors?range=7d
/qaml-backdoor/errors?range=30d
```

Use rolling windows, not calendar buckets. The user phrase "today" should map to the last 24 hours for implementation clarity.

### 4. Dashboard Data

Use `AppIndexDatabase.getChatErrorGroups({ startAt, endAt, limit })` for the top list.

Sort by:

1. total event count descending;
2. affected thread count descending;
3. last seen descending.

Default limit can be 50. If more are needed later, add pagination, but the first version should optimize for quickly finding the top bugs.

Each error group row should show:

- safe sample message;
- count of events;
- count of affected threads;
- first seen / last seen in the selected window;
- source, kind, status, provider, and model when present;
- fingerprint as a short monospace value for debugging/deduping.

Also show a small summary strip at the top:

- total error events;
- affected threads;
- distinct error groups;
- most recent error time.

### 5. Affected Threads Panel

When selecting an error group, load `getChatErrorThreads({ fingerprint, startAt, endAt })`.

Show a right-side or lower detail panel with affected threads:

- thread title if cheaply joinable through the `threads` table;
- user email if cheaply joinable through `users`;
- org/workspace names if cheaply joinable;
- last seen time;
- occurrences in that thread;
- links:
  - `Open in Chat Explorer` -> `/qaml-backdoor/chat-explorer?thread={thread_id}&errors=1`
  - `Thread admin` -> `/qaml-backdoor/threads/{thread_id}`
  - `Org` -> `/qaml-backdoor/orgs/{org_id}` when available

The dashboard should still be useful if joins are missing. In that case, show ids and links.

### 6. Query Method Refinements

Extend the Phase 2 dashboard query methods so the UI does not need N+1 lookups:

```ts
getChatErrorGroups(options): Promise<Array<{
  fingerprint: string;
  message_sample: string;
  source: string;
  error_kind: string | null;
  provider: string | null;
  model: string | null;
  count: number;
  affected_thread_count: number;
  first_seen_at: number;
  last_seen_at: number;
}>>;

getChatErrorThreads(options): Promise<Array<{
  thread_id: string;
  title: string | null;
  org_id: string;
  org_name: string | null;
  workspace_id: string;
  workspace_name: string | null;
  user_id: string | null;
  user_email: string | null;
  last_seen_at: number;
  count: number;
}>>;
```

`getChatErrorThreads` should group by thread and join `threads`, `orgs`, `workspaces`, and `users` where possible.

Add an aggregate method or include a `summary` object in the route loader for total events, affected threads, distinct groups, and latest error.

### 7. UX Notes

This is an admin operations surface, not a marketing page. Keep it dense and scan-friendly:

- table/list first, no hero section;
- fixed-width count columns so rows are easy to compare;
- destructive/error color only for the error indicator, not the whole page;
- truncation with tooltip for long sample messages;
- selected group remains visible while the thread panel loads.

### 8. Tests

Add tests for:

- range parsing maps `24h`, `7d`, and `30d` to the correct rolling windows;
- `/qaml-backdoor/errors` requires superuser;
- the loader returns top groups sorted by count, affected thread count, then last seen;
- selecting a group returns affected thread rows with links/joined metadata;
- empty states for no errors in the selected window;
- no stack traces, request bodies, or transcript-like data appear in returned dashboard rows.

## Files to Touch

Primary:

- `workers/main/src/identity/org-do.ts`
- `workers/main/src/chat-thread-do.ts`
- `workers/main/src/app-index-db.ts`
- `workers/main/src/admin-index-types.ts`
- `workers/main/src/admin-index-bootstrap.ts`
- `src/lib/auth-do.server.ts`
- `src/routes/_admin.chat-explorer.tsx`
- `src/routes/_admin.errors.tsx`
- `src/routes.ts`
- `src/components/admin/admin-sidebar.tsx`

Likely tests:

- `workers/main/tests/admin-index-chat-explorer.test.ts`
- admin-index tests for `thread_error_recorded`, `getChatErrorGroups`, and `getChatErrorThreads`
- route/loader tests for `/qaml-backdoor/errors` if a route-test pattern exists
- add or extend ChatThreadDO-focused worker tests for `getAdminExplorerSummary`
- add OrgDO tests for `recordThreadError` and model-history migration/update behavior

## Suggested Implementation Order

1. Add D1/DTO fields for error summary, `chat_error_events`, dashboard query methods, and model history, with null-safe query mapping.
2. Add `thread_error_recorded` to `AdminEventType` and handle it idempotently in `AppIndexDatabase`.
3. Add OrgDO schema fields and methods: `recordThreadError`, model-history merge on create/update.
4. Add app-side visible-row rehydration from OrgDO in `adminGetChatExplorerThreads`.
5. Add `ChatThreadDO.getAdminExplorerSummary` and use it only for missing/suspect rows.
6. Wire error recording from ChatThreadDO user-visible error paths.
7. Update Chat Explorer UI badges, message-count display, and `errors_only` filter.
8. Add `/qaml-backdoor/errors`, sidebar navigation, time-window selector, top-error table, and affected-thread panel.
9. Add/extend backfill observability and tests.

## Testing Plan

Run focused worker tests:

```bash
bun run test:workers -- workers/main/tests/admin-index-chat-explorer.test.ts
```

Add tests that cover:

- a D1 row with `user_message_count = NULL` is repaired from OrgDO and returned with a count;
- a stale row with `first_user_message` and `0` count can be repaired after the grace window;
- fallback summary counts visible user messages and returns `20+` semantics when capped;
- hidden Pi recovery and compact-summary messages are not counted as user messages;
- `recordThreadError` increments count, truncates message, dispatches to AdminIndex, and `errors_only` filters correctly;
- `thread_error_recorded` inserts idempotent `chat_error_events` rows without storing stacks or transcript-like data;
- `getChatErrorGroups` groups by fingerprint/date range and returns counts plus affected thread counts;
- `getChatErrorThreads` returns thread links/counts for a fingerprint/date range;
- `/qaml-backdoor/errors` shows top error groups for `24h`, `7d`, and `30d` and lists affected threads for a selected group;
- model history starts with create model, appends on `updateThreadModel`, dedupes repeated switches, and mirrors to AdminIndex;
- historical rows without model history return `[model]`.

Run:

```bash
bun run typecheck
```

Manual QA:

- open `/qaml-backdoor/chat-explorer`;
- verify old rows that previously hid counts now show counts or `20+`;
- create a new chat, send one message, and verify the count appears after refresh;
- switch models mid-thread and verify the row/header show multiple models;
- force a provider/chat error in local or staging and verify the row gets an Error badge and the Errors-only filter finds it.
- open `/qaml-backdoor/errors`, switch between Last 24h / Last 7d / Last 30d, select a top error, and verify affected-thread links open Chat Explorer and thread admin pages.

## Acceptance Criteria

- Chat Explorer shows a user-message count for normal current threads and most historical rows after visible-row repair/backfill.
- Missing counts do not display as `0` unless the source really says zero.
- Threads with user-visible chat errors get an Error badge and are discoverable through an Errors-only filter.
- New user-visible chat errors are stored as normalized D1 error events that can power a future top-errors-by-date dashboard with affected-thread links.
- `/qaml-backdoor/errors` appears directly under `Dashboard` in the admin sidebar and helps identify the most common bugs for Last 24h, Last 7d, and Last 30d.
- Chat Explorer shows the latest model and any previously selected models captured after this change.
- The normal user chat flow, read-only admin iframe, and existing `/qaml-backdoor/threads` table keep working.
