# Admin API Metrics Implementation Review

Review of the Phase 2 implementation diff against `main`.

## Overall Assessment

The implementation is solid and well-structured. It correctly delivers the four unblocked Phase 2 endpoints (`spam/org-ids`, `orgs` filters, `orgs/:id` unchanged, `dashboard/top-orgs`), stubs the Phase 3 endpoints as `501`, builds a centralized analytics SQLite store on the Go side, and keeps the shared filtering helpers in a clean `metrics.ts` module. The code is readable and the test coverage for the Go layer is good.

There are no blocking issues. The items below are ranked by severity.

---

## Critical: Analytics write failure blocks the usage hot path

In `usage_store.go:326-331`, `RecordUsage` now returns an error if `recordAnalyticsUsage` fails — **after** the per-org transaction has already committed:

```go
if err := tx.Commit(); err != nil {
    return err
}
if err := u.recordAnalyticsUsage(record, now); err != nil {
    return fmt.Errorf("update usage analytics: %w", err)
}
```

This means a transient analytics DB problem (disk full, WAL checkpoint stall, corruption) will cause `RecordUsage` to return an error to the caller, which will likely surface as a failed usage tracking call for the user's chat turn. The per-org write succeeded, but the caller doesn't know that.

The analytics store is a secondary read model — it should not be able to take down the primary write path.

**Recommendation:** Log the analytics error and continue instead of returning it. Same applies to `SetSpendLimits` at line 430 where `replaceAnalyticsEffectiveLimits` failure also propagates.

---

## Critical: Full rebuild runs on every startup

`rebuildAnalyticsIndex()` is called unconditionally inside `NewUsageStore()`. It truncates all three analytics tables and re-reads every org's usage log from disk:

```go
for _, stmt := range []string{
    `DELETE FROM org_usage_rollups`,
    `DELETE FROM usage_events`,
    `DELETE FROM org_effective_limits`,
} { ... }

orgIDs, err := u.listOrgIDsOnDisk()
for _, orgID := range orgIDs {
    // reads entire usage_log from each org's SQLite
}
```

At current scale (~658 orgs), this scans every row in every org's `usage_log` table on every process restart. As usage data grows, this will make startup progressively slower and risk exceeding the 60-second context timeout. It also means a sandbox-host restart briefly has an empty analytics store (between the DELETE and the rebuild completing), so any concurrent analytics query during that window returns zeros.

**Recommendation:** Either:
1. Skip the rebuild if the analytics DB already has data and use a version/watermark to detect staleness, or
2. Move the rebuild to a background goroutine and serve from stale data until it completes, or
3. At minimum, wrap the truncate + rebuild in a single transaction that only swaps atomically on commit (which it already does via `tx.Commit()` — but concurrent readers outside the tx will see the empty state depending on SQLite isolation; confirm WAL read behavior here).

Actually, on re-read, the rebuild does use a single transaction, so WAL-mode readers should see the pre-truncate state until the commit. This mitigates the empty-window concern for concurrent reads. The startup latency concern remains and will grow with data volume.

---

## High: `GET /orgs` loads all orgs into Worker memory

The new `/orgs` handler calls `getOrgDirectoryRows()` which does an unbounded `SELECT ... FROM orgs LEFT JOIN users` and returns every row to the Worker. Filtering, searching, sorting, and pagination all happen in JS:

```typescript
let orgs = await adminIndex.getOrgDirectoryRows();
// ... filter, search, sort in JS ...
const pagedOrgs = orgs.slice(offset, offset + limit);
```

The old implementation used `getOrgsPaginated()` which did all of this in SQL. At ~658 orgs this is fine, but it's a regression in the sense that the endpoint now scales with total org count rather than page size. If org count grows 10x, this will allocate a large array per request.

**Recommendation:** Either push the search/filter/sort back into a new SQL method on `AdminIndexDO` that accepts the new params (preferred), or accept this as a known tradeoff at current scale and add a comment noting the threshold where it should be revisited.

---

## Medium: `ListSpamOrgIDs` misses orgs with default limits

The spam query only checks `org_effective_limits`:

```sql
SELECT org_id FROM org_effective_limits
GROUP BY org_id
HAVING COUNT(*) > 0 AND MAX(limit_usd) <= 0.01
```

Orgs that have **never** had `SetSpendLimits` called won't have rows in `org_effective_limits` (they only get rows during rebuild or when limits are explicitly set). The plan defines spam as orgs where all effective windows have `limit_usd <= 0.01`, and the default limits are `$50/$200` — so missing orgs are correctly non-spam. But this means the analytics store's `org_effective_limits` table is only populated for orgs that existed at last startup (via rebuild) or had limits explicitly changed since. Any org created after the last restart that never had `SetSpendLimits` called will have no rows.

