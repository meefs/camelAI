# Summary & Retention Endpoints Implementation Review

Review of the implementation that replaces the `501` stubs with working `GET /api/admin/dashboard/summary` and `GET /api/admin/dashboard/retention`.

## Overall Assessment

This is a clean, well-structured implementation. The formulas module (`admin-dashboard-metrics.ts`) is separated from the DO and route layers, making it independently testable. The formula implementations closely follow the spec. All 11 tests pass (4 unit + 7 integration). No blocking issues.

---

## High: `loadAllThreadsForDashboardMetrics` loads entire thread history

`AdminIndexDO.loadAllThreadsForDashboardMetrics()` does a full `SELECT ... FROM threads` with no time filter. For the summary endpoint, only the last 30 days of threads are needed for daily series and activity classification. However, the retention endpoint needs the full history for the activity map (cohort analysis spans each user's entire lifetime).

Since both endpoints share `loadFilteredEntitySnapshot`, the implementation takes the simpler path of always loading everything. At ~12k threads this is fine, but as the thread table grows, the summary endpoint will load increasingly unnecessary data.

**Recommendation:** Not urgent at current scale. When thread count reaches ~100k, consider either splitting `loadFilteredEntitySnapshot` to accept a `minCreatedAt` parameter, or adding a SQL `WHERE created_at >= ?` for the summary path while keeping the full scan for retention.

---

## Medium: `totalWorkspaces` is derived from org `workspace_count` sums, not the workspaces table

In `filterDashboardEntitySnapshot`:

```typescript
totalWorkspaces: orgs.reduce((sum, org) => sum + Math.max(0, org.workspace_count ?? 0), 0),
```

This sums `workspace_count` from the filtered orgs rather than counting actual workspace rows. The `workspace_count` on orgs is a denormalized counter maintained by events. If that counter is ever stale (e.g., a workspace is deleted but the counter isn't decremented), the KPI will be wrong.

This is consistent with how `getOverview` works (it counts workspace rows directly), but the summary endpoint diverges by using the org counter instead.

**Recommendation:** Consider querying the workspaces table directly for the workspace count, or accept this as a known approximation and add a comment.

---

## Medium: Growth thresholds use `yesterday` from slightly different position than spec

The spec says:
```python
yesterday = series[-2]
exponential = max(linear, max(0, yesterday * 1.5))
```

The implementation uses:
```typescript
const exponentialRaw = Math.max(linearRaw, Math.max(0, (window.at(-1) ?? 0) * 1.5));
```

Here `window.at(-1)` is the last element of `history.slice(-7)` (i.e., the last element of the pre-today history), which is correct — that IS yesterday. But the spec names it `series[-2]` (second-to-last of the full series including today). These are the same value, so there's no bug, but the variable naming difference from the spec could cause confusion during future maintenance.

**Recommendation:** Add a brief comment: `// window.at(-1) == yesterday (series[-2] in the spec)`.

---

## Low: Retention snapshot and retention curve use the same `computeRetentionPoint`

Good shared abstraction — `computeRetentionPoint` is used both for the summary card's 7-day retention snapshot and for each milestone in the retention curve. This ensures the semantics are identical, which is exactly what the spec requires.

---

## Low: `selected_day.latest_orgs` doesn't normalize `billing_status`

The summary endpoint's `selected_day.latest_orgs` passes through `org.billing_status` as-is (could be `paying`), while `billing_breakdown` normalizes it to `active`/`free`. The Zod schema for `latest_orgs` uses `OrgSchema` which has `billing_status` as a plain string, so there's no validation mismatch, but the dashboard consumer will see different naming conventions in the same response.

**Recommendation:** Either normalize `billing_status` in `latest_orgs` or document that it uses the raw value.

---

## Low: `loadFilteredEntitySnapshot` wraps sync calls in `Promise.resolve`

```typescript
const [users, threads, apps, orgs] = await Promise.all([
  Promise.resolve(this.loadAllUsersForDashboardMetrics()),
  Promise.resolve(this.loadAllThreadsForDashboardMetrics()),
  Promise.resolve(this.loadAllAppsForDashboardMetrics()),
  this.getOrgDirectoryRows(),
]);
```

The first three are synchronous SQLite calls wrapped in `Promise.resolve`. This doesn't hurt correctness but doesn't actually parallelize anything — DO SQLite calls are already synchronous within the isolate. The `Promise.all` wrapper adds minor overhead for no concurrency benefit.

**Recommendation:** Cosmetic only. Could simplify to sequential calls, but not worth changing.

---

## Positive Notes

- The formula implementations are clean and match the spec closely. Key semantics are correct:
  - Day-0 retention = active on signup day, Day-N = active between day 1 and day N
  - `day30_retention` correctly uses the day-28 milestone
  - Monday-start weeks with the correct Sunday edge case (`(day + 6) % 7`)
  - Growth thresholds correctly exclude today from the input series
  - Stickiness uses 2 decimal places, retention uses integers
  - Weekly projections correctly exclude current week from day-of-week averages

- Test coverage is solid: unit tests for individual formula functions + integration tests that seed AdminIndexDO and verify end-to-end response shapes.

- Good separation of concerns: `admin-dashboard-metrics.ts` is a pure computation module with no DO or Worker dependencies, making it easy to test and reason about.

- The `now` parameter on options allows deterministic testing, which the unit tests use effectively.
