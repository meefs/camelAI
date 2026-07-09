# Eval Dashboard Batches — Implementation Feedback (r1)

**Date:** 2026-07-09
**Reviewing:** the implementation of `docs/eval-dashboard-batches-plan.md` (current working tree vs `origin/main`).

Verified baseline: `tests/eval-reports-batches.test.ts` + `tests/eval-reports-ingest-prompt.test.ts` pass (9/9); `tsc` clean for both `workers/eval-reports/tsconfig.app.json` and `tsconfig.json`. The pipeline threading (suite/matrix batch minting, reporter flags, manifest kinds), worker ingest/validation, and all doc/skill updates conform to the plan — no changes requested there. The items below are three user-requested UX changes (R1, R2, R5), one rendering bug (R3), and two small robustness fixes (R4).

---

## R1 (required) — Back buttons must return to where you came from

**Problem:** both detail pages hardcode their back target. From a batch page (`/batches/:id`), clicking a member run and then "All runs" drops you on `/` instead of back on the batch you were reading.

- `workers/eval-reports/app/routes/run-detail.tsx:338-343` — `<Link to="/">All runs`
- `workers/eval-reports/app/routes/batch-detail.tsx:194-199` — `<Link to="/?view=batches">Runs list`

**Fix:** a shared history-aware back button. With `createBrowserRouter`, React Router stamps an index into `window.history.state.idx`; `idx > 0` means there is an in-app entry to go back to, so `navigate(-1)` is safe and lands on the exact page (including its query params) the user came from. Fresh loads / deep links (`idx === 0` or undefined) fall back to the static target.

New file `workers/eval-reports/app/components/back-button.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";

export function BackButton({ fallback }: { fallback: string }) {
	const navigate = useNavigate();
	function goBack() {
		const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
		if (idx > 0) navigate(-1);
		else navigate(fallback);
	}
	return (
		<Button variant="ghost" size="sm" className="-ml-2 mb-4" onClick={goBack}>
			<ArrowLeft />
			Back
		</Button>
	);
}
```

- Replace both hardcoded links with `<BackButton fallback="/" />` (run detail) and `<BackButton fallback="/?view=batches" />` (batch detail). Label is the word **Back** in both places — a static "All runs" label would now lie about the destination.
- **Invariant to preserve:** in-page state changes must keep using `setParams(..., { replace: true })` so `navigate(-1)` never steps through tab switches or filter keystrokes. This already holds (`run-detail.tsx:333`, `runs-list.tsx:212`) — don't regress it when touching these files.
- The run-detail "in {batch} →" chip and the batch column links stay as-is; they are the explicit *forward* affordances and complement history-back.

## R2 (required) — Peek: expandable member summary on the batches list

**Problem:** the batches view requires clicking into a batch to see which evals it contained. Add an expand toggle per row that reveals a compact per-eval summary inline, so a batch can be skimmed without leaving the list.

```
┌────┬─────────┬──────────────────────────────┬─────────┬───────┬──────────┬──────────┬──────────┐
│    │ Result  │ Batch                        │ Score   │ Evals │ Branch   │ Duration │ Finished │
├────┼─────────┼──────────────────────────────┼─────────┼───────┼──────────┼──────────┼──────────┤
│ ▸  │ ✓ 18/18 │ suite: all                   │  91%    │  18   │ main     │ 41m      │ 2h ago   │
│    │         │ sonnet                       │ 142/156 │       │ a1b2c3d  │          │ illiana  │
├────┼─────────┼──────────────────────────────┼─────────┼───────┼──────────┼──────────┼──────────┤
│ ▾  │ ◐ 14/18 │ suite: all                   │  78%    │  18   │ pi-v2    │ 1h 12m   │ 5h ago   │
│    │         │ sonnet                       │ 121/156 │       │ 99f0e1d  │          │ illiana  │
│ ┌──┴─────────┴──────────────────────────────┴─────────┴───────┴──────────┴──────────┴────────┐ │
│ │ ✗ notebook-deploy-live       [skill]  Live page smoke — preview URL returned…   41%    9m  │ │
│ │ ✗ browser-automation-live    [skill]  Agent session completed — session error…   —     3m  │ │
│ │ ✓ dashboard-fake-data-live   [skill]                                            92%    4m  │ │
│ │ ✓ warehouse-list-live        [unit]                                            100%    2m  │ │
│ │ …one line per member run, failed first…                                                    │ │
│ └────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────┴─────────────────────────────────────────────────────────────────────────────────────────┘
```

