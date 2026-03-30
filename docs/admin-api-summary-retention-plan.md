# Plan: Implement `/dashboard/summary` and `/dashboard/retention` Endpoints

## Objective

Replace the `501` stubs at `GET /api/admin/dashboard/summary` and `GET /api/admin/dashboard/retention` with working endpoints that compute the same numbers the dashboard currently computes client-side. The authoritative formulas are now available in `FORMULAS-SPEC.md` (attached below as inline reference).

## Context

- Phases 1–3 of the admin metrics plan are already shipped. See `docs/admin-api-metrics-plan.md`.
- The `501` stubs, analytics read model, shared filtering helpers (`metrics.ts`), and `AdminIndexDO` query methods are all in place.
- The new endpoints must produce **exact numeric parity** with the current dashboard JS formulas. No formula should be invented or approximated.

## Key Source Files

| File | What it contains |
|---|---|
| `workers/main/src/routes/admin/routes.ts` | Current `501` stubs at `/dashboard/summary` and `/dashboard/retention` |
| `workers/main/src/routes/admin/schemas.ts` | Zod schemas for all admin API responses |
| `workers/main/src/routes/admin/metrics.ts` | Shared helpers: `fetchSpamOrgIds`, `normalizeInternalDomains`, `isOrgExcludedByInternalDomains`, `normalizeBillingStatus`, `fetchOrgUsageAnalytics` |
| `workers/main/src/admin-index-do.ts` | `AdminIndexDO` with `getOverview`, `getUsersPaginated`, `getThreadsPaginated`, `getAppsPaginated`, `getOrgsPaginated`, `getOrgDirectoryRows`, etc. |
| `services/sandbox-host/internal/state/usage_store.go` | Centralized analytics SQLite store with `usage_events`, `org_usage_rollups`, `org_effective_limits` |

## Architecture Decision

These computations require iterating over full entity lists (all users, all threads, all apps within the last 30 days) and doing cross-entity joins (activity maps, cohort bucketing). Two implementation approaches are possible:

**Option A: Compute in the Worker (AdminIndexDO).** AdminIndexDO already has all entity data in SQLite. Add new query methods that compute daily buckets, activity maps, and aggregations directly in SQL or in-memory JS within the DO.

**Option B: Add new sandbox-host analytics endpoints.** Build the computations in Go against the centralized analytics store, expose them as sandbox-host routes, and proxy from the Worker.

**Use Option A.** The formulas operate on entity data (users, threads, apps, orgs) which lives in AdminIndexDO, not in the sandbox-host usage store. The usage store only has spend/cost data. All the retention and dashboard summary computations are over entity creation timestamps and membership — data that AdminIndexDO already owns. The only usage-store data needed is for the `billing_breakdown` (which uses org `billing_status` already in AdminIndexDO) and the retention snapshot (which uses entity timestamps only).

## Formulas Reference

The exact formulas are defined in the attached `FORMULAS-SPEC.md`. The sections relevant to this plan are:

- **Section 2**: Exclusion rules (internal users, spam detection)
- **Section 3**: Retention formulas (`computeRetentionData`) — cohort table, retention curve, WAU time series, stickiness, KPIs
- **Section 4**: Dashboard summary formulas (`computeDashboardData`) — daily buckets, active user classification, rolling averages, growth thresholds, weekly projections, selected-day drill-down

The coding agent must implement these formulas exactly as specified, paying particular attention to:

- All timestamps are UTC millisecond epoch
- Week start is Monday (UTC)
- The specific rounding rules per metric (see Section 8 of the spec)
- Day-0 retention = active on signup day; Day-N (N>0) = active between day 1 and day N
- Growth thresholds exclude today's data
- Weekly projections use day-of-week averages excluding the current week
- `day30Retention` uses the day-28 milestone, not day 30

## Endpoint 1: `GET /api/admin/dashboard/summary`

### Query Params

| Param | Default | Description |
|---|---|---|
| `date` | today (UTC `YYYY-MM-DD`) | Selected day for drill-down metrics |
| `exclude_spam` | `true` (implicit — applied when not `false`) | Exclude spam orgs and their creators |
| `exclude_internal_domains` | `camelai.com` | Comma-separated domains to exclude by email |

### Response Shape

