# Admin API Metrics Endpoint Plan

## Objective

Upgrade the metrics-facing Admin API so the dashboard can fetch pre-aggregated usage and growth data in a small number of fast requests, instead of fanning out into hundreds of paginated or per-org calls and doing heavy client-side computation.

This plan is for the **Go admin API service** that powers the metrics dashboard. The Go service is not in this repo, but this repo contains the relevant camelAI data model and current admin/usage contracts that the implementation must stay aligned with.

## Route And Auth Contract

These endpoints should remain part of the existing admin API surface.

- Base path: `/api/admin`
- Auth: `Authorization: Bearer <ADMIN_API_KEY>`
- Boolean query parsing: preserve existing admin API conventions (`true`, `false`, `1`, `0`)

That means the requested routes should be exposed as:

- `GET /api/admin/spam/org-ids`
- `GET /api/admin/dashboard/summary`
- `GET /api/admin/dashboard/retention`
- `GET /api/admin/dashboard/top-orgs`
- `GET /api/admin/dashboard/spam-summary`
- `GET /api/admin/orgs/:id` (existing route, upgraded only if the Go service owns this contract)
- `GET /api/admin/orgs` (existing route, additive query params)

If the Go service is a separate process behind the Worker, the Worker may proxy to it, but the public route contract and bearer auth scheme should stay the same.

## Non-Negotiables

- Do not implement any new endpoint as a thin wrapper around existing per-org HTTP calls.
- Do not scan all orgs and then make N follow-up spend/limits calls.
- Do not move more aggregation to the client.
- Keep all existing admin API consumers working; new behavior on existing endpoints must be additive and backwards-compatible.
- Centralize spam filtering, internal-domain filtering, and activity definitions so every endpoint uses the same rules.
- Prefer set-based SQL and shared query helpers over endpoint-specific loops.
- Treat performance as a requirement, not a cleanup pass.

## Data Infrastructure Prerequisites

This is the critical missing assumption to make explicit:

- `AdminIndexDO` is a Cloudflare Durable Object and is **not directly queryable** from an external Go process.
- The per-org usage SQLite files are also the wrong shape for request-time cross-org analytics.

So the Go service must have its **own local analytics read model**. Do not start implementing the composite dashboard endpoints until this exists.

### Required analytics store contents

The Go service needs a replicated, queryable copy of:

- users
- orgs
- org memberships
- workspaces
- threads
- apps
- org usage rollups
- org effective spend limits
- daily user/org activity rollups

### Approved access pattern

Use this pattern:

1. The Go service owns a local analytics database optimized for metrics reads.
2. camelAI data is copied into that database by background sync jobs, not by request handlers.
3. All new metrics endpoints query only the local analytics database.

### Sync strategy

#### Entity data bootstrap

For the initial load, it is acceptable to pull from the existing admin API surface:

- `/api/admin/users`
- `/api/admin/orgs`
- `/api/admin/workspaces`
- `/api/admin/threads`
- `/api/admin/apps`

This is allowed for **offline bootstrap/sync**, not for request-time endpoint composition.

#### Entity data steady-state sync

Preferred order:

1. Add an append-only export or event feed from camelAI entity changes into the analytics store.
2. If that is not available yet, run periodic snapshot refreshes until an incremental feed exists.

The metrics endpoints themselves must never fan out to Worker routes at request time.

#### Usage data sync

Do not compute dashboard-wide usage by opening hundreds of per-org usage DBs during a request.

Use one of these:

1. A centralized usage fact table already owned by the Go service
2. A background job that copies usage rollups and effective limits into the analytics store
3. A materialized/rollup table maintained from a centralized raw usage feed

### Phase 0 deliverable

Before endpoints `summary`, `retention`, `top-orgs`, or `spam-summary` are implemented, the coding agent must confirm that the Go service can answer these from its own analytics store without request-time calls into `AdminIndexDO` or per-org usage files.

If that prerequisite is not met, the correct next step is to build the read model first.

## Required External Inputs

This repo does **not** contain the metrics dashboard code that defines:

- `computeDashboardData()`
- `computeRetentionData()`
- growth-threshold formulas
- weekly projection formulas
- exact `returning_users` semantics
- exact `new_active_users` semantics

Because of that, the coding agent must not invent these formulas while implementing the Go endpoints.

