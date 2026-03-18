# camelAI Admin API Reference

Audited from code on 2026-03-18.

This document covers the internal admin API surface in `camelAI`, with emphasis on the endpoints an external agent can call safely and the response shapes that actually come back from the current implementation.

## Scope

There are two different things living under `/api/admin/*`:

1. A bearer-token Hono API in `workers/main/src/routes/admin/*`
2. One superuser session-auth React Router troubleshooting route:
   - `GET /api/admin/threads/:id/jsonl`

If a request includes `Authorization: Bearer <ADMIN_API_KEY>`, the Worker sends it to the Hono admin API first. If it does not include a bearer token, the request falls through to React Router.

That means:

- External agents should use the bearer-token endpoints documented below.
- `GET /api/admin/threads/:id/messages` now works through either auth path: bearer token or superuser session.
- `GET /api/admin/threads/:id/jsonl` remains a browser-session route, not a bearer-token route.
- If you send a bearer token to `/api/admin/threads/:id/jsonl`, you will get the Hono admin API's JSON `404`, not the React Router route.

## Auth And Base Behavior

Base path: `/api/admin`

Auth for bearer-token API:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

Notes:

- `GET /api/admin/openapi.json` also requires the bearer token.
- If `ADMIN_API_KEY` is not configured, bearer-token requests return `503 {"error":"Admin API not configured"}`.
- If the token is wrong, bearer-token requests return `401 {"error":"Unauthorized"}`.
- Unknown bearer-token paths return `404 {"error":"Not found"}`.
- Successful `GET` responses from the Hono API get `Cache-Control: private, max-age=30`.
- Most explicit error responses use the shape `{ "error": string }`.

## Common Response Envelopes

Paginated list endpoints:

```json
{
  "items": [],
  "total": 0,
  "offset": 0,
  "limit": 50
}
```

Simple list endpoints:

```json
{
  "data": []
}
```

Boolean query params:

- Accepted values are only `true`, `false`, `1`, `0`.
- `limit` defaults to `50` and is capped at `100`.
- `offset` defaults to `0`.

## Recommended Agent Usage

For an agent client:

1. Fetch `/api/admin/openapi.json` first for machine-readable discovery.
2. Use this document for implementation quirks the OpenAPI spec does not fully capture.
3. Treat documented fields as stable, and treat extra fields in list results as incidental unless you have verified them in production.
4. Prefer paginated list endpoints over storage-wide scans like `/kv` and `/r2`.