Spec (all in `workers/eval-reports/app/components/batches-table.tsx`):

- **State:** `const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())` — local component state, not URL params.
- **Toggle column:** new first `TableHead` (empty label, `w-8`) and per-row `TableCell`. Content: `Button variant="ghost" size="icon-sm"` with a `ChevronRight` icon that gets `cn("transition-transform", isOpen && "rotate-90")`; `aria-expanded={isOpen}`, `aria-label={isOpen ? "Hide evals in batch" : "Show evals in batch"}`; `onClick` must `event.stopPropagation()` before toggling so the row's navigate-to-batch click doesn't fire. Render the button only when `batch.total > 1` (a singleton peek would just duplicate the row); otherwise leave the cell empty.
- **Row click behavior is unchanged** (navigates to `/batches/:id`); only the chevron toggles the peek.
- **Peek row:** immediately after the batch's `TableRow`, when open, render
  `<TableRow className="hover:bg-transparent"><TableCell colSpan={8} className="bg-muted/30 p-0">…</TableCell></TableRow>`
  (colSpan is now 8 — count includes the new toggle column).
- **Peek content:** not a nested `Table` — a dense list: outer `div className="divide-y border-t"`; one row per member run, **failed runs first, then batch order**. Each row:
  `div className="flex min-w-0 cursor-pointer items-center gap-3 py-1.5 pr-4 pl-12 text-sm hover:bg-muted/50"` with `onClick={(e) => { e.stopPropagation(); navigate(\`/runs/${encodeURIComponent(run.runId)}\`); }}`, containing in order:
  1. Verdict icon (no badge, for density): `CircleCheck className="size-3.5 shrink-0 text-green-700 dark:text-green-400"` for `completed`, `CircleX className="size-3.5 shrink-0 text-red-600 dark:text-red-400"` otherwise.
  2. Eval name: `span className="max-w-72 truncate font-medium"` wrapped in the existing `EvalHoverCard` (import from `./eval-name-cell`) so the description/start-prompt hover works from the peek too.
  3. Kind: `<EvalKindBadge evalTarget={run.evalTarget} kind={run.kind} />` (import from `./eval-name-cell`) — the unit/skill distinction must be visible per row without hovering; the component already renders nothing for unknown kinds and `custom` for `custom-prompt-live`.
  4. When `batch.models.length > 1`: `run.model ?? "default model"` in `text-xs text-muted-foreground`.
  5. For failed runs: the first failed criterion, `failedCriteria(run)[0]` (import from `../lib/format`), rendered as `` `${label}${reason ? ` — ${reason}` : ""}` `` in `min-w-0 flex-1 truncate text-xs text-red-600 dark:text-red-400` with `title` set to the full text. For passed runs render `<span className="flex-1" />` so the right group stays aligned.
  6. Right group `className="ml-auto flex shrink-0 items-center gap-3 text-xs tabular-nums"`: score pct colored via `scoreClass(...)` (muted `—` when no scorecard), then `durationOf(run)` in `text-muted-foreground`.
- **Skeleton:** in `RunsListSkeleton` (`runs-list.tsx:102-107`), prepend a `"w-4"` to the batches-view widths array so the skeleton matches the new column count.

## R3 (bug) — ScrollArea max-height is on the wrong element; long prompts won't scroll

