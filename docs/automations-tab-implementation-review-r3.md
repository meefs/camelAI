# Automations Tab Implementation Review R3

**Date:** 2026-05-28
**Scope:** third review of the current local diff in `automations-tab-plan`, with extra focus on previous-run history loading and pagination.

## Findings

### P1: Run history is destructively capped and not pageable

Your concern is valid. The current implementation avoids loading hundreds or thousands of run rows by deleting older history: every inserted run calls `trimAutomationRuns()` (`workers/main/src/workspace-cron.ts:608`), which keeps only the newest 20 rows per automation and permanently deletes the rest (`workers/main/src/workspace-cron.ts:611`). That means the page will not load thousands of prior runs today, but only because historical runs beyond 20 are lost.

That does not match the desired behavior of showing the latest runs by default while letting the user click "Show more" to fetch older runs in pages of 20. It also makes future audit/debug views impossible because the data is gone.

The listing RPC is also not ready for pagination if the destructive trim is removed. `listAutomationRuns()` reads every row in `automation_runs` and only applies `limitPerAutomation` in JavaScript after loading the full query result (`workers/main/src/workspace-cron.ts:1130`). If the trim is removed without changing this query, the loader will eventually scan/load all history for the workspace.

Recommended backend fix:

- Stop trimming to 20 in `trimAutomationRuns()`. If retention is needed, make it a much larger time/count policy, e.g. 90 days or 1,000 runs per automation, and document it as retention rather than UI pagination.
- Change the initial loader path so it does not load all history. Either:
  - fetch only the latest 5 or latest 20 per automation with a SQL-level limit/window query, or
  - do not fetch run history for every automation in the page loader; fetch runs only for the selected automation panel.
- Add a targeted paginated RPC, for example:

```ts
listAutomationRunsPage(
  workspaceId: string,
  input: {
    kind: "scheduled_prompt" | "deterministic_automation";
    automationId: string;
    limit?: number; // default 20, max 50
    cursor?: { startedAt: number; id: string } | null;
  },
): Promise<{ runs: AutomationRunRecord[]; nextCursor: { startedAt: number; id: string } | null }>
```

- Query with keyset pagination, not offset:

```sql
SELECT *
FROM automation_runs
WHERE kind = ?
  AND automation_id = ?
  AND (
    ? IS NULL
    OR started_at < ?
    OR (started_at = ? AND id < ?)
  )
ORDER BY started_at DESC, id DESC
LIMIT ?
```

- Keep the existing `idx_automation_runs_lookup` index but include `id` in the order/index if needed for stable cursor pagination.

Recommended UI fix:

- In the panel, show the first page of previous runs and a `Show more` button below the list when `nextCursor` is present.
- Use `useFetcher` to load the next page for the selected automation only.
- Append returned runs to the selected automation's local `recent_runs`, deduping by `run.id`.
- Reset the loaded pages when the selected automation changes.

## Resolved From R2

- The stale `fetcher.data` replay issue appears fixed: the action-data effect now returns early when `pendingAction.current` is absent and no longer depends on `selectedId`.
- Failed `Run now` dispatches now return a structured failure with the updated automation instead of always showing a success toast.

---

## UI Review R3 — implemented (2026-05-28, updated)

> This replaces the earlier "target design" notes in this section, which were written while the workspace's read tools were serving stale data. Two claims from that pass were **wrong** and are corrected here: the runs endpoint did **not** already exist (it is created below), and there is **no** `automation-panel.tsx.orig` file in the tree.

The capped/paginated "Previous runs" feature is now implemented end-to-end and on-theme — not just specced. This is the implementation of Findings P1 above. Here is what shipped and why, so the backend pass can reconcile rather than rebuild.

### Architecture: the panel fetches its own runs; the loader no longer fans out history

The earlier note proposed clamping `recent_runs` in the page loader and threading a `runs_cursor` onto every `AutomationListItem`. I did **not** do that, because it doesn't scale: the old `listAutomationRuns` reads *every* run row for the workspace and buckets in JS, so once retention grows past a handful, the page loader (and every 10s poll) scans the whole table just to fill a panel that shows one automation.

Instead:

- **`recent_runs` is removed from `AutomationListItem` and the loader** (`src/lib/automations-shared.ts`, `src/lib/automations.server.ts`). `buildAutomationsPageData` no longer calls `listAutomationRuns` — list rows never showed runs anyway.
- **Run history is panel-only and paginated**, fetched per-automation from a new endpoint via `useFetcher`. Each query is a keyset lookup on the existing `idx_automation_runs_lookup` index, so it stays cheap regardless of retention.