## Endpoint Index

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/admin/openapi.json` | Bearer | Generated OpenAPI 3.1 spec |
| `GET` | `/api/admin/stats` | Bearer | Aggregate counts |
| `GET` | `/api/admin/users` | Bearer | Paginated users |
| `GET` | `/api/admin/users/:id/orgs` | Bearer | User org memberships |
| `GET` | `/api/admin/orgs` | Bearer | Paginated orgs |
| `GET` | `/api/admin/orgs/:id` | Bearer | Org detail plus recent activity |
| `POST` | `/api/admin/orgs/:id/members` | Bearer | Add or upsert an org member |
| `GET` | `/api/admin/orgs/:id/usage/spend` | Bearer | Spend totals and rolling windows |
| `GET` | `/api/admin/orgs/:id/usage/limits` | Bearer | Effective spend limits |
| `PUT` | `/api/admin/orgs/:id/usage/limits` | Bearer | Set or clear spend limit overrides |
| `GET` | `/api/admin/orgs/:id/usage/log` | Bearer | Recent usage log entries |
| `GET` | `/api/admin/threads` | Bearer | Paginated threads |
| `GET` | `/api/admin/threads/:id/messages` | Bearer or superuser session | Parsed thread messages |
| `PATCH` | `/api/admin/threads/:id` | Bearer | Update thread title and/or creator |
| `GET` | `/api/admin/workspaces` | Bearer | Paginated workspaces |
| `GET` | `/api/admin/apps` | Bearer | Paginated apps |
| `GET` | `/api/admin/kv` | Bearer | List keys in `EMAIL_TO_USER` KV |
| `GET` | `/api/admin/kv/:key` | Bearer | Read a single `EMAIL_TO_USER` KV value |
| `GET` | `/api/admin/r2` | Bearer | List objects in `R2_BUCKET` |
| `GET` | `/api/admin/r2/*` | Bearer | Head metadata for one R2 object |
| `GET` | `/api/admin/threads/:id/jsonl` | Superuser session | Raw JSONL download |

## Bearer-Token Endpoints

### `GET /api/admin/openapi.json`

Returns the Hono-generated OpenAPI 3.1 document for the bearer-token admin API.

Useful for:

- Machine discovery
- Client generation
- Quickly checking query/body validation rules

Caveat:

- The generated schema is narrower than the runtime in a few places. See `Audit Findings` below.

### `GET /api/admin/stats`

Aggregate counts:

```json
{
  "total_users": 0,
  "total_orgs": 0,
  "total_memberships": 0,
  "total_workspaces": 0,
  "total_integrations": 0,
  "orphaned_users": 0
}
```

### `GET /api/admin/users`

Paginated user list.

Query params:

- `limit`
- `offset`
- `search`
- `is_superuser`
- `is_orphaned`
- `sort_by`: `created_at | email | name`
- `sort_dir`: `asc | desc`

Search matches:

- `email`
- `name`

Stable item fields:

- `id`
- `email`
- `name`
- `avatar`
  - `color`
  - `content`
- `created_at`
- `org_count`
- `is_superuser`
- `is_orphaned`

Current implementation detail:

- Runtime items also include `avatar_color` and `avatar_content` because the handler spreads raw SQL rows before adding `avatar`.

### `GET /api/admin/users/:id/orgs`

Returns the memberships stored in that user's `UserDO`.

Response shape:

```json
{
  "data": [
    {
      "org_id": "org_123",
      "role": "member",
      "joined_at": 1730000000000,
      "last_workspace_id": "ws_123"
    }
  ]
}
```

Notes:

- The OpenAPI schema currently only documents `org_id` and `role`.
- The actual runtime also includes `joined_at` and `last_workspace_id`.
- Results are ordered by `joined_at ASC`.

### `GET /api/admin/orgs`

Paginated org list.

Query params:

- `limit`
- `offset`
- `search`
- `archived`
- `sort_by`: `created_at | name`
- `sort_dir`: `asc | desc`

Search matches:

- `name`

Stable item fields:

- `id`
- `name`
- `slug`
- `created_by`
- `created_at`
- `archived`
- `billing_status`
- `member_count`
- `workspace_count`

### `GET /api/admin/orgs/:id`

Returns org detail plus recent activity.

Response fields:

- `id`
- `name`
- `slug`
- `created_by`
- `created_at`
- `archived`
- `member_count`
- `workspace_count`
- `threads`
- `apps`
- `threadCount`
- `appCount`

`threads`:

- Up to 10 recent threads for the org
- Ordered by `updated_at DESC`
- Same general shape as `/api/admin/threads` items:
  - `id`
  - `title`
  - `org_id`
  - `workspace_id`
  - `created_at`
  - `updated_at`
  - `created_by`
  - `org_name`
  - `workspace_name`

`apps`:

- Up to 10 recent apps for the org
- Ordered by `updated_at DESC`
- Same general shape as `/api/admin/apps` items

Counts:

- `threadCount` is the exact org thread count
- `appCount` is the exact org app count

### `POST /api/admin/orgs/:id/members`

Adds a member to an org.

Request body:

```json
{
  "user_id": "user_123",
  "role": "member"
}
```

Allowed roles:

- `member`
- `admin`

Response:

```json
{
  "org_id": "org_123",
  "user_id": "user_123",
  "role": "member"
}
```

Behavior notes:

- This is effectively an upsert.
- If the user is already a member, both the org membership row and user membership row are replaced and their `joined_at` timestamps are reset to `Date.now()`.
- The endpoint checks that both the org and user exist first.
- It does not support creating `owner` or `viewer` memberships.

### `GET /api/admin/orgs/:id/usage/spend`

Returns lifetime totals plus rolling window status.

Response shape:

```json
{
  "org_id": "org_123",
  "total_cost_usd": 12.34,
  "total_requests": 456,
  "windows": [
    {
      "label": "5h",
      "window_ms": 18000000,
      "limit_usd": 50,
      "spent_usd": 12.34,
      "exceeded": false
    }
  ]
}
```

Notes:

- `windows` come from the sandbox-host usage store.
- Default limits, if no overrides exist, are currently:
  - `5h` / `$50`
  - `7d` / `$200`

### `GET /api/admin/orgs/:id/usage/limits`

Returns the effective spend limits for the org.

Response shape:

```json
{
  "org_id": "org_123",
  "limits": [
    {
      "window": 18000000000000,
      "limit_usd": 50,
      "label": "5h"
    }
  ]
}
```

Important:

- `window` is serialized from Go `time.Duration`.
- In practice that means the value is a raw integer duration in nanoseconds.
- To convert to hours:

```text
hours = window / 3_600_000_000_000
```

### `PUT /api/admin/orgs/:id/usage/limits`

Sets per-org spend limit overrides.

Request body:

```json
{
  "limits": [
    {
      "window_hours": 24,
      "limit_usd": 100,
      "label": "1d"
    }
  ]
}
```

Behavior:

- `window_hours` must be `> 0`
- `limit_usd` must be `> 0`
- `label` is optional; if omitted, sandbox-host derives one like `5h` or `7d`
- An empty array clears org-specific overrides and reverts to defaults

Response:

- Same shape as `GET /api/admin/orgs/:id/usage/limits`

Important proxy quirk:

- Validation for this endpoint happens in sandbox-host.
- If sandbox-host rejects the body with `400`, the admin API currently collapses that into `502 {"error":"Sandbox host returned 400"}`.

### `GET /api/admin/orgs/:id/usage/log`

Returns recent usage log entries for the org.

Query params:

- `limit`: optional, `1..500`

Response shape:

```json
{
  "org_id": "org_123",
  "entries": [
    {
      "id": 1,
      "workspace_id": "ws_123",
      "user_id": "user_123",
      "thread_id": "thread_123",
      "model": "claude-sonnet-4-20250514",
      "provider": "anthropic",
      "input_tokens": 100,
      "output_tokens": 50,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "cost_usd": 0.0123,
      "duration_ms": 1500,
      "created_at_ms": 1730000000000
    }
  ],
  "count": 1
}
```

Notes:

- Entries are ordered by `created_at_ms DESC`.
- The Worker proxies sandbox-host and again turns upstream non-2xx into `502`.

### `GET /api/admin/threads`

Paginated thread list.

Query params:

- `limit`
- `offset`
- `search`
- `org_id`
- `workspace_id`
- `created_by`
- `sort_by`: `created_at | updated_at`
- `sort_dir`: `asc | desc`

Search matches:

- thread `title`
- org `name`
- workspace `name`

Item fields:

- `id`
- `title`
- `workspace_id`
- `created_at`
- `updated_at`
- `created_by`
- `org_id`
- `org_name`
- `workspace_name`

### `GET /api/admin/threads/:id/messages`

Returns parsed thread history for a thread.

This path now works in two modes:

- bearer token via the Hono admin API
- superuser browser session via the React Router loader

Response shape:

```json
{
  "success": true,
  "messages": [
    {
      "id": "u1",
      "thread_id": "thread_123",
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "hello"
        }
      ],
      "created_at": 1730000000000
    }
  ]
}
```

Message fields:

- `id`
- `thread_id`
- `role`: `user | assistant`
- `content`: dynamic parsed message content
- `created_at`
- optional `isMeta`
- optional `sourceToolUseID`
- optional `isCompactSummary`

Behavior notes:

- The route resolves org/workspace automatically from `ADMIN_INDEX`.
- It validates that the thread still exists in the resolved org/workspace before calling sandbox-host.
- It proxies sandbox-host's parsed JSONL response.
- If the JSONL file does not exist yet, sandbox-host returns `success: true` with an empty `messages` array.

### `PATCH /api/admin/threads/:id`

Updates a thread title and/or creator.

Request body:

```json
{
  "title": "New title",
  "created_by": "user_123"
}
```

Rules:

- At least one of `title` or `created_by` is required
- The endpoint does not validate that `created_by` points to a real user

Response fields:

- Same general thread shape as `/api/admin/threads` items

Behavior notes:

- `updated_at` is always bumped to `Date.now()`
- If the admin index is stale, the Worker falls back to scanning up to the first 1000 orgs from the admin index and attempting the update in each org DO

### `GET /api/admin/workspaces`

Paginated workspace list.

Query params:

- `limit`
- `offset`
- `search`
- `org_id`
- `archived`
- `sort_by`: `created_at | name`
- `sort_dir`: `asc | desc`

Search matches:

- workspace `name`
- org `name`

Stable item fields:

- `id`
- `name`
- `org_id`
- `org_name`
- `description`
- `avatar`
  - `color`
  - `content`
- `created_at`
- `created_by`
- `archived`
- `archived_at`
- `archived_by`
- `compute_tier`
- `thread_count`
- `integration_count`

Current implementation detail:

- Runtime items also include `avatar_color` and `avatar_content`.

### `GET /api/admin/apps`

Paginated app list.

Query params:

- `limit`
- `offset`
- `search`
- `org_id`
- `workspace_id`
- `is_public`
- `sort_by`: `created_at | updated_at`
- `sort_dir`: `asc | desc`

Search matches:

- `script_name`
- org `name`
- workspace `name`
- creator `name`
- creator `email`

Item fields:

- `app_id`
- `script_name`
- `org_id`
- `workspace_id`
- `org_name`
- `org_slug`
- `workspace_name`
- `created_by`
- `created_by_name`
- `created_by_email`
- `created_at`
- `updated_at`
- `is_public`
- `preview_status`
- `preview_error`

### `GET /api/admin/kv`

Lists keys from the `EMAIL_TO_USER` KV namespace only.

This endpoint is named generically, but it is not a cross-namespace KV browser.

Query params:

- `prefix`

Response:

```json
{
  "data": [
    {
      "name": "email:user@example.com",
      "metadata": null
    }
  ]
}
```

Notes:

- The handler internally paginates through the entire namespace and returns one combined array.
- There is no API-level `limit` or `cursor`.

### `GET /api/admin/kv/:key`

Reads one value from `EMAIL_TO_USER`.

Response shapes:

```json
{
  "key": "email:user@example.com",
  "value": "user_123",
  "type": "string"
}
```

or

```json
{
  "key": "some_json_key",
  "value": {
    "foo": "bar"
  },
  "type": "json"
}
```

Important:

- The handler path is `:key`, not a wildcard.
- Keys containing `/` cannot be fetched with this route.

### `GET /api/admin/r2`

Lists objects from the `R2_BUCKET` binding.

Query params:

- `prefix`

Response:

```json
{
  "data": [
    {
      "key": "app-previews/org/ws/script/current.jpg",
      "size": 12345,
      "lastModified": "2026-03-18T12:34:56.000Z",
      "etag": "..."
    }
  ]
}
```

Notes:

- The handler internally paginates through the bucket and returns one combined array.
- There is no API-level `limit` or `cursor`.

### `GET /api/admin/r2/*`

Returns object metadata for a single R2 object.

Example:

```text
/api/admin/r2/app-previews/org/ws/script/current.jpg
```

Response fields:

- `key`
- `size`
- `lastModified`
- `etag`
- `httpMetadata`
- `customMetadata`

Important:

- This is a metadata endpoint only.
- It uses `R2_BUCKET.head(key)` and does not return object bytes.
- The wildcard route is needed because keys may contain `/`.

## Session-Auth Troubleshooting Endpoints

These routes are not available through the bearer-token Hono API.

They require:

- the same app origin and base URL as the rest of the app
- a normal browser session
- a logged-in user who passes `requireSuperuser(...)`

Important:

- Do not send `Authorization: Bearer ...` to these routes.
- With a bearer token present, the Worker routes the request into the Hono admin API first, and because that API does not define these paths, you get a JSON `404`.
- For these routes, the auth mechanism is the app's normal session cookie, not `ADMIN_API_KEY`.

### `GET /api/admin/threads/:id/jsonl`

Purpose:

- Downloads the raw Claude session JSONL file for a thread

Required query params:

- `orgId`
- `workspaceId`

Response:

- Content-Type: `application/x-ndjson; charset=utf-8`
- Content-Disposition: attachment with `<threadId>.jsonl`

Behavior notes:

- This route validates that the thread belongs to the supplied `orgId` and `workspaceId`.
- It checks the known Claude JSONL path candidates and streams the first match.
- Missing query params return `400`.
- Missing file returns `404`.

## Audit Findings

### 1. `/api/admin/*` is split across two auth models

The routing is intentional, but easy to misuse:

- bearer token present: Hono admin API handles the request
- bearer token absent: request falls through to React Router

For external agents, this means:

- `GET /api/admin/threads/:id/messages` can now be called with bearer auth
- `GET /api/admin/threads/:id/jsonl` still cannot

### 2. The OpenAPI spec is not the full runtime contract

The Hono route schemas are useful, but some runtime responses are broader:

- `GET /users/:id/orgs` returns `joined_at` and `last_workspace_id`, even though the schema only declares `org_id` and `role`
- `GET /users` currently includes `avatar_color` and `avatar_content`
- `GET /workspaces` currently includes `avatar_color` and `avatar_content`

For generated clients, use the spec as the stable minimum contract, not the exhaustive runtime payload.

### 3. `/kv` is narrower than its name suggests

`/api/admin/kv` and `/api/admin/kv/:key` only operate on the `EMAIL_TO_USER` KV binding.

They do not expose:

- `APP_KV`
- `SESSIONS`
- arbitrary KV namespaces

### 4. `/kv/:key` cannot fetch keys with slashes

Because the route is `:key` instead of a wildcard, keys containing `/` are not addressable through this endpoint.

### 5. Usage proxy errors are flattened

For the org usage endpoints, upstream sandbox-host non-2xx responses are converted to:

```json
{
  "error": "Sandbox host returned <status>"
}
```

with HTTP status `502`.

That means upstream `400` validation errors are not surfaced as direct `400` responses by the admin API.

### 6. Usage limits response units are awkward

`PUT /orgs/:id/usage/limits` accepts `window_hours`, but `GET /orgs/:id/usage/limits` returns `window` as a raw Go `time.Duration` JSON integer, which is nanoseconds.

An agent should normalize that before reasoning about it.

## Minimal Curl Examples

```bash
export CAMEL_ADMIN_BASE_URL="https://your-hostname"
export CAMEL_ADMIN_TOKEN="your_admin_api_key"
```

```bash
curl -sS \
  -H "Authorization: Bearer $CAMEL_ADMIN_TOKEN" \
  "$CAMEL_ADMIN_BASE_URL/api/admin/stats"
```

```bash
curl -sS \
  -H "Authorization: Bearer $CAMEL_ADMIN_TOKEN" \
  "$CAMEL_ADMIN_BASE_URL/api/admin/users?limit=25&offset=0&is_superuser=false&sort_by=created_at&sort_dir=desc"
```

```bash
curl -sS \
  -H "Authorization: Bearer $CAMEL_ADMIN_TOKEN" \
  "$CAMEL_ADMIN_BASE_URL/api/admin/orgs/org_123/usage/log?limit=20"
```

```bash
curl -sS \
  -X PUT \
  -H "Authorization: Bearer $CAMEL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$CAMEL_ADMIN_BASE_URL/api/admin/orgs/org_123/usage/limits" \
  -d '{"limits":[{"window_hours":24,"limit_usd":100,"label":"1d"}]}'
```