```json
{
  "kpis": {
    "total_users": 609,
    "total_orgs": 658,
    "total_threads": 12345,
    "total_apps": 456,
    "total_workspaces": 789
  },
  "daily_series": [
    {
      "date": "2026-03-01",
      "new_users": 5,
      "new_threads": 42,
      "new_apps": 3,
      "returning_users": 12,
      "new_active_users": 4,
      "rolling_avg_signups": 4.7
    }
  ],
  "weekly_series": [
    {
      "week_start": "2026-03-17",
      "label": "Week of Mar 17",
      "new_users": 23,
      "returning_users": 45,
      "projected_new_users": 0,
      "projected_returning_users": 0
    }
  ],
  "growth_thresholds": {
    "signups": { "flat": 4.2, "linear": 5.1, "exponential": 7.5, "show_exponential": true },
    "returning": { "flat": 10.3, "linear": 11.2, "exponential": 15.0, "show_exponential": false },
    "total_active": { "flat": 14.5, "linear": 16.3, "exponential": 22.5, "show_exponential": true }
  },
  "selected_day": {
    "date": "2026-03-28",
    "new_users": 5,
    "new_threads": 42,
    "new_apps": 3,
    "new_orgs": 1,
    "top_users_by_threads": [
      { "id": "...", "name": "...", "email": "...", "avatar": { "color": "...", "content": "..." }, "thread_count": 8 }
    ],
    "top_orgs_by_activity": [
      { "name": "...", "thread_count": 15 }
    ],
    "latest_threads": [],
    "latest_apps": [],
    "latest_orgs": [],
    "recent_users": []
  },
  "billing_breakdown": [
    { "status": "active", "count": 50 },
    { "status": "free", "count": 580 }
  ],
  "app_visibility": { "public": 120, "private": 336 },
  "retention_snapshot": {
    "rate_pct": 22,
    "cohort_size": 400,
    "retained_count": 88
  }
}
```

### Implementation Steps

1. **Add a new method to AdminIndexDO** — `computeDashboardSummary(options)` that:
   - Loads all users, threads (last 30 days), apps (last 30 days), orgs from its local SQLite
   - Applies exclusion filters (internal domains, spam org IDs passed as input)
   - Computes all subsections per the formulas spec

2. **Replace the `501` stub** in `routes.ts` with a handler that:
   - Parses query params (`date`, `exclude_spam`, `exclude_internal_domains`)
   - Resolves spam org IDs via `fetchSpamOrgIds(env)` if `exclude_spam !== false`
   - Calls `adminIndex.computeDashboardSummary({ spamOrgIds, internalDomains, selectedDate })`
   - Returns the response

3. **Add Zod schemas** in `schemas.ts` for the response shape: `DashboardSummaryResponseSchema`.

### Formula Mapping

Each response field maps to a specific formula section:

| Field | Formula Spec Section |
|---|---|
| `kpis` | Filtered counts of each entity type |
| `daily_series` | Section 4a (daily buckets) + 4b (active user classification) + 4c (rolling average) |
| `weekly_series` | Section 4e (weekly projections) |
| `growth_thresholds` | Section 4d (growth thresholds) |
| `selected_day` | Section 4g (selected day metrics) |
| `billing_breakdown` | Section 4g — group all filtered orgs by `billing_status`, normalize `paying` → `active` |
| `app_visibility` | Count filtered apps by `is_public` |
| `retention_snapshot` | Section 4f (7-day retention for summary card) |

### Critical Formula Details

- **`returning_users`** (Section 4b): A user is "returning" on a day if their `created_at` date is strictly before that day AND they created a thread or app on that day.
- **`new_active_users`** (Section 4b): A user is "new active" on a day if their `created_at` date equals that day AND they created a thread or app on that day.
- **`rolling_avg_signups`** (Section 4c): 7-day trailing window average of new user counts. Round to 1 decimal place.
- **Growth thresholds** (Section 4d): Exclude today from the input series. Flat = mean of last 7 values. Linear = last value + mean slope over last 7. Exponential = max(linear, yesterday × 1.5). Include `show_exponential` flag.
- **Weekly projections** (Section 4e): Monday-start weeks. `dow = (Date.getUTCDay() + 6) % 7`. Compute day-of-week averages excluding current week. Project missing days for current week only.
- **Retention snapshot** (Section 4f): 7-day retention. Eligible = users where `(now - created_at) >= 7 days`. Retained = any activity on days 1–7 after signup. Integer percentage.
- **`billing_breakdown`** normalization: `paying` → `active` (use `normalizeBillingStatus` from `metrics.ts`).

### Drill-Down Array Limits

- `top_users_by_threads`: 10
- `top_orgs_by_activity`: 10
- `latest_threads`: 10
- `latest_apps`: 10
- `latest_orgs`: 10
- `recent_users`: 10