Before the formula-sensitive endpoints are built, provide one of:

1. The dashboard source files that contain those functions
2. Golden input/output fixtures generated from the current dashboard
3. A written spec that defines the formulas exactly

Without one of those inputs, only the structurally clear endpoints should proceed:

- `/api/admin/spam/org-ids`
- `/api/admin/orgs/:id`
- `/api/admin/orgs`
- `/api/admin/dashboard/top-orgs`

## Relevant camelAI Source Data

These files are the useful contract references from this repo:

- `workers/main/src/routes/admin/routes.ts`
  - Current bearer-token admin API shape for `/orgs`, `/orgs/:id`, `/orgs/:id/usage/*`, `/threads`, `/apps`, etc.
- `workers/main/src/routes/admin/schemas.ts`
  - Current request/response schemas and boolean query conventions.
- `workers/main/src/admin-index-do.ts`
  - Current denormalized read model for users, orgs, workspaces, threads, and apps.
- `workers/main/src/auth.ts`
  - Canonical org/workspace/thread/app/user fields and relationships inside camelAI.
- `src/types.ts`
  - Canonical field names and enum semantics, especially `Organization`, `User`, and `WorkerScript`.
- `services/sandbox-host/internal/state/usage_store.go`
  - Current usage storage shape and spend-limit semantics.
- `services/sandbox-host/internal/app/usage_routes.go`
  - Current org-scoped usage/spend API contract.

Important data-model notes from this repo:

- Users have `id`, `email`, `name`, `created_at`, `avatar`, `is_superuser`, `is_orphaned`.
- Orgs have `id`, `name`, `slug`, `created_at`, `created_by`, `billing_status`, `archived`.
- Workspaces belong to orgs.
- Threads belong to workspaces and orgs; author is `created_by`.
- Apps are `worker_scripts`; author is `created_by`; visibility is `is_public`.
- Usage limits currently exist as effective per-org windows, with defaults of `5h/$50` and `7d/$200` if no override exists.
- Spam orgs are defined here as orgs where **every effective usage window has `limit_usd <= 0.01`**.

## Centralized Analytics Design Decision

The new dashboard endpoints depend on **cross-org entity data and cross-org usage data**.

In the current camelAI runtime:

- entity data is primarily available through Worker/DO state
- usage is stored per org in separate SQLite files

Implementation rule:

1. If the Go admin API already has a centralized relational view of both entity and usage data, use it directly.
2. If it does not, add a small read-optimized analytics store first.
3. Do not implement these endpoints by issuing runtime fan-out calls into Worker admin routes.
4. Do not implement these endpoints by opening or querying hundreds of org-local usage stores at request time.

Minimum read-model capabilities needed:

- Users, orgs, memberships, workspaces, threads, and apps
- Effective spend-limit windows by org
- Lifetime requests/cost by org
- 7-day spend by org
- 30-day spend by org
- User activity by day
- Org activity by day

If centralized raw tables already exist, compute directly with SQL/CTEs. If not, create replicated or materialized analytics tables and keep them fresh in the background.

## Shared Semantics To Lock Down First

Before writing the new endpoints, create a single shared filtering/aggregation package in the Go service. Every endpoint below should call into it.

### 1. Spam org resolution

Canonical rule:

- `spam_org = org where COUNT(effective_windows) > 0 AND MAX(limit_usd) <= 0.01`

Notes:

- The logic must use **effective** limits, not just explicit override rows.
- In the current camelAI implementation, defaults are much higher than `$0.01`, so a spam org effectively implies a near-zero override set.
- Resolve spam org IDs once per request and reuse them.

### 2. Internal-domain exclusion

Canonical rule:

- Normalize the input as a comma-separated list of lowercase domains.
- Default should be `camelai.com` where the endpoint spec says so.
- Match against the email domain after `@`.

Entity-level behavior:

- User exclusion: exclude users whose own email domain matches.
- Org exclusion: exclude orgs whose creator's email domain matches.
- Thread/app activity exclusion: exclude records whose author's email domain matches.

### 3. Spam exclusion

Use one rule everywhere:

- Orgs: exclude spam org IDs.
- Threads/apps/workspaces: exclude rows belonging to spam org IDs.
- Users: exclude users who only belong to spam orgs.