This is currently correct behavior (new orgs have default high limits = not spam), but it's fragile. If an admin later tries to query effective limits for a specific new org via the analytics store, they'll get nothing.

**Recommendation:** Add a comment documenting this invariant, or populate default limits on first `RecordUsage` for an org.

---

## Medium: `enrichOrgListItems` doesn't normalize billing status

The `/orgs` endpoint uses `enrichOrgListItems` which passes through `org.billing_status` as-is. The `/dashboard/top-orgs` endpoint uses `normalizeBillingStatus()` to map `paying -> active`. This means:
- `GET /api/admin/orgs` returns `billing_status: "paying"`
- `GET /api/admin/dashboard/top-orgs` returns `billing_status: "active"`

The plan says to normalize at the metrics API boundary. The `/orgs` endpoint is arguably not a "metrics" endpoint, so this may be intentional for backward compatibility. But if the dashboard consumes both endpoints, the inconsistency will be confusing.

**Recommendation:** Either normalize billing status in both places, or add a comment in `enrichOrgListItems` explaining why it's intentionally raw.

---

## Medium: Double-sorting in `GetOrgUsageAnalytics`

`GetOrgUsageAnalytics` copies and sorts the input org IDs:

```go
orderedOrgIDs := append([]string(nil), orgIDs...)
slices.Sort(orderedOrgIDs)
```

But the HTTP handler in `usage_routes.go` also deduplicates and sorts before calling:

```go
slices.Sort(orgIDs)
items, err := s.usage.GetOrgUsageAnalytics(orgIDs, body.IncludeWindows)
```

The store method then re-sorts internally. Minor inefficiency, no correctness issue.

More importantly, the final result assembly preserves the **caller's** original order:

```go
for _, orgID := range orgIDs { // original caller order
    if row := resultByOrg[orgID]; row != nil {
```

But `orgIDs` was already sorted by the HTTP handler, so the original order is lost. The Worker-side caller (`routes.ts`) passes org IDs from `pagedOrgs.map(org => org.id)` which is in page order. The sandbox-host handler re-sorts them before passing to the store. This means the response items come back in sorted-ID order, not in the page order the Worker expected.

In practice this doesn't matter because the Worker builds a `Map` from the response and looks up by ID. But if anyone ever relies on the response array order, it'll be wrong.

**Recommendation:** No action needed, but clean up the redundant sort if you touch this code again.

---

## Low: `analyticsMu` held during full read queries

`ListSpamOrgIDs` and `GetOrgUsageAnalytics` both hold `analyticsMu` for the entire duration of their queries. Since `recordAnalyticsUsage` also acquires `analyticsMu`, a slow analytics read will block usage recording. With SQLite WAL mode, concurrent reads and writes are generally safe without application-level locking.

**Recommendation:** Consider using a `sync.RWMutex` (read lock for queries, write lock for mutations) or removing the mutex entirely for reads if WAL mode provides sufficient isolation.

---

## Low: `PaginationQuerySchema` import removed but may still be needed

The diff removes `PaginationQuerySchema` from the routes.ts imports. It's still used indirectly via `OrgsQuerySchema.extend()` in schemas.ts, so there's no runtime issue. Just noting that if any future route in this file needs to reference `PaginationQuerySchema` directly, it'll need to be re-imported.

---

## Low: Missing test for `getOrgDirectoryRows`

The new `AdminIndexDO.getOrgDirectoryRows()` method has no test. The existing Worker test suite may cover it indirectly through integration tests, but a focused test verifying the JOIN behavior (especially the LEFT JOIN returning null creator fields for orgs whose creator was deleted) would be valuable.

---

## Low: `exclude_internal_domains` has no default on `/orgs`

On `/dashboard/top-orgs`, `exclude_internal_domains` defaults to `camelai.com` via `normalizeInternalDomains(exclude_internal_domains, ['camelai.com'])`. On `/orgs`, it's only applied when explicitly provided: `if (exclude_internal_domains) { ... }`. This is probably intentional (the plan says the `/orgs` endpoint is additive), but worth confirming.

---

## Nits

- `metrics.ts:90`: The domain cleanup `.replace(/\.+$/, '')` strips trailing dots from domain input. Unusual but harmless.
- The 501 stub endpoints are a nice touch — they make the API surface discoverable while clearly communicating what's blocked.
- Test coverage for `ListSpamOrgIDs` and `GetOrgUsageAnalytics` is good; the edge cases (unknown org returns zero row, one-window-above-threshold not spam) match the plan's suggested tests.