## Endpoint 2: `GET /api/admin/dashboard/retention`

### Query Params

| Param | Default | Description |
|---|---|---|
| `exclude_spam` | `true` (implicit) | Exclude spam orgs and their creators |
| `exclude_internal_domains` | `camelai.com` | Comma-separated domains to exclude by email |

### Response Shape

```json
{
  "cohort_table": [
    {
      "cohort_label": "Mar 17",
      "cohort_start_date": "2026-03-17",
      "cohort_size": 25,
      "weeks": [
        { "pct": 100, "count": 25 },
        { "pct": 44, "count": 11 },
        null
      ]
    }
  ],
  "max_week_columns": 8,
  "retention_curve": [
    { "day": 0, "retention_pct": 100, "users_eligible": 500 },
    { "day": 1, "retention_pct": 35, "users_eligible": 480 },
    { "day": 3, "retention_pct": 28, "users_eligible": 450 },
    { "day": 7, "retention_pct": 22, "users_eligible": 400 },
    { "day": 14, "retention_pct": 18, "users_eligible": 350 },
    { "day": 21, "retention_pct": 15, "users_eligible": 300 },
    { "day": 28, "retention_pct": 12, "users_eligible": 250 }
  ],
  "wau_time_series": [
    {
      "week_label": "Mar 17",
      "week_start": "2026-03-17",
      "wau": 89,
      "new_users": 23,
      "returning_users": 66
    }
  ],
  "stickiness_series": [
    {
      "date": "2026-03-28",
      "label": "Mar 28",
      "dau_wau_ratio": 0.32,
      "dau": 28,
      "wau": 89
    }
  ],
  "kpis": {
    "day1_retention": 35,
    "day7_retention": 22,
    "day14_retention": 18,
    "day30_retention": 12,
    "current_wau": 89,
    "previous_wau": 82,
    "wau_growth_pct": 8,
    "avg_stickiness": 0.31
  }
}
```

### Implementation Steps

1. **Add a new method to AdminIndexDO** — `computeRetentionData(options)` that:
   - Loads all users, threads, apps from its local SQLite
   - Applies exclusion filters
   - Builds the activity-by-date map (Section 3a)
   - Computes all subsections per the formulas spec

2. **Replace the `501` stub** in `routes.ts` with a handler that:
   - Parses query params (`exclude_spam`, `exclude_internal_domains`)
   - Resolves spam org IDs via `fetchSpamOrgIds(env)` if `exclude_spam !== false`
   - Calls `adminIndex.computeRetentionData({ spamOrgIds, internalDomains })`
   - Returns the response

3. **Add Zod schemas** in `schemas.ts` for the response shape: `DashboardRetentionResponseSchema`.

### Formula Mapping

| Field | Formula Spec Section |
|---|---|
| `cohort_table` | Section 3b (cohort retention table) |
| `max_week_columns` | Section 3b — `min(8, floor((now - earliest_cohort_start) / WEEK_MS))` |
| `retention_curve` | Section 3c (aggregated retention curve) |
| `wau_time_series` | Section 3d (WAU time series, 30-day window) |
| `stickiness_series` | Section 3e (DAU/WAU ratio, last 30 days) |
| `kpis` | Section 3f (retention KPIs) |

### Critical Formula Details

- **Activity map** (Section 3a): `Map<date_string, Set<user_id>>` built from threads + apps by `formatDate(created_at)`. Activity attribution is by `created_by`.
- **Cohort weeks** (Section 3b): Monday-start. Sunday subtracts 6 days, other days subtract `(day_of_week - 1)` days. Take last 10 cohort weeks.
- **Week column `w=0`** (Section 3b): Always computed even if incomplete (current week). Columns `w>0` are null if the week ends in the future.
- **Retention curve milestones** (Section 3c): `[0, 1, 3, 7, 14, 21, 28]` days. Day-0 = active on signup day. Day-N (N>0) = active between day 1 and day N (exclusive of signup day).
- **WAU** (Section 3d): 30-day window from `weekStartMonday(now - 30 days)`. New = created_at within week. Returning = created_at before week start.
- **Stickiness** (Section 3e): DAU = activity set size for that day. WAU = union of 7 days ending on that day (inclusive). Ratio rounded to 2 decimal places.
- **`day30_retention`** (Section 3f): Uses the day-28 milestone from the retention curve, not day 30.
- **`avg_stickiness`** (Section 3f): Mean of the last 28 stickiness entries' `dau_wau_ratio`.
- **`wau_growth_pct`** (Section 3f): `round(((current - previous) / previous) * 100)` — integer percentage.

