# Admin MCP Chat Errors Plan

## Goal

Make chat errors a first-class admin MCP surface so agents can easily answer questions like:

- "What chat errors spiked in the last 24 hours?"
- "Which threads are affected by this fingerprint?"
- "Are errors concentrated by model, provider, org, workspace, or source?"
- "Show recent example events for this error before I inspect thread messages."

The current `/qaml-backdoor/errors` page already has most of the data, but that data is only reachable through the React admin route and private server helpers. The implementation should expose the same D1-backed chat error data through a stable admin API endpoint and a dedicated MCP tool.

## Current State

Relevant files:

- `src/routes/_admin.errors.tsx`
  - Calls `authDO.adminGetChatErrorDashboard()`.
  - Supports a rolling `range` and optional `fingerprint`.
- `src/lib/auth-do.server.ts`
  - `adminGetChatErrorDashboard()` calls `getChatErrorSummary()`, `getChatErrorGroups()`, and `getChatErrorThreads()` on the admin index.
- `workers/main/src/app-index-db.ts`
  - D1 table `chat_error_events`.
  - Existing query methods:
    - `getChatErrorSummary({ startAt, endAt })`
    - `getChatErrorGroups({ startAt, endAt, limit, fingerprint? })`
    - `getChatErrorThreads({ fingerprint, startAt, endAt, limit, offset? })`
- `workers/main/src/routes/admin-mcp.ts`
  - No first-class chat error tool.
  - `admin_api_request` can only call `/api/admin/*`.
- `workers/main/src/routes/admin/routes.ts`
  - No `/api/admin/chat-errors` endpoint.

The dashboard data is not sourced from `ERROR_ANALYTICS`. It is sourced from D1 `chat_error_events`, populated from user-visible chat error events via `OrgDO.recordThreadError()` and admin index event dispatch.

## Desired Architecture

Add one canonical REST endpoint and one dedicated MCP tool:

1. `GET /api/admin/chat-errors`
   - The stable internal API contract.
   - Used by MCP and available for scripts/debugging.
   - Backed by the existing D1 admin index.

2. `query_chat_errors` MCP tool
   - Thin wrapper over `GET /api/admin/chat-errors`.
   - Accepts agent-friendly filters and defaults.
   - Returns the same JSON body as the REST endpoint.

Keep `/qaml-backdoor/errors` working as-is in the first implementation. It can be migrated to the new helper later, but do not make the UI migration a dependency for the MCP surface.

## Data Contract

### Endpoint

`GET /api/admin/chat-errors`

### Query Parameters

Use millisecond timestamps because the admin index stores millisecond timestamps.

Time window:

- `range`: optional enum, `1h | 6h | 24h | 7d | 30d`. Default: `24h`.
- `from`: optional integer milliseconds since epoch.
- `to`: optional integer milliseconds since epoch.

Resolution rules:

- If `from` or `to` is supplied, use explicit timestamps.
- Missing explicit `to` defaults to `Date.now()`.
- Missing explicit `from` with explicit `to` defaults to `to - 24h`.
- If neither timestamp is supplied, use `range`.
- Reject `from >= to`.
- Clamp maximum window to 90 days for the API and MCP tool.

Filters:

- `fingerprint`: exact fingerprint.
- `org_id`: exact org id.
- `workspace_id`: exact workspace id.
- `thread_id`: exact thread id.
- `user_id`: exact user id.
- `source`: exact source, for example `pi_provider`.
- `error_kind`: exact normalized kind.
- `provider`: exact provider.
- `model`: exact model.
- `status`: integer status.
- `search`: optional substring search over `message_normalized` and `message_sample`.

Pagination and shape:

- `limit`: group limit, default `50`, max `200`.
- `offset`: group offset, default `0`, max sensible integer.
- `threads_limit`: affected thread limit, default `50`, max `200`.
- `threads_offset`: affected thread offset, default `0`.
- `events_limit`: recent event limit, default `0`, max `200`.
- `events_offset`: recent event offset, default `0`.
- `include_threads`: boolean, default `true` when `fingerprint` is supplied, otherwise `false`.
- `include_events`: boolean, default `false`.
- `include_breakdowns`: boolean, default `true`.

Sorting:

- `sort_by`: optional enum for groups: `count | affected_threads | last_seen | first_seen`. Default: `count`.
- `sort_dir`: optional enum `asc | desc`. Default: `desc`.
- Recent events always sort by `created_at DESC`.
- Affected threads sort by `last_seen_at DESC, count DESC, thread_id ASC`.