`EvalHoverCard` uses `<ScrollArea className="max-h-64">` (`eval-name-cell.tsx`) and `PromptSection` uses `<ScrollArea className="max-h-72 px-3 pb-3">` (`prompt-section.tsx`). The shared primitive puts `className` on the Radix **root** while the scrolling viewport is `size-full` (`src/components/ui/scroll-area.tsx`) — a percentage height against an auto-height parent, so the viewport never gets a real constraint: long prompts render clipped/overflowing instead of scrolling. The primitive exposes `viewportClassName` for exactly this case.

Fix both usages to constrain the viewport, e.g. in `eval-name-cell.tsx`:

```tsx
<ScrollArea viewportClassName="max-h-64">
```

and in `prompt-section.tsx` keep the spacing on the root but move the cap: `<ScrollArea className="px-3 pb-3" viewportClassName="max-h-72">`. Verify visually in local dev (`bun run dev:eval-reports`) with a run whose prompt exceeds the cap: the hover card and the expanded prompt section must scroll internally, not grow or clip.

## R4 (minor robustness, small diffs in `app/lib/batches.ts`)

- **Batch label survives odd first members:** `label` reads `first?.batchLabel` (newest run only). A member re-reported by hand without `--batch-label` would strip the whole batch's label. Use `groupRuns.find((run) => run.batchLabel)?.batchLabel` as the primary source.
- **Rollup prompt shouldn't be masked by newer metadata-less runs:** `rollupByEval` picks one `metadataRun` for kind/description/startPrompt; a newest run carrying `kind` but no `startPrompt` hides an older captured prompt. Resolve each field independently: `kind: sorted.find((r) => r.kind)?.kind`, same pattern for `description` and `startPrompt`.
- Extend `tests/eval-reports-batches.test.ts` with one case per fix (labelless newest member keeps the batch label; rollup falls back to an older run's `startPrompt`).

## R5 (required) — Make the unit/skill distinction prominent: kind filter + kind badges

The kind distinction currently only surfaces as lowercase muted text under the eval name (Runs view) and a badge in the Evals view. Raise its visibility in three places:

**1. Kind filter on the Runs and Evals views** (`workers/eval-reports/app/routes/runs-list.tsx`). New `?kind=` search param, rendered as a `ToggleGroup` styled identically to the existing status filter (`type="single" variant="outline" size="sm"`), items **All / Unit / Skill** (values `all`, `unit`, `skill`; `updateParam("kind", value && value !== "all" ? value : "")` — same pattern as `?status=`).

- Placement: visible in **both** the Runs view and the Evals view. In Runs it sits between the status ToggleGroup and the eval `Select`; in Evals it is the only control next to the search box. Hidden in Batches view (batch rows already carry the `u`/`s` breakdown in the Evals column).
- Filtering: Runs view adds `if (kind && run.kind !== kind) return false;` to the `filteredRuns` predicate; Evals view adds `if (kind && rollup.kind !== kind) return false;` to `filteredEvals`. Runs without a stored kind (legacy runs, `custom-prompt-live`) match neither option and drop out while the filter is active — intended; "All" restores them.
- Update `hasFilters`: Runs view → `Boolean(query || status || evalTarget || kind)`; Evals view → `Boolean(query || kind)`. `clearFilters` already rebuilds params from scratch, so no change there.
- `RunsListSkeleton`: add one more `h-8` toolbar Skeleton for the evals view (it currently renders extra controls only for `runs`).

**2. Kind badge in the batch peek rows** — already folded into the R2 spec above (item 3): every peek row shows `EvalKindBadge` next to the eval name.

**3. Upgrade kind in the Runs table from muted text to the badge** (`workers/eval-reports/app/components/eval-name-cell.tsx`). In `EvalNameCell`, move kind out of the second line and into line 1 as a badge, mirroring the Evals view: wrap line 1 in `div className="flex min-w-0 items-center gap-2"` containing the hover-wrapped `Link` plus `<EvalKindBadge evalTarget={run.evalTarget} kind={run.kind} />`. The second line then shows only the model (when `showModel`); delete the `kindText` inline-text path from the second line (the `kindText` helper can go entirely if nothing else uses it). This applies everywhere `EvalNameCell` renders: the Runs view and the batch-detail runs table.