If the existing dashboard code has a more specific user-level rule, preserve that exact rule and freeze it in tests before switching the client.

### 4. Activity definition

Do not invent a new definition per endpoint.

Default recommendation:

- A user is "active" on a date if they created at least one thread or app on that date.
- Daily activity tables/CTEs should be built from the union of:
  - `threads(created_by, org_id, created_at)`
  - `apps(created_by, org_id, created_at)`

If the existing dashboard JS uses a different definition in `computeDashboardData()` or `computeRetentionData()`, port that exact definition and add parity tests against it.

### 5. Timezone and calendar boundaries

Do not rely on the Go server's local timezone.

Implementation rule:

- Use one explicit analytics timezone for all day/week bucketing.
- If the current dashboard already has an established timezone, preserve it.
- Otherwise default to UTC and document it.
- Parse `date=YYYY-MM-DD` against that timezone, not against server-local time.

## API Contract Decisions

### Query parsing

Match current admin API conventions where practical:

- Booleans accept `true`, `false`, `1`, `0`
- `date` uses `YYYY-MM-DD`
- `exclude_internal_domains` accepts a comma-separated string

### Base path

All paths in this plan are relative to `/api/admin`, even where the shorthand below omits the prefix.

### Billing status normalization

There is a naming mismatch to resolve:

- camelAI source types use `billing_status: free | paying`
- the requested dashboard payload examples use `free | active`

Recommendation:

- At the metrics API boundary, normalize `paying -> active`
- Keep internal storage/querying in the service's canonical representation
- Use the normalized value consistently in:
  - `/dashboard/summary.billing_breakdown`
  - `/dashboard/top-orgs`
  - `/dashboard/spam-summary.orgs`
  - `/dashboard/spam-summary.org_usage`

### Response size discipline

For drill-down arrays, keep hard limits in the API instead of returning unbounded data:

- `top_users_by_threads`: 10
- `top_orgs_by_activity`: 10
- `latest_threads`: 10
- `latest_apps`: 10
- `latest_orgs`: 10
- `recent_users`: 10

If the existing dashboard currently renders a different count, preserve it exactly.

## Endpoint Plan

## 1. `GET /api/admin/spam/org-ids`

### Purpose

Replace hundreds of `/orgs/{id}/usage/limits` calls with one set-based lookup.

### Backend strategy

- Query the centralized effective-limits source.
- Return org IDs sorted stably, preferably ascending by `org_id`.
- Reuse the same spam-org resolver used by every other endpoint.

### Expected performance

- One query
- No per-org follow-ups
- Safe to cache briefly in-process because the data changes rarely

### Suggested tests

- Org with default limits is not spam
- Org with all effective limits `<= 0.01` is spam
- Org with one window above `0.01` is not spam
- `count` matches array length

## 2. `GET /api/admin/dashboard/summary`

### Purpose

Replace raw-entity fetches plus client-side `computeDashboardData()` with one pre-computed server response.

This endpoint is **blocked** until the dashboard formulas are attached as source files, golden fixtures, or a written spec.

### Query params

- `date` optional, default `today`
- `exclude_spam` optional, default `true`
- `exclude_internal_domains` optional, default `camelai.com`

Implementation rule:

- Preserve these requested defaults at the API layer, even if the dashboard later decides to expose a toggle.

### Implementation shape

Build this endpoint around one shared `BuildDashboardSummary(filters, selectedDay)` service function.

The handler should:

1. Parse and normalize query params
2. Resolve the shared filter context once
3. Run the required KPI/time-series/drill-down queries
4. Assemble the response without any internal HTTP calls

### Data to compute

#### KPIs

- `total_users`
- `total_orgs`
- `total_threads`
- `total_apps`
- `total_workspaces`

All counts must reflect the same filter context.

#### `daily_series`

Port the current JS semantics exactly for:

- `new_users`
- `new_threads`
- `new_apps`
- `returning_users`
- `new_active_users`
- `rolling_avg_signups`

Implementation note:

- Generate the daily buckets in SQL, not in the client.
- A date spine table/CTE is useful so days with zero values still appear.

#### `weekly_series`

- Build from the same daily source, not from a second activity definition.
- Preserve current partial-week projection logic for:
  - `projected_new_users`
  - `projected_returning_users`