### Backend (`workers/main/src/workspace-cron.ts`)

- **Retention raised off the destructive 20.** `trimAutomationRuns` now keeps `AUTOMATION_RUN_RETENTION = 1000` rows per automation (constant near the top of the file) instead of 20. This is the one product knob worth confirming — swap to a time-based policy if you prefer; the UI works with any bound. (Findings P1 "stop trimming to 20" — done.)
- **New `listAutomationRunsPage(workspaceId, { kind, automationId, limit, cursor })` → `{ runs, nextCursor }`.** Keyset pagination ordered by `(started_at DESC, id DESC)`, fetching `limit + 1` to detect the next page. `limit` defaults to 20, clamped to 50. `kind` is the DO kind (`scheduled_prompt` | `deterministic_automation`). This matches the RPC sketched in Findings P1; `listAutomationRuns` is kept (still used by tests).
- `AutomationRunCursor = { startedAt: number; id: string }` is exported for the helper/test layer.

### Wire contract

- **Endpoint:** `GET /api/automations/:id/runs?kind=<agent_task|workflow>&cursor=<opaque>&limit=<n>` → `src/routes/api/automations.$id.runs.ts` (registered in `src/routes.ts`). Read-only; gated by `requireSessionWorkspaceAccess` with no write requirement — viewing history isn't a mutation, and the panel's mutating controls still gate on `can_manage`.
- **Response** (`AutomationRunsPage` in `automations-shared.ts`): `{ id, kind, fromCursor, runs: AutomationRunSummary[], cursor: string | null }`. `id`/`kind` echo the request so the client discards responses for an automation it already navigated away from; `fromCursor` distinguishes a first page (replace) from a "Show older runs" page (append); `cursor` is the next-page token (`null` = end of history).
- **Cursor format:** opaque string `"<startedAt>:<id>"`, encoded/decoded in `automations.server.ts` (`encodeRunsCursor` / `decodeRunsCursor`). The DO RPC stays typed with the object form.

### UI — on-theme (`automation-panel.tsx`, `automations-client.tsx`)

- **Pagination state is lifted to `AutomationsClient`,** not kept in `AutomationPanel`. Reason: below `lg` the desktop `<aside>` panel stays mounted (just `hidden`) while the `Sheet` panel also mounts, so panel-local fetching would fire two identical requests. One `runsFetcher` + client state feeds both panel instances. It resets when `selectedRunsKey` (`${kind}:${id}`) changes — keyed on the stable string so the poll / optimistic updates don't refire the fetch.
- **First-page load shows a skeleton** (`PreviousRunsSkeleton`, four shimmer rows) during the panel slide — no flash of "No previous runs" or the prior automation's list.
- **"Show older runs"** is the quiet full-width ghost `text-xs` muted button from the earlier note, kept verbatim: in-place `Loader2` spinner while loading, button stays mounted + `disabled` so nothing reflows, rendered only while `cursor != null` (no dead "No more runs" button). Appends with dedupe by `run.id`.
- **Errors fail loud:** `toast.error` on a failed page fetch, existing rows left intact, button re-enabled (AGENTS.md "fail loudly").
- **The "N of M" count was intentionally not added.** A truthful total needs `run_count` plumbed through the panel, and it would drift from the loaded list the moment a new run lands mid-session. "Show older runs" already communicates "there's more." Add it later only if product asks.

### For the backend pass to own / verify

- Confirm `AUTOMATION_RUN_RETENTION = 1000` is the retention you want (or convert to time-based). It's the only value here that's a product decision rather than a mechanical one.
- If in-flight backend work added a differently-named paginated RPC or cursor shape, converge on `listAutomationRunsPage` / `AutomationRunCursor` above rather than adding a second one.
- Run history is not live-refreshed while the panel is open (a run started via "Run now" shows on next open/reselect). The status dot + "Last ran" already reflect live state via the loader poll; live history was left out to avoid fighting the user's pagination/scroll.

---

## Verification Run

- `bun run typecheck` passed (exit 0).
- `bun run test:workers -- workspace-cron.test.ts` passed — 3 tests, including the new `keyset-paginates run history beyond the legacy 20-row cap` case.