### Response Shape

```ts
type AdminChatErrorsResponse = {
  query: {
    from: number;
    to: number;
    range: string | null;
    filters: {
      fingerprint?: string;
      org_id?: string;
      workspace_id?: string;
      thread_id?: string;
      user_id?: string;
      source?: string;
      error_kind?: string;
      provider?: string;
      model?: string;
      status?: number;
      search?: string;
    };
    limit: number;
    offset: number;
    threads_limit: number;
    threads_offset: number;
    events_limit: number;
    events_offset: number;
  };
  summary: {
    total_events: number;
    affected_threads: number;
    distinct_groups: number;
    latest_error_at: number | null;
  };
  groups: Array<{
    fingerprint: string;
    message_sample: string;
    source: string;
    error_kind: string | null;
    status: number | null;
    provider: string | null;
    model: string | null;
    count: number;
    affected_thread_count: number;
    first_seen_at: number;
    last_seen_at: number;
  }>;
  breakdowns?: {
    source: AdminChatErrorBreakdownRow[];
    error_kind: AdminChatErrorBreakdownRow[];
    status: AdminChatErrorBreakdownRow[];
    provider: AdminChatErrorBreakdownRow[];
    model: AdminChatErrorBreakdownRow[];
  };
  threads?: Array<{
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
  }>;
  events?: Array<{
    id: string;
    fingerprint: string;
    thread_id: string;
    title: string | null;
    org_id: string;
    org_name: string | null;
    workspace_id: string;
    workspace_name: string | null;
    user_id: string | null;
    user_email: string | null;
    created_at: number;
    source: string;
    error_kind: string | null;
    status: number | null;
    provider: string | null;
    model: string | null;
    message_sample: string;
    message_normalized: string;
  }>;
};

type AdminChatErrorBreakdownRow = {
  value: string | number | null;
  count: number;
  affected_thread_count: number;
  latest_error_at: number | null;
};
```

Response defaults:

- Always include `query`, `summary`, and `groups`.
- Include `breakdowns` by default because agents need quick analysis by dimension.
- Include `threads` only when `include_threads=true` or `fingerprint` is present.
- Include `events` only when `include_events=true` and `events_limit > 0`.

## D1 Admin Index Changes

Update `workers/main/src/admin-index-types.ts`:

- Add:
  - `AdminChatErrorFilters`
  - `AdminChatErrorQueryOptions`
  - `AdminChatErrorEventRow`
  - `AdminChatErrorBreakdownRow`
  - `AdminChatErrorsResponse` if useful outside route code.
- Extend existing query method option types to accept common filters.

Update `workers/main/src/app-index-db.ts`:

1. Add a private/common filter builder.

   Requirements:

   - Build SQL from an allowlisted column map only.
   - Parameterize all user input.
   - Support aliases, for example `e.created_at` vs `created_at`.
   - Return `{ whereSql, params }`.
   - Search should use `LIKE ?` against `message_normalized` and `message_sample`.
   - Keep `status` numeric only.

   Suggested shape:

   ```ts
   type ChatErrorSqlFilterOptions = {
     alias?: string;
     startAt: number;
     endAt: number;
     filters?: AdminChatErrorFilters;
   };

   function buildChatErrorWhere(options: ChatErrorSqlFilterOptions): {
     whereSql: string;
     params: unknown[];
   }
   ```

2. Update existing methods:

   - `getChatErrorSummary(options)` should apply all filters.
   - `getChatErrorGroups(options)` should apply all filters and support `sort_by`, `sort_dir`, and `offset`.
   - `getChatErrorThreads(options)` should support:
     - optional `fingerprint`;
     - all common filters;
     - one row per thread;
     - stable metadata joins to `threads`, `orgs`, `workspaces`, and `users`.

3. Add new methods:

   - `getChatErrorBreakdowns(options)`
   - `getChatErrorEvents(options)`

4. Preserve existing `/qaml-backdoor/errors` behavior.

   - The current calls with only `startAt`, `endAt`, `fingerprint`, and `limit` should continue to work.
   - Do not change the shape returned by `adminGetChatErrorDashboard()`.

### Affected Thread Query

Use a grouped-by-thread CTE so one thread appears once even if multiple users are attached to events:

```sql
WITH grouped AS (
  SELECT
    e.thread_id,
    MAX(e.created_at) AS last_seen_at,
    COUNT(*) AS count,
    MAX(e.org_id) AS org_id,
    MAX(e.workspace_id) AS workspace_id,
    (
      SELECT latest.user_id
      FROM chat_error_events latest
      WHERE latest.thread_id = e.thread_id
        AND latest.created_at >= ?
        AND latest.created_at < ?
      ORDER BY latest.created_at DESC
      LIMIT 1
    ) AS latest_user_id
  FROM chat_error_events e
  WHERE ...
  GROUP BY e.thread_id
)
SELECT ...
```

Add `fingerprint` to the inner `latest` selector when `fingerprint` is part of the filter. If the filter builder cannot be reused inside the correlated selector cleanly, keep that selector small and explicitly pass the fingerprint/time parameters.

## Admin API Changes

Update `workers/main/src/routes/admin/index.ts` route list comment:

- Add `GET /api/admin/chat-errors`.

Update `workers/main/src/routes/admin/schemas.ts`:

- Add `ChatErrorsQuerySchema`.
- Add response schemas for the response shape above.
- Keep schema field names snake_case to match existing admin API style.

Update `workers/main/src/routes/admin/routes.ts`:

- Add `GET /chat-errors`.
- Use `getAdminIndexStub(c.env)`.
- Parse and validate the time window in route code or a small local helper.
- Call the new/extended D1 methods concurrently where possible:

  ```ts
  const [summary, groups, breakdowns, threads, events] = await Promise.all([
    adminIndex.getChatErrorSummary(query),
    adminIndex.getChatErrorGroups(query),
    includeBreakdowns ? adminIndex.getChatErrorBreakdowns(query) : undefined,
    includeThreads ? adminIndex.getChatErrorThreads(query) : undefined,
    includeEvents ? adminIndex.getChatErrorEvents(query) : undefined,
  ]);
  ```

- Return `400` for invalid windows, invalid status, invalid enum values, and excessive ranges.
- Do not expose stack traces or raw transcript contents.

## MCP Tool Changes

Update `workers/main/src/routes/admin-mcp.ts`:

1. Add constant:

   ```ts
   const TOOL_QUERY_CHAT_ERRORS = "query_chat_errors";
   ```

2. Add to `adminTools()` with an input schema matching the endpoint query params.

   Description:

   > Query user-visible chat errors recorded in the admin error dashboard. Returns summaries, grouped fingerprints, optional dimension breakdowns, optional affected threads, and optional recent event samples. Use `fingerprint` plus `include_threads` to drill into one grouped error; use `include_events` for concrete examples before fetching thread messages.

3. Add to `callTool()`:

   ```ts
   if (name === TOOL_QUERY_CHAT_ERRORS) {
     return fetchAdminApiTool(req, env, grant, {
       method: "GET",
       path: "/api/admin/chat-errors",
       query: pickQuery(input, [
         "range",
         "from",
         "to",
         "fingerprint",
         "org_id",
         "workspace_id",
         "thread_id",
         "user_id",
         "source",
         "error_kind",
         "provider",
         "model",
         "status",
         "search",
         "limit",
         "offset",
         "threads_limit",
         "threads_offset",
         "events_limit",
         "events_offset",
         "include_threads",
         "include_events",
         "include_breakdowns",
         "sort_by",
         "sort_dir",
       ]),
     });
   }
   ```

4. Add the tool to the tool-list test expectations.

Do not make agents use `admin_api_request` for this common path. Keep `admin_api_request` as an escape hatch only.

## Authentication And Safety

- Admin API endpoint remains bearer-admin only through the existing Hono admin API.
- MCP tool remains OAuth-protected and superuser-only through existing admin MCP auth.
- Data contains normalized error messages, ids, model/provider metadata, and user/org/workspace metadata. This is admin-sensitive but not transcript-like.
- Do not add request bodies, auth headers, secrets, BYOK keys, stack traces, or full chat transcript data.
- Cap response sizes:
  - group limit max `200`;
  - thread limit max `200`;
  - event limit max `200`;
  - time window max `90d`.
- Keep defaults small and useful:
  - 24h window;
  - 50 groups;
  - no raw events unless requested.

## Tests

### D1 Query Tests

Add focused tests to `workers/main/tests/admin-index-chat-explorer.test.ts` or a new `workers/main/tests/admin-index-chat-errors.test.ts`.