If the existing dashboard code computes projections from day-of-week averages, port that logic exactly and cover it with fixtures.

#### `growth_thresholds`

These values are formula-dependent and easy to get subtly wrong.

Implementation rule:

- Lift the existing threshold formulas from the current dashboard logic.
- Write parity fixtures against frozen input/output samples before replacing the client.

#### `selected_day`

For the requested day:

- `new_users`
- `new_threads`
- `new_apps`
- `new_orgs`
- `top_users_by_threads`
- `top_orgs_by_activity`
- `latest_threads`
- `latest_apps`
- `latest_orgs`
- `recent_users`

Ranking recommendations:

- `top_users_by_threads`: distinct users ordered by thread count desc, then latest activity desc
- `top_orgs_by_activity`: preserve the current dashboard rule; if it is thread-driven today, keep that exact behavior

#### `billing_breakdown`

- Group filtered orgs by normalized status
- Return stable order, e.g. `active`, then `free`

#### `app_visibility`

- Count filtered apps grouped by `is_public`
- Return as `{ public, private }`

#### `retention_snapshot`

- Do not reimplement retention math inline here
- Call shared retention logic in-process and return the snapshot fields:
  - `rate_pct`
  - `cohort_size`
  - `retained_count`

### Performance notes

- This endpoint should make a small fixed number of SQL calls, not one call per subsection.
- Prefer CTE-heavy queries over repeated scans of the same fact tables.
- If the service has centralized activity facts, this should be comfortably sub-100ms at current camelAI scale.

## 3. `GET /api/admin/dashboard/retention`

### Purpose

Replace client-side `computeRetentionData()` and all raw-entity fan-out for the retention tab.

This endpoint is **blocked** until the current retention formulas and eligibility rules are attached as source files, golden fixtures, or a written spec.

### Query params

- `exclude_spam` optional, default `true`
- `exclude_internal_domains` optional, default `camelai.com`

### Shared foundation

Build one reusable activity fact source first:

- one row per `user_id` x `activity_date`
- filtered consistently for spam/internal exclusions

Everything in this endpoint should derive from that one fact source plus user signup date.

### Data to compute

#### `cohort_table`

- Weekly signup cohorts
- `cohort_size`
- week-by-week retained counts and percentages
- `max_week_columns`

#### `retention_curve`

- Use the same eligibility logic as the current dashboard
- Day 0 / Day 1 / Day 7 / Day 14 / Day 30 must match existing semantics exactly
- If the current UI expects a fuller day-by-day curve, return the full curve, not just checkpoint days

#### `wau_time_series`

- Weekly active users
- weekly new users
- weekly returning users

#### `stickiness_series`

- Daily DAU/WAU ratio for the last 30 days
- Return both raw counts and the ratio

#### KPIs

- `day1_retention`
- `day7_retention`
- `day14_retention`
- `day30_retention`
- `current_wau`
- `previous_wau`
- `wau_growth_pct`
- `avg_stickiness`

### Performance notes

- Use SQL set logic or one fast in-memory pass over pre-grouped rows.
- Do not do nested loops over `users x dates` in handler code.
- If raw activity tables are large, create a compact `user_daily_activity` rollup first.

## 4. `GET /api/admin/dashboard/top-orgs`

### Purpose

Replace the current pattern of fetching candidate orgs and then doing dozens of per-org spend requests.

### Query params

- `limit` optional, default `25`, hard max `100`
- `exclude_spam` optional, default `true`
- `sort_by` optional, default `spend_7d`

### Backend strategy

Join:

- org metadata
- creator user info
- member/workspace counts
- lifetime usage totals
- spend_30d
- spend_7d
- effective spend windows

Supported sorts:

- `spend_7d`
- `spend_30d`
- `member_count`

Recommended defaults:

- `limit=25`
- hard max `limit=100`

Tie-breakers:

- For spend sorts: `spend desc`, then `member_count desc`, then `org_id asc`
- For `member_count`: `member_count desc`, then `spend_30d desc`, then `org_id asc`

### Important implementation detail

If effective spend windows are stored one row per org/window, aggregate them in SQL before returning the response. Do not query windows org-by-org.

## 5. `GET /api/admin/dashboard/spam-summary`

### Purpose

Replace the spam tab's prefetch of raw entities plus per-org usage follow-ups.