## Data Loading Strategy

Both endpoints need the same base data. To keep AdminIndexDO clean:

1. Add a private helper `loadFilteredEntitySnapshot(options)` that:
   - Queries all users from `users` table
   - Queries threads from `threads` table (optionally filtered to last N days for summary)
   - Queries apps from `apps` table (optionally filtered to last N days for summary)
   - Queries orgs from `orgs` table
   - Applies internal-domain exclusion by email domain (filter users, then filter threads/apps by `created_by`)
   - Applies spam-org exclusion (filter orgs by ID set, filter threads/apps by `org_id`, filter users who only belong to spam orgs)
   - Returns `{ users, threads, apps, orgs }`

2. Both `computeDashboardSummary` and `computeRetentionData` call this helper, then run their specific formulas.

### Exclusion Details

The spec (Section 2) defines:
- **Internal**: exclude users whose email ends with `@camelai.com` (or whatever domains are configured). Then exclude all threads/apps whose `created_by` matches an excluded user.
- **Spam**: exclude orgs in the spam set. Exclude threads/apps whose `org_id` is a spam org. Exclude users whose `created_by` matches a spam org's creator.

The spam org IDs are resolved externally (via `fetchSpamOrgIds` in the route handler) and passed into AdminIndexDO as a parameter. AdminIndexDO does not call sandbox-host.

## Testing

### Parity Fixtures

Build at least 3 frozen test fixtures:

1. **Small dataset** (5 users, 20 threads, 5 apps, 3 orgs) — verify every field in both responses
2. **Edge cases**: user with zero activity, cohort with zero retention, day with zero signups, current week partial projection
3. **Exclusion**: fixture with internal + spam users mixed in, verify they're excluded correctly

Each fixture should define:
- Input entity arrays
- Expected `/dashboard/summary` response
- Expected `/dashboard/retention` response

### Specific Formula Tests

Write focused unit tests for:
- `computeGrowthThresholds` with known input series → verify flat/linear/exponential/show_exponential
- `wasActiveInRange` with edge cases (activity on boundary days)
- Weekly projection with partial current week
- Retention curve day-0 vs day-N semantics
- Stickiness rounding (2 decimal places)
- Cohort week boundary (Sunday edge case for Monday-start weeks)

### Integration Tests

Add tests to `workers/main/tests/admin-api-metrics.test.ts` following the existing pattern:
- Seed users, orgs, threads, apps via test helpers
- Wait for AdminIndexDO to index them
- Call the endpoint
- Verify response shape and key values

## Performance Notes