Seed data with `getAppIndexDatabase(testEnv)!.applyAdminEvent()`:

- `user_upsert`
- `org_upsert`
- `workspace_upsert`
- `thread_upsert`
- `thread_error_recorded`

Test cases:

1. Summary and groups count only events inside the requested window.
2. `fingerprint` filter returns one group and one affected-thread row per thread.
3. Two events for the same thread with different `user_id` values return one affected-thread row with `count = 2`.
4. Filters work for `org_id`, `workspace_id`, `thread_id`, `provider`, `model`, `source`, `error_kind`, and `status`.
5. `search` matches normalized/sample message text without changing unrelated rows.
6. Breakdowns return counts by `source`, `error_kind`, `status`, `provider`, and `model`.
7. Recent events include joined thread/org/workspace/user metadata and respect pagination.

### Admin API Tests

Add `workers/main/tests/admin-api-chat-errors.test.ts`.

Test cases:

1. `GET /api/admin/chat-errors` returns `query`, `summary`, `groups`, and `breakdowns` by default.
2. `fingerprint` includes `threads` by default.
3. `include_events=true&events_limit=2` includes recent events.
4. Invalid `from >= to` returns `400`.
5. Excessive time window returns `400`.
6. Limit clamping or validation matches the chosen route behavior.
7. Unknown route auth behavior remains unchanged.

### MCP Tests

Update `workers/main/tests/admin-mcp-oauth.test.ts`.

Test cases:

1. `tools/list` includes `query_chat_errors`.
2. Superuser can call `query_chat_errors` and receives seeded dashboard data.
3. Non-superusers still cannot call it because existing admin MCP auth blocks before tool dispatch.
4. `query_chat_errors` with `fingerprint` returns affected threads.
5. The tool maps query args to `/api/admin/chat-errors`, not to raw DO or D1 access.

## Documentation Updates

Update `docs/admin-api-reference.md`:

- Add `GET /api/admin/chat-errors`.
- Document common query examples:
  - top errors last 24h;
  - drill into one fingerprint;
  - recent examples for provider/model;
  - events for one org/workspace.

Optional but useful: add a short "Admin MCP error investigation workflow" section:

1. Call `query_chat_errors` for top groups.
2. Call `query_chat_errors` with `fingerprint` and `include_threads=true`.
3. Use `get_thread_messages` or `get_thread_jsonl` on representative `thread_id`s.
4. Use `search_threads` for adjacent thread context if needed.

## Implementation Order

1. Add types in `admin-index-types.ts`.
2. Add common D1 filter builder and extend existing chat error query methods.
3. Add `getChatErrorBreakdowns()` and `getChatErrorEvents()`.
4. Add D1 query tests.
5. Add admin API schemas and `GET /api/admin/chat-errors`.
6. Add admin API tests.
7. Add `query_chat_errors` MCP tool.
8. Update MCP tests.
9. Update `docs/admin-api-reference.md`.
10. Run:

```bash
bun run test:workers -- workers/main/tests/admin-index-chat-errors.test.ts workers/main/tests/admin-api-chat-errors.test.ts workers/main/tests/admin-mcp-oauth.test.ts
bun run typecheck
```

If the D1 tests are added to `admin-index-chat-explorer.test.ts` instead of a new file, adjust the first command accordingly.

## Acceptance Criteria

- Admin MCP exposes a dedicated `query_chat_errors` tool.
- Agents can get top grouped errors without knowing `/qaml-backdoor` internals.
- Agents can drill from a fingerprint to affected threads.
- Agents can request recent concrete event examples.
- Agents can filter by org, workspace, thread, user, source, error kind, provider, model, status, and message search.
- API and MCP responses are bounded by default and cannot dump large windows accidentally.
- Existing `/qaml-backdoor/errors` behavior is unchanged.
- New tests cover D1 query logic, REST endpoint behavior, and MCP access.

## Non-Goals

- Do not replace `ERROR_ANALYTICS` or Cloudflare Analytics Engine querying.
- Do not expose raw chat transcripts in the chat error endpoint.
- Do not require the `/qaml-backdoor/errors` UI to migrate to the new endpoint in this change.
- Do not add write/repair operations to the chat error MCP surface.
- Do not backfill historical operational errors from `ERROR_ANALYTICS` into `chat_error_events`.