### Query params

- None initially

Implementation rule:

- Keep the first version parameterless to match the requested contract.
- If payload size later becomes a real issue, add optional per-section limits in a backwards-compatible follow-up.

### Backend strategy

Resolve spam org IDs once, then fetch all spam-tab sections from that set:

- `users`
- `threads`
- `apps`
- `orgs`
- `org_usage`

Recommended ordering:

- `users`: newest first
- `threads`: newest first
- `apps`: newest first
- `orgs`: newest first
- `org_usage`: `spend_30d desc`, then newest first

### Payload shape guidance

- Reuse the same avatar shape already used elsewhere: `{ color, content }`
- Reuse the same org usage object shape as `/dashboard/top-orgs`
- Do not fetch this on the main dashboard load; only on spam-tab navigation, as intended

### Performance note

This is the one new endpoint that can legitimately return several arrays, but it still must be set-based. No per-org usage loops.

If spam volume is large enough to make this payload unwieldy, add optional per-section limits as a follow-up, but do not change the default contract unless the dashboard consumer is updated in lockstep.

## 6. `GET /api/admin/orgs/:id` modify existing

### Purpose

Support direct org lookup by ID.

Note:

- The Worker-side admin API in this repo already has an equivalent `GET /api/admin/orgs/:id`.
- If the Go service is taking ownership of this route, it should match that contract directly from its analytics store.
- This is not new product behavior; it is only new work if the Go service currently lacks the direct lookup path.

### Plan

- Add a direct primary-key lookup in the Go admin API if it does not already exist.
- Return a single org object or `404`.
- Do not implement this by paging through `/orgs`.

### Shape

Return the same base org object shape that `/orgs` returns for one row. Keep the shape consistent across list and detail lookups.

## 7. `GET /api/admin/orgs` modify existing

### Purpose

Move search/filter/enrichment server-side and remove client-side full-list scans.

### New query params

- `exclude_spam`
- `exclude_internal_domains`
- `search`
- `include_usage`
- `include_spend_30d`

### Required behavior

- `search` must match both `name` and `slug`, case-insensitively
- `exclude_spam` filters out spam org IDs
- `exclude_internal_domains` filters by creator email domain
- `include_usage=true` should include:
  - `total_requests`
  - `total_cost_usd`
  - `windows`
- `include_spend_30d=true` should include:
  - `spend_30d`

### Compatibility

- Keep existing pagination and sort behavior intact
- Make enrichment additive: fields only appear when requested
- Ensure `total` reflects the filtered dataset, not the unfiltered one

## Query And Index Plan

The exact schema in the Go service may differ, but the following access patterns must be cheap:

- org lookup by `id`
- org search by lower(name) and lower(slug)
- org filtering by creator
- user lookup by lower(email)
- memberships by `user_id` and by `org_id`
- threads/apps by `created_at`, `created_by`, and `org_id`
- daily activity by `user_id + activity_date`
- usage by `org_id`
- spend rollups by `org_id`
- effective limits by `org_id + window_label`

If new read-model tables are needed, the most useful ones are:

- `analytics_users`
  - `user_id`
  - `email`
  - `email_domain`
  - `name`
  - `created_at`
- `analytics_orgs`
  - `org_id`
  - `name`
  - `slug`
  - `created_by`
  - `creator_email`
  - `creator_email_domain`
  - `billing_status`
  - `created_at`
  - `archived`
- `analytics_memberships`
  - `org_id`
  - `user_id`
  - `role`
  - `joined_at`
- `analytics_workspaces`
  - `workspace_id`
  - `org_id`
  - `name`
  - `created_at`
- `analytics_threads`
  - `thread_id`
  - `org_id`
  - `workspace_id`
  - `created_by`
  - `created_at`
  - `updated_at`
- `analytics_apps`
  - `script_name`
  - `org_id`
  - `workspace_id`
  - `created_by`
  - `is_public`
  - `created_at`
  - `updated_at`

- `org_usage_rollups`
  - `org_id`
  - `total_requests`
  - `total_cost_usd`
  - `spend_7d`
  - `spend_30d`
  - `updated_at`
- `org_effective_limits`
  - `org_id`
  - `window_label`
  - `window_hours`
  - `limit_usd`