- Both endpoints load entity data from AdminIndexDO's local SQLite. At current scale (~600 users, ~12k threads, ~500 apps), this should be fast.
- The activity map construction and cohort iteration are O(threads + apps + users × milestone_count). This is fine for current scale.
- If scale grows significantly, the activity map can be pre-materialized as a `user_daily_activity` rollup table in AdminIndexDO (same pattern as the usage analytics store). Do not add this complexity now.
- The summary endpoint should avoid loading more than 30 days of threads/apps for the daily series. Use SQL `WHERE created_at >= ?` to limit the scan. However, the retention endpoint needs all threads/apps for the full activity map (cohort analysis spans the user's entire lifetime).

## Delivery Order

1. Add the `loadFilteredEntitySnapshot` helper to AdminIndexDO
2. Implement `computeRetentionData` — this is the more complex endpoint and validates the activity map infrastructure
3. Implement `computeDashboardSummary` — reuses the activity map and adds the time-series/threshold formulas
4. Add Zod schemas for both response shapes
5. Replace both `501` stubs in `routes.ts`
6. Add parity fixture tests
7. Update `docs/admin-api-reference.md` and `docs/admin-api-migration-guide.md` to reflect the live endpoints

## Formulas Spec (Inline Reference)

The coding agent should treat the formulas below as the authoritative specification. Do not deviate from them.

---

### Exclusion Rules (Spec Section 2)

- `isInternal(email)` = email ends with `@camelai.com` (or configured domains)
- `isSpam(org)` = org where all effective usage windows have `limit_usd <= 0.01`
- When filtering: exclude internal users and their threads/apps. Exclude spam orgs and threads/apps belonging to spam orgs. Exclude users who are creators of spam orgs.

### Retention Formulas (Spec Section 3)

**Constants**: `DAY_MS = 86_400_000`, `WEEK_MS = 7 * DAY_MS`

**Activity Map**: `Map<date_string, Set<user_id>>` from threads + apps by `formatDate(created_at)` and `created_by`.

**`wasActiveInRange(userId, startMs, endMs)`**: Iterate each UTC day in [start, end], return true if any day's activity set contains userId.

**Cohort Table** (3b):
- Group users by Monday-start week of `created_at`
- Week start: Sunday → subtract 6 days, else subtract `(day_of_week - 1)` days (UTC)
- Take last 10 cohort weeks
- `maxWeekColumns = min(8, floor((now - earliest_cohort_start) / WEEK_MS))`
- For each cohort × column `w`: `weekStartMs = cohortStartMs + w * WEEK_MS`, `weekEndMs = weekStartMs + WEEK_MS - 1`
  - If `weekStartMs > now` → null
  - If `weekEndMs > now AND w > 0` → null
  - Else: count users in cohort active in range, `pct = round((count / cohortSize) * 100)` (integer)

**Retention Curve** (3c):
- Milestones: `[0, 1, 3, 7, 14, 21, 28]`
- `eligible` = users where `(now - created_at) >= day * DAY_MS`
- Day 0: `retained` = eligible active in `[created_at, created_at + DAY_MS - 1]`
- Day N>0: `retained` = eligible active in `[created_at + DAY_MS, created_at + day * DAY_MS]`
- `retentionPct = round((retained / eligible) * 100)` (integer)

**WAU Time Series** (3d):
- Weekly buckets from `weekStartMonday(now - 30 * DAY_MS)` through current week
- `wau` = distinct active users in week
- `newUsers` = active users whose `created_at` is within week boundaries
- `returningUsers = wau - newUsers`

**Stickiness** (3e):
- Last 30 days
- `dau` = activity set size for that day (0 if no entry)
- `wau` = union of activity sets for 7 days ending on that day (inclusive)
- `dauWauRatio = wau > 0 ? round(dau / wau * 100) / 100 : 0` (2 decimal places)

**Retention KPIs** (3f):
- `day1/7/14Retention` from retention curve milestones
- `day30Retention` = day-28 milestone (not day 30)
- `currentWau` = last WAU entry, `previousWau` = second-to-last
- `wauGrowthPct = round(((current - previous) / previous) * 100)` (integer)
- `avgStickiness` = mean of last 28 stickiness `dauWauRatio` values

### Dashboard Summary Formulas (Spec Section 4)

**Daily Buckets** (4a): Count users/threads/apps by `formatDate(created_at)` for last 30 days.

**Active User Classification** (4b):
- `returning_users` on day D: user's signup date < D AND user created a thread/app on D
- `new_active_users` on day D: user's signup date == D AND user created a thread/app on D

**Rolling Average** (4c): For each day at index `i`: `window = data[max(0, i-6)..i]`, `avg = round(sum(window.users) / window.length, 1)` (1 decimal place)

**Growth Thresholds** (4d): Exclude today from series.
- Flat: `max(0, mean(last 7 values))`, round to 1 decimal
- Linear: `max(0, last_value + mean_slope_over_last_7)`, round to 1 decimal
- Exponential: `max(linear, max(0, yesterday * 1.5))`, round to 1 decimal
- `show_exponential`: `exponential > 0 AND today >= exponential * 0.6`
- Applied to 3 series: signups, returning, total_active (returning + new_active)

**Weekly Projections** (4e):
- `dow = (Date.getUTCDay() + 6) % 7` (Monday=0, Sunday=6)
- Compute day-of-week averages for signups and returning users, excluding current week
- Aggregate into Monday-start weekly buckets
- Current week: project missing days using day-of-week averages

**Retention Snapshot** (4f):
- Eligible: users where `(now - created_at) >= 7 * DAY_MS`
- Retained: any activity on days 1–7 after signup
- `rate_pct = round((retained / eligible) * 100)` (integer)

**Selected Day** (4g): UTC day boundaries `T00:00:00Z` to `T23:59:59.999Z`. Top 10 users by thread count, top 10 orgs by thread count.

**Billing Breakdown** (4g): All filtered orgs grouped by `billing_status`, normalize `paying` → `active`.

### Precision & Rounding (Spec Section 8)

| Metric | Precision |
|---|---|
| Retention percentages | Integer |
| DAU/WAU ratio (stickiness) | 2 decimal places |
| Rolling average (signups) | 1 decimal place |
| Growth thresholds | 1 decimal place |
| WAU growth % | Integer |