- `user_daily_activity`
  - `user_id`
  - `activity_date`
  - `thread_count`
  - `app_count`
  - `org_count`
- `org_daily_activity`
  - `org_id`
  - `activity_date`
  - `thread_count`
  - `app_count`
  - `active_user_count`

If centralized raw events already exist and benchmarks are good, materialized tables may be unnecessary. If they do not exist, add them rather than doing request-time fan-out.

## Delivery Order

## Phase 0: Make prerequisites explicit

1. Confirm route ownership and base path stay `/api/admin/*`.
2. Confirm bearer auth stays `ADMIN_API_KEY`.
3. Confirm the Go service has, or will get, a replicated analytics store for entity and usage data.
4. Attach dashboard formulas via source files, golden fixtures, or a written spec.

Do not skip this phase. Endpoints `summary` and `retention` are underspecified without it.

## Phase 1: Freeze semantics and add shared helpers

1. Extract the current dashboard formulas from `computeDashboardData()` and `computeRetentionData()`, or load the provided golden fixtures/spec.
2. Create parity fixtures from current dashboard outputs.
3. Implement shared helper packages for:
   - query param normalization
   - spam org resolution
   - internal-domain resolution
   - activity fact generation
   - billing status normalization
4. Stand up the analytics read model if it does not already exist.

This phase is mandatory. It prevents subtle KPI drift.

## Phase 2: Land the low-risk/high-impact endpoints first

1. `GET /spam/org-ids`
2. `GET /orgs/{id}` direct lookup
3. `GET /orgs` server-side filters and enrichment
4. `GET /dashboard/top-orgs`

These endpoints remove the worst N+1 patterns quickly and validate the shared filtering layer.

## Phase 3: Land the composite dashboard endpoints

1. `GET /dashboard/summary`
2. `GET /dashboard/retention`
3. `GET /dashboard/spam-summary`

Do these only after the shared filter/activity primitives are stable.

## Phase 4: Dashboard client migration

Update the metrics dashboard to:

- replace the fan-out calls with the new single endpoints
- delete client-side aggregation paths once parity is confirmed
- keep the old paths behind a short-lived fallback flag only if needed for rollout safety

## Testing Plan

## Contract tests

For every new or modified endpoint:

- valid query parsing
- default query behavior
- exact response field presence/absence
- stable sorting
- 404 behavior where applicable

## Parity tests

Build frozen fixtures comparing:

- current JS `computeDashboardData()` output
- new Go `/dashboard/summary` output

and:

- current JS `computeRetentionData()` output
- new Go `/dashboard/retention` output

These should use the same underlying snapshot and must match on all KPI and series values.

## Filter-semantics tests

Add focused tests for:

- spam org filtering
- internal-domain filtering
- combined spam + internal filters
- users with mixed spam and non-spam org memberships
- orgs created by internal users but with external members

## Performance tests

Add benchmarks with a realistic synthetic dataset. Minimum target budgets:

- `/spam/org-ids`: p95 under 50ms
- `/dashboard/top-orgs`: p95 under 100ms
- `/dashboard/summary`: p95 under 150ms
- `/dashboard/retention`: p95 under 200ms
- `/dashboard/spam-summary`: p95 under 150ms for typical spam-set sizes

The exact numbers can move, but the important rule is that none of these endpoints should scale linearly with "number of orgs x number of follow-up requests".

## Rollout Notes

- Add the new endpoints first.
- Switch the dashboard consumer endpoint-by-endpoint, starting with the worst N+1 paths.
- Watch for metric drift between the old client-computed values and the new server values during rollout.
- After rollout, remove the old dashboard fetch fan-out and client-side aggregation code.

## Questions That Must Be Answered Before Formula-Sensitive Endpoints Ship

1. What is the dashboard's exact analytics timezone today?
2. What is the current authoritative definition of `returning_users`?
3. What is the current authoritative definition of `new_active_users`?
4. What is the exact projection formula for `weekly_series.projected_*`?
5. Does the dashboard expect full day-by-day `retention_curve` output, or just checkpoint days?
6. Should `/api/admin/orgs` enrichment fields be omitted when not requested, or returned as `null`?
7. Does the dashboard render billing as `active` or `paying` today?

If any of these answers already exist in the dashboard code, preserve that behavior and lock it in with parity fixtures instead of re-deciding it during implementation.
