# Eval Suite & Dashboard Readability — Implementation Plan

**Date:** 2026-07-09
**Surfaces:** `workers/eval-reports/` (viewer worker + SPA), `scripts/` (run/report pipeline), `workers/main/tests/evals/` (manifest)
**Routes (viewer):** `/` (view switcher: Batches / Runs / Evals), `/batches/:batchId` (new), `/runs/:runId` (existing, extended)

**Owner files (new):**
- `workers/eval-reports/app/lib/batches.ts` — pure batch grouping + aggregation helpers
- `workers/eval-reports/app/routes/batch-detail.tsx` — batch detail page
- `workers/eval-reports/app/components/batch-result-badge.tsx` — 3-state pass-fraction badge
- `workers/eval-reports/app/components/eval-name-cell.tsx` — eval name + kind badge + prompt HoverCard (shared by runs table & batch detail)
- `workers/eval-reports/app/components/prompt-section.tsx` — collapsible prompt block on run detail
- `workers/eval-reports/app/components/runs-table.tsx` — runs table extracted from `runs-list.tsx` so Batches/Runs/batch-detail can all render it
- `workers/eval-reports/app/components/batches-table.tsx` — batches list table
- `workers/eval-reports/app/components/evals-rollup.tsx` — per-eval aggregate table
- `tests/eval-reports-batches.test.ts` — unit tests for grouping/aggregation
- `tests/eval-reports-ingest-prompt.test.ts` — unit tests for start-prompt extraction

**Files to modify:**
- `workers/eval-reports/src/types.ts` — new `Run`/`CompleteRequest` fields
- `workers/eval-reports/src/ingest.ts` — extract `startPrompt` from artifacts
- `workers/eval-reports/src/index.ts` — accept/validate new complete-body fields
- `workers/eval-reports/app/main.tsx` — register `/batches/:batchId`
- `workers/eval-reports/app/routes/runs-list.tsx` — view switcher + compose the three views
- `workers/eval-reports/app/routes/run-detail.tsx` — prompt section, kind badge, batch link
- `scripts/report-eval-run.mjs` — new CLI args → complete body
- `scripts/run-agent-eval.mjs` — thread batch env + manifest kind/description to the reporter
- `scripts/run-eval-suite.sh` — mint a shared batch id per suite invocation
- `scripts/run-agent-eval-matrix.mjs` — mint a shared batch id per matrix invocation
- `workers/main/tests/evals/manifest.json` — add `kind` to every entry
- `workers/eval-reports/SKILL.md`, `workers/eval-reports/README.md` — document new fields/protocol
- `.agents/skills/running-agent-evals/SKILL.md` — the agent skill sheet for running/writing evals (symlinked from `.claude/skills/`); update for batches, kinds, and the points convention
- `AGENTS.md` — one-line mention of batch reporting in the eval section

---

## 1. Objective

Three problems with the current eval dashboard (`evals.camelai.dev`):

1. **No run grouping.** Kicking off a suite (`run-eval-suite.sh`, `test:eval:matrix`) produces N independent line items; there is no way to answer "how did *that run* do — how many passed, what's the total score?" Today each `report-eval-run.mjs` invocation mints its own `runId` and nothing ties suite members together (`scripts/run-eval-suite.sh:18` writes `RUN_ID` only to a local `status.json`).
2. **Opaque evals.** The list shows only the eval id (e.g. `project-update-redeploy-state-live`). The manifest `description` is never surfaced, and the start prompt exists only implicitly as the first user message inside the transcript artifact — the detail page never shows it directly.
3. **No notion of eval intent/weight.** Nothing distinguishes a 1-mechanism unit test (`warehouse-list-live`) from a hard end-to-end skill eval (`project-update-redeploy-state-live`), and there is no principled way to combine per-eval scores into a batch total.

### Design decisions (settled — do not re-open)

**Batches use a reporter-side field plus ingest-maintained indexes.** A `batchId` (+ optional `batchLabel`) is threaded through env → reporter → `POST /upload/:id/complete` → stored on `Run`. Ingest also writes `batch-runs/<batchId>/<runId>.json` member records, revisioned `batch-summaries/<batchId>.json` aggregates, and a bounded `batch-index/recent.json` list used by the default view. `GET /api/batches` resolves that time-ordered index without scanning all retained summaries; when it needs pre-index history, it uses bounded `startAfter` probes over timestamped run ids to find the newest canonical tail. `GET /api/batches/:id` reads indexed members for detail. A run without `batchId` (all legacy runs, ad-hoc single runs) has a recent-index pointer but no persisted member/summary objects; it is synthesized as a singleton batch keyed by `runId`.

**Start prompt is extracted at ingest, not emitted by each eval.** `ingestResults` (`workers/eval-reports/src/ingest.ts`) already parses every uploaded artifact server-side. It gains a `startPrompt` extraction: prefer a top-level string `prompt` field (the custom-prompt harness emits one), else the first `role: "user"` message's text. This requires **zero changes to the 18 eval test files** and works for any re-uploaded old artifact.

**Kind + points, not a difficulty enum.** Two axes, both already half-present:
- `kind: "unit" | "skill"` goes in `manifest.json`. This is a *structural* property (does this eval check one mechanism, or end-to-end agent ability?) and does not decay as models improve.
- Difficulty/weight is the scorecard's `maxPoints`, which already varies per eval (4 for `warehouse-list-live`, 10 for `project-update-redeploy-state-live`). The batch total score is `Σpoints / ΣmaxPoints`, so harder (higher-budget) evals automatically weigh more. No `easy/medium/hard` enum anywhere — observed difficulty is instead visible in the new **Evals** rollup view (pass rate + recent verdicts per eval), which self-updates as models improve and tells you when to recalibrate an eval's point budget or retire it.
- Points convention going forward (document in `manifest.json`'s `$comment` and SKILL.md; do **not** rewrite existing scorecards in this change): unit evals budget **1–5 pts** (mostly efficiency), skill evals **6–20 pts** scaled to task complexity.

---

## 2. Data model & pipeline changes

### 2.1 `workers/eval-reports/src/types.ts`

Add to `Run` (and mirror the writable subset in `CompleteRequest`):

```typescript
export type EvalKind = "unit" | "skill";

export interface Run {
	// ...existing fields unchanged...
	/** Shared id for all runs reported by one suite/matrix invocation. Absent for ad-hoc single runs. */
	batchId?: string;
	/** Human label for the batch, e.g. "suite: all" or "matrix: 2 models × 3 evals". */
	batchLabel?: string;
	/** Structural category from the eval manifest. */
	kind?: EvalKind;
	/** One-line description from the eval manifest. */
	description?: string;
	/** Initial user prompt, extracted from the transcript artifact at ingest (truncated). */
	startPrompt?: string;
}
```

`CompleteRequest` additions: `batchId?`, `batchLabel?`, `kind?`, `description?` (NOT `startPrompt` — that is ingest-derived only).

### 2.2 `workers/eval-reports/src/index.ts` — complete handler

- Validate `batchId` against the existing `ID_RE` (`src/index.ts:23`); reject the request with 400 if present and invalid (same behavior as an invalid run id — fail loudly, per repo error culture).
- `kind`: keep only if `"unit"` or `"skill"`, else drop the field.
- `batchLabel` / `description`: trim, cap at 300 chars, drop if empty.
- Pass the accepted fields through to the stored `Run` exactly like `ref`/`commit` today.

### 2.3 `workers/eval-reports/src/ingest.ts` — start prompt extraction

New exported, dependency-free function (exported so `tests/` can unit-test it directly):

```typescript
const START_PROMPT_MAX = 4000;

export function extractStartPrompt(artifact: unknown): string | undefined {
	// 1. top-level string `prompt` (custom-prompt harness) — use if non-empty after trim
	// 2. else first messages[] entry with role === "user":
	//    - content: string → use it
	//    - content: array → join blocks with type === "text" (their .text), "\n\n" separator
	// 3. trim; if empty → undefined
	// 4. if length > START_PROMPT_MAX → slice(0, START_PROMPT_MAX) + "…"
}
```

`ingestResults` calls it on each parsed artifact and sets `run.startPrompt` from the **first artifact that yields one** (runs almost always have exactly one artifact; the existing aggregation loop already iterates them).

### 2.4 Reporter — `scripts/report-eval-run.mjs`

New CLI args, each mapping 1:1 into the `complete` POST body (same pattern as `--model`):

```
--batch <id>          → batchId
--batch-label <text>  → batchLabel
--kind <unit|skill>   → kind
--description <text>  → description
```

Finalization retries `POST /upload/:runId/complete` up to three times with the same run id. The worker reconciles derived indexes before replacing canonical `run.json`, so a transient failure followed by one of these retries completes the same idempotent transition.

### 2.5 `scripts/run-agent-eval.mjs`

At the point where it builds the reporter args (`:580-597`):
- Pass `--batch "$EVAL_BATCH_ID"` and `--batch-label "$EVAL_BATCH_LABEL"` when those env vars are set (do **not** mint one here — a solo run stays batchless and the viewer shows it as a singleton).
- Look up the eval's manifest entry (the script already loads `manifest.json` for `configFor`); when found, pass `--kind` and `--description` from it. `custom-prompt-live` is not in the manifest → both omitted.

### 2.6 `scripts/run-eval-suite.sh`

Near the top (after `RUN_ID` is read, `:18`):

```bash
if [ -z "${EVAL_BATCH_ID:-}" ]; then
  EVAL_BATCH_ID="batch-$(date -u +%Y%m%d-%H%M%SZ)-$(node -e 'process.stdout.write(Math.random().toString(36).slice(2,10))')"
fi
export EVAL_BATCH_ID
export EVAL_BATCH_LABEL="${EVAL_BATCH_LABEL:-suite: ${EVAL_TARGET}}"
```

The timestamped `batch-` prefix mirrors the `eval-` runId format so batch ids sort chronologically too. Respect caller-provided values (an orchestrator may pre-mint). Also record `EVAL_BATCH_ID` in the `status.json` it writes.

### 2.7 `scripts/run-agent-eval-matrix.mjs`

Mint one batch id per matrix invocation (same format; plain Node, so `Date`/`Math.random` are fine here) and set `EVAL_BATCH_ID` + `EVAL_BATCH_LABEL` in the env passed to each spawned `run-agent-eval.mjs` child (`:164`). Label: `matrix: <M> models × <N> evals` (e.g. `matrix: 2 models × 3 evals`). Include the batch id in `matrix-summary.json`; include and print the viewer batch URL only when `EVAL_REPORT=1`, the invocation is not `--dry-run`, and at least one child report completed successfully.

### 2.8 `workers/main/tests/evals/manifest.json` — add `kind`

Entry schema becomes `{ id, description, kind, realDeploy? }`. Update the `$comment` to define the two kinds and the points convention (unit 1–5 pts, skill 6–20 pts). Initial assignment (implementer: sanity-check each against the test's actual assertions before committing; the "discovery" evals are mechanism checks):

| Eval | kind |
| --- | --- |
| sandbox-write-file-live | unit |
| scheduled-prompt-live | unit |
| workflow-live | unit |
| integration-create-live | unit |
| custom-domain-live | unit |
| warehouse-list-live | unit |
| project-snapshot-revert-live | unit |
| dashboard-fake-data-live | skill |
| shadcn-components-live | skill |
| deploy-fake-data-live | skill |
| do-backed-project-deploy-live | skill |
| browser-automation-live | skill |
| project-update-redeploy-state-live | skill |
| space-matching-game-live | skill |
| data-analysis-report-live | skill |
| notebook-fix-rerun-live | skill |
| notebook-deploy-live | skill |
| project-revert-redeploy-live | skill |

---

## 3. Shared batch model and server index

`summarizeBatchRuns` in `workers/eval-reports/src/batches.ts` is shared by ingest and the client. Ingest recomputes each revisioned stored summary from `batch-runs/<batchId>/`, while `batch-index/recent.json` keeps at most 200 time-ordered batch/singleton pointers plus a bounded set of removal revisions that prevent delayed writers from resurrecting stale entries. The default loader reads `GET /api/batches`; it does not group the capped recent-runs response. `workers/eval-reports/app/lib/batches.ts` still exposes pure `Run[]` helpers for member display and eval rollups:

```typescript
export interface Batch {
	/** run.batchId, or run.runId for a batchless singleton */
	id: string;
	/** true when this is a synthesized single-run batch (no stored batchId) */
	singleton: boolean;
	label: string;            // batchLabel ?? (single run → its evalTarget; else `${runs.length} runs`)
	runs: Run[];              // newest-first, as fetched
	models: string[];         // distinct run.model values; undefined → "default model"
	ref?: string;             // from first run that has one
	commit?: string;
	passed: number;           // runs with status === "completed"
	total: number;            // runs.length
	kindBreakdown: { unit: { passed: number; total: number }; skill: { passed: number; total: number } };
	score?: { points: number; maxPoints: number; percentage: number; unscored: number };
	costUsd?: number;         // Σ signal.tokenUsage.costUsd over runs that have it
	totalTokens?: number;     // Σ signal.tokenUsage.totalTokens
	badToolCalls: number;     // Σ signal.badToolCallCount
	startedAt?: string;       // min(startedAt)
	finishedAt?: string;      // max(finishedAt)
	createdAt: string;        // max(createdAt) — used for list ordering
	createdBy?: string;
}

export function groupRunsIntoBatches(runs: Run[]): Batch[];
```

**Aggregation semantics (exact):**
- Group key: `run.batchId ?? run.runId`. Order batches by `createdAt` descending.
- **Score:** sum `evaluation.scorecard.points` and `.maxPoints` over member runs that have an `evaluation`; `percentage = round(points / maxPoints * 100)`; `score` is `undefined` when no member has a scorecard. `unscored` = count of members without an `evaluation.scorecard` — a crashed run drops out of the points denominator, so the UI must surface `unscored > 0` (see mockups) rather than silently inflating the percentage.
- **Pass count is the primary verdict**, score is secondary. A run counts as passed iff `status === "completed"` (which already encodes pass/fail-criteria + contract + harness failures via exit code).
- `kindBreakdown` buckets by `run.kind`; runs with no kind are counted in `total`/`passed` but in neither bucket.
- Wall-clock duration = `finishedAt − startedAt` (max/min across members); omit when either is missing.

Also export `rollupByEval(runs: Run[])` for the Evals view:

```typescript
export interface EvalRollup {
	evalTarget: string;
	kind?: EvalKind;          // from the most recent run that has one
	description?: string;     // same
	startPrompt?: string;     // same — feeds the hover card
	runs: number;
	passed: number;           // → pass rate
	avgScorePct?: number;     // mean of scorecard.percentage over runs that have one
	recent: RunStatus[];      // up to 5 most recent statuses, oldest → newest
	lastRun: Run;
}
```

---

## 4. UI

All components use the shared shadcn primitives from `src/components/ui/` via the `@` alias (already wired — `vite.config.ts:11`). New primitives needed beyond what the worker already imports: `scroll-area`, `separator`, `tooltip`, `collapsible` (all already exist in `src/components/ui/`; import, nothing to install). Use theme tokens (`text-muted-foreground`, `bg-muted/50`, etc.) so dark mode works untouched.

### 4.1 Main page `/` — view switcher

The page gains a three-way view switcher, persisted as `?view=` (`batches` default | `runs` | `evals`) with the existing `setSearchParam` helper. Filters row layout (same row as today, `runs-list.tsx:245-290`):

- **Left:** `ToggleGroup type="single" variant="outline" size="sm"` with items `Batches` / `Runs` / `Evals` (this is the view switcher — put it first, before the search box).
- **Middle:** existing search `InputGroup` (placeholder changes per view: "Search batches…" / "Search runs…" / "Search evals…"). Search matches, per view: batches → `label, models, ref, commit, createdBy, member evalTargets`; runs → existing fields; evals → `evalTarget, description, kind`.
- **Right of search, only in Runs view:** the existing status `ToggleGroup` and eval `Select` (hide them in the other two views — batch/eval views have their own signal density; don't stack filters).
- **Far right:** live count — "`N batches`" / "`N runs`" / "`N evals`".

Keep `?status=`/`?q=`/`?eval=` param behavior identical in Runs view so existing bookmarks work.

### 4.2 Batches view (default) — `batches-table.tsx`

Same `Table` primitive and visual weight as the current runs table. Rows navigate to `/batches/:id`.

```
┌─────────┬──────────────────────────────┬─────────┬───────┬──────────┬──────────┬───────────┐
│ Result  │ Batch                        │ Score   │ Evals │ Branch   │ Duration │ Finished  │
├─────────┼──────────────────────────────┼─────────┼───────┼──────────┼──────────┼───────────┤
│ ✓ 18/18 │ suite: all                   │  91%    │  18   │ main     │ 41m      │ 2h ago    │
│         │ sonnet                       │ 142/156 │       │ a1b2c3d  │          │ illiana   │
├─────────┼──────────────────────────────┼─────────┼───────┼──────────┼──────────┼───────────┤
│ ◐ 14/18 │ matrix: 2 models × 3 evals   │  78%    │  18   │ pi-v2    │ 1h 12m   │ 5h ago    │
│         │ sonnet, gpt-5.5              │ 121/156 │       │ 99f0e1d  │          │ illiana   │
├─────────┼──────────────────────────────┼─────────┼───────┼──────────┼──────────┼───────────┤
│ ✗ 0/1   │ warehouse-list-live          │  25%    │   1   │ main     │ 4m       │ 1d ago    │
│         │ default model                │ 1/4     │       │ a1b2c3d  │          │ evals-ci  │
└─────────┴──────────────────────────────┴─────────┴───────┴──────────┴──────────┴───────────┘
```

Column specs:
- **Result** (`w-28`): `BatchResultBadge` (see 4.6) — icon + `passed/total` fraction.
- **Batch:** line 1 = `batch.label`, `font-medium`; line 2 = models joined with `, ` (max 2 shown, then `+n`), `text-xs text-muted-foreground` — mirrors the existing Eval/model cell (`runs-list.tsx:324-335`).
- **Score** (`w-24`): reuse the exact markup of the current Score cell (`runs-list.tsx:336-351`): colored `pct%` via `scoreClass`, `points/maxPoints` beneath. When `score` is undefined → `—` muted. When `unscored > 0`, append a `Tooltip`-wrapped muted ` ⚠ n` suffix (`Tooltip` content: "n run(s) reported no scorecard and are excluded from the points total").
- **Evals** (`w-16`): member count, `tabular-nums`. If both kind buckets are non-empty, line 2 `text-xs text-muted-foreground`: `5u · 13s`.
- **Branch** (hidden `< md`): reuse `BranchCell` from the runs table (see extraction in 4.5).
- **Duration** (`w-24`, hidden `< sm`): wall-clock; `—` when unknown.
- **Finished** (`w-28`): relative time (`whenText`-equivalent on `finishedAt ?? createdAt`, `title` = ISO) + `shortPerson(createdBy)` beneath.

Empty state: reuse the existing `EmptyState` shell (`runs-list.tsx:140`) — icon `FlaskConical`, title "No runs reported yet", same `EVAL_REPORT=1 bun run test:eval <id>` hint.

### 4.3 Batch detail `/batches/:batchId` — `batch-detail.tsx`

Loader: `fetchBatch(params.batchId)` calls `GET /api/batches/:id`, which returns the server-computed summary plus every indexed member run. Batchless singleton ids resolve through canonical `run.json`. Not found → throw the same 404 `Response` pattern `run-detail.tsx` uses so `RouteError` renders.

```
 ← Runs list                                                      (Button variant=ghost size=sm)

 [◐ 14/18 Passed]  suite: all                                                78%
 sonnet · main @ a1b2c3d · 41m · finished 2h ago · by illiana            121/156 pts
 batch-20260709-141201Z-x8k2q1 ⧉                                    (⚠ 2 runs unscored)

 ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
 │ Passed       │ Score        │ Cost         │ Tokens       │ Bad tool     │ Wall time    │
 │ 14/18        │ 78%          │ $4.12        │ 2.1M         │ calls        │ 41m          │
 │ unit 5/5     │ 121/156 pts  │              │              │ 3            │              │
 │ skill 9/13   │              │              │              │              │              │
 └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

 ┌ Failed criteria ── 4 runs ─────────────────────────────────────────────────────┐
 │ project-update-redeploy-state-live                              → open run     │
 │   ✗ Durable Object state survived redeploy — seeded name was missing…          │
 │ notebook-deploy-live                                            → open run     │
 │   ✗ Agent session completed — session error: …                                 │
 └────────────────────────────────────────────────────────────────────────────────┘

 Runs (18)
 [ …the shared runs table (4.5), minus the Branch column… ]
```

Specs:
- **Header** mirrors the run-detail header structure (`run-detail.tsx:310` region): back button; `BatchResultBadge size="lg"` + `batch.label` as `text-lg font-semibold`; a `MetaLine`-style muted row (models · `ref @ shortCommit` · wall time · finished relative · `by shortPerson`); the batch id in the mono+copy-button pattern of `RunIdLine` (`run-detail.tsx:102`) — reuse/extract that component rather than rewriting it. Right side: `ScoreValue size="lg"` with the aggregate percentage/points; when `unscored > 0`, a muted `text-xs` line "⚠ n runs unscored" directly under it.
- **Stat tiles:** reuse the existing `StatTile` component (`run-detail.tsx:126`) in the same `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2` arrangement as the Overview tab. Tiles and values exactly as the mockup: Passed (with kind-breakdown sublines, omit a subline when that bucket is empty), Score, Cost (`fmtCost`), Tokens (compact format, reuse the run-detail token formatter), Bad tool calls (destructive text color when > 0), Wall time.
- **Failed criteria card:** render only when at least one run failed. `Card` with header `Failed criteria` + muted count. Body: for each failed run (keep batch order): eval name as a `Link` to `/runs/:runId?tab=overview` (`font-medium text-sm`), then its failed `evaluation.passFail.criteria` as rows — `CircleX` icon `size-3.5 text-red-600 dark:text-red-400`, criterion `label`, `— reason` muted, one line each, truncated with `truncate` + `title`. A failed run with no evaluation shows its synthesized `evaluation_contract` criterion (ingest already guarantees one exists). Cap at 5 criteria per run with a muted "+n more" suffix.
- **Runs table:** the shared `RunsTable` (4.5) fed with `batch.runs`, with `showBranch={false}` (same branch for all members) and `showModel={true}` (matrix batches mix models).

### 4.4 Runs view + prompt hover — `eval-name-cell.tsx`

The Runs view is the existing table, with the Eval cell replaced by `EvalNameCell` and one new column.

```
│ Result │ Eval                                    │ Score │ Batch        │ Activity │ …
│  Pass  │ project-update-redeploy-state-live ▾    │  92%  │ suite: all   │ 34 · $0.41
│        │ sonnet · skill                          │ 12/13 │              │
                    │
                    ▼  (HoverCard, opens on the eval-name link)
   ┌──────────────────────────────────────────────┐
   │ project-update-redeploy-state-live   [skill] │
   │ Update and redeploy a DO-backed app while    │
   │ preserving Durable Object state              │
   ├──────────────────────────────────────────────┤
   │ START PROMPT                                 │
   │ ┌──────────────────────────────────────────┐ │
   │ │ I have a deployed app called             │▲│
   │ │ task-tracker. Please update it so that…  │█│
   │ │                                          │▼│
   │ └──────────────────────────────────────────┘ │
   └──────────────────────────────────────────────┘
```

`EvalNameCell` props: `{ run: Run; to: string }`. Structure:
- Line 1: `HoverCard openDelay={300} closeDelay={100}` whose `HoverCardTrigger asChild` wraps the existing `Link` (keep the current link styling/`font-medium`). Follow the existing HoverCard usage pattern in `ResultCell` (`runs-list.tsx:105`).
- Line 2 (outside the trigger): `text-xs text-muted-foreground` — `model ?? "default model"`, then ` · ` + kind when known. Kind rendering: plain lowercase text `unit` / `skill` here; the *badge* form is used in hover/detail only (keeps the table quiet).
- `HoverCardContent className="w-96 p-0" align="start"`:
  - Header block `p-3 space-y-1`: eval id (`text-sm font-medium break-all`) + kind `Badge variant="secondary"` (`unit`/`skill`; for `evalTarget === "custom-prompt-live"` show `custom` `Badge variant="outline"`); `run.description` in `text-xs text-muted-foreground` (omit line when absent).
  - `Separator`.
  - Prompt block `p-3 pt-2`: caption `START PROMPT` (`text-[10px] font-medium tracking-wide text-muted-foreground`), then `ScrollArea className="max-h-64"` containing the prompt in `text-xs whitespace-pre-wrap`. When `run.startPrompt` is absent: muted italic `Prompt not captured for this run` (old runs predate extraction).
- Use this same cell in the batch-detail runs table so hover works there too.

New **Batch** column (hidden `< lg`, `w-32`): when the run has a `batchId`, a `Link` to `/batches/:batchId` with `batchLabel ?? "batch"`, `text-xs text-muted-foreground hover:text-foreground truncate`; stop row-click propagation (the row itself navigates to the run). Batchless → `—`.

### 4.5 `runs-table.tsx` extraction

Move the table markup + cell components (`ResultCell`, `BranchCell`, `ActivityCell`, header defs, row click/navigation) out of `runs-list.tsx` into `app/components/runs-table.tsx` with props:

```typescript
{ runs: Run[]; showBranch?: boolean; showModel?: boolean; showBatch?: boolean }
```

`runs-list.tsx` keeps loaders, filters, view switching, and empty states. This is a cut-paste extraction, not a redesign — preserve the existing column markup and responsive classes exactly, then apply the 4.4 cell changes.

### 4.6 `batch-result-badge.tsx`

Mirror `VerdictBadge` (`app/components/verdict-badge.tsx`) exactly in shape/size handling (`size?: "default" | "lg"` with the same `lg` class string). Three states:

- **All passed** (`passed === total`): green classes copied from VerdictBadge's pass state, `CircleCheck` icon, text `18/18`.
- **Partial** (`0 < passed < total`): `border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400`, `CircleAlert` icon (lucide), text `14/18`.
- **All failed** (`passed === 0`): `variant="destructive"`, `CircleX` icon, text `0/18`.

On the batch detail header (`size="lg"`), append the word: `14/18 Passed` / `0/18 Failed`.

### 4.7 Run detail `/runs/:runId` additions — `prompt-section.tsx`

```
 ← Back
 [Pass] project-update-redeploy-state-live  [skill]                          92%
 sonnet · main @ a1b2c3d · 6m · 2h ago · by illiana · host · [real deploy]  12/13 pts
 eval-20260709-141203Z-ab12cd34 ⧉ · in suite: all →

 ┌ PROMPT ──────────────────────────────────────────────────────────── [⧉] [⌄] ┐
 │ Update and redeploy a DO-backed app while preserving Durable Object state   │
 │ I have a deployed app called task-tracker. Please update the header to…     │
 └──────────────────────────────────────────────────────────────────────────────┘

 ── Overview ── Transcript ── Log ── Raw JSON ──────────────────────────────────
```

- **Kind badge:** in the title row next to `VerdictBadge`, a `Badge variant="secondary"` with `run.kind` (omit when unknown; `custom` outline badge for `custom-prompt-live` as in 4.4).
- **Batch link:** appended to the `RunIdLine` row (`run-detail.tsx:102`): separator `·` then a `Link` to `/batches/:batchId` reading `in {batchLabel ?? "batch"}` with a `ArrowRight` lucide icon `size-3`, `text-xs text-muted-foreground hover:text-foreground`. Only when `batchId` present.
- **PromptSection** rendered between the header block and the `Tabs` (visible on every tab — not a tab itself, so the prompt is one glance away regardless of where you land). Render only when `startPrompt` or `description` exists. Structure: `Collapsible` (default **collapsed**) styled as a bordered rounded block (`rounded-lg border bg-muted/30`):
  - Header row (`flex items-center gap-2 px-3 py-2`): caption `PROMPT` (`text-[10px] font-medium tracking-wide text-muted-foreground`); flex-spacer; copy `Button variant="ghost" size="icon-sm"` (`Copy` icon, copies raw `startPrompt`, hidden when absent — reuse the copy-button pattern from `RunIdLine`); `CollapsibleTrigger asChild` chevron button (`ChevronDown`, rotate 180° when open via `data-[state=open]` classes).
  - Always-visible body (`px-3 pb-2`): `run.description` on its own line (`text-xs text-muted-foreground`, omit when absent); collapsed-state prompt preview `line-clamp-2 text-sm whitespace-pre-wrap` — clicking anywhere on the preview also expands (wrap it in the trigger).
  - `CollapsibleContent`: replaces the preview with the full prompt in `ScrollArea className="max-h-72"`, `text-sm whitespace-pre-wrap px-3 pb-3`. If `startPrompt` is absent entirely, show muted italic `Prompt not captured for this run` as the body and omit the collapse affordance.

### 4.8 Evals view — `evals-rollup.tsx`

Per-eval aggregate over the loaded runs (this is where observed difficulty lives — a "hard" eval is one with a low pass rate, and that stays true as models change).

```
┌──────────────────────────────────────┬───────────┬───────────┬───────────┬────────────┐
│ Eval                                 │ Last 5    │ Pass rate │ Avg score │ Last run   │
├──────────────────────────────────────┼───────────┼───────────┼───────────┼────────────┤
│ project-update-redeploy… ▾  [skill]  │ ● ● ○ ● ● │ 80%  ×15  │ 84%       │ Pass · 2h  │
│   Update and redeploy a DO-backed…   │           │           │           │            │
│ warehouse-list-live  [unit]          │ ● ● ● ● ● │ 100% ×12  │ 91%       │ Pass · 1d  │
│   Discover and call the warehouse…   │           │           │           │            │
└──────────────────────────────────────┴───────────┴───────────┴───────────┴────────────┘
```

- Sorted by pass rate ascending (worst first — the scan target is "which evals are hurting").
- **Eval:** line 1 = eval id (`font-medium truncate`) wrapped in the same prompt `HoverCard` as 4.4 (rollup carries `startPrompt`/`description`/`kind` from the most recent run that has them) + kind `Badge variant="secondary"`; line 2 = description, `text-xs text-muted-foreground truncate`.
- **Last 5** (`w-28`): up to 5 dots oldest→newest, `size-2 rounded-full inline-block` — pass `bg-green-600 dark:bg-green-500`, fail `bg-red-600 dark:bg-red-500`; each with `title` = `Pass/Fail · <relative time>`. Fewer than 5 runs → render only what exists.
- **Pass rate** (`w-24`): `pct%` colored with `scoreClass(pct)`, then muted `×N` run count.
- **Avg score** (`w-24`): mean scorecard percentage, `scoreClass`-colored; `—` when no member has a scorecard.
- **Last run** (`w-28`): `VerdictBadge` (default size) + relative time beneath.
- Row click → `/?view=runs&eval=<evalTarget>` (drill into that eval's run history using the existing filter).

### 4.9 Skeletons

Extend `RunsListSkeleton` to match whichever view is active (same shapes: toolbar row + N row placeholders). Batch detail gets a skeleton mirroring header + 6 tiles + table, following the run-detail skeleton's existing pattern.

---

## 5. Legacy & edge-case behavior (must hold)

- **Legacy runs (no new fields):** appear as singleton batches labeled by `evalTarget`; runs table renders `—` for batch; hover shows "Prompt not captured for this run"; Evals rollup still includes them (kind/description simply absent). Nothing 404s, nothing crashes on absent fields — every new field is optional end-to-end.
- **Batch member missing scorecard** (crashed before artifact): counts as failed in `passed/total`, excluded from points, surfaced via the `unscored` warning (4.2, 4.3).
- **Mixed-model batches** (matrix): models chip list in batches view; per-run model stays visible in the batch-detail runs table.
- **`custom-prompt-live`:** no manifest entry → no kind/description from the reporter, but ingest still extracts `startPrompt` (it emits a top-level `prompt`); shows the `custom` outline badge.
- **Batch detail for a batch older than the recent list window:** `GET /api/batches/:id` reads that batch's complete `batch-runs/<batchId>/` prefix, so detail is not truncated by the recent-runs or recent-batches limits. Legacy unindexed records use a canonical-run fallback.
- **`?view=` unset or unknown value** → Batches view; existing `/?q=&status=&eval=` URLs (pre-change bookmarks) land on Batches — Runs-only params are preserved in the URL and take effect when the user switches to Runs.

---

## 6. Tests

- `tests/eval-reports-batches.test.ts` (root vitest, plain unit tests — `app/lib/batches.ts` and `rollupByEval` must stay dependency-free): grouping key incl. batchless singletons; ordering; score aggregation with an unscored member; kind breakdown with unknown-kind members; wall-clock duration with missing timestamps; models dedup; `rollupByEval` recent-5 ordering and pass-rate math.
- `tests/eval-reports-ingest-prompt.test.ts`: `extractStartPrompt` — top-level string `prompt` wins; first user message with string content; block-array content joining only `text` blocks; no user message → undefined; whitespace-only → undefined; > 4000 chars truncates with `…`.
- `tests/eval-report-scripts.test.ts`: bounded same-run-id finalization retries and matrix batch-URL gating, including actual dry-run summary output.
- Manual verification of the pipeline threading: run the viewer locally (`bun run dev:eval-reports`, `CF_ACCESS_ENABLED=0` in its `.dev.vars`), then `EVAL_REPORT=1 EVAL_REPORT_BASE=http://localhost:8789 bun run test:eval warehouse-list-live` and a two-eval `run-eval-suite.sh` invocation; confirm the two suite runs share a `batchId`, the batch page aggregates them, and `startPrompt`/`kind`/`description` land on `run.json`.
- `bun run typecheck` covers the viewer TS (it's part of the repo tsconfig graph via the worker's own tsconfigs — run `tsc` through the worker's config if the root typecheck doesn't include it: `bunx tsc -p workers/eval-reports/tsconfig.app.json --noEmit`).

## 7. Docs & skill sheets to update (same change)

Both agent-facing skill sheets must be updated so future agents write and run evals against the new model — this is not optional polish; the skill sheets are the contract the agent reads before touching evals.

- `workers/eval-reports/SKILL.md` (served at `/skill` — the canonical API doc, and where the **"Adding a new committed eval"** instructions live):
  - New `Run`/`CompleteRequest` fields (`batchId`, `batchLabel`, `kind`, `description`, ingest-derived `startPrompt`) with one-line semantics each.
  - The batch protocol: `EVAL_BATCH_ID`/`EVAL_BATCH_LABEL` env vars, minted automatically by `run-eval-suite.sh` and the matrix runner, respected if pre-set by an orchestrator; solo runs stay batchless and render as singleton batches. Mention the `/batches/:batchId` page.
  - Extend "Adding a new committed eval": a manifest entry now requires `kind` (`unit` = checks one mechanism, `skill` = end-to-end agent ability), and the scorecard points budget must follow the convention — **unit 1–5 pts, skill 6–20 pts scaled to task complexity** — so batch totals stay meaningfully weighted. State explicitly that pass/fail criteria remain the hard contract and the scorecard never gates a pass.
- `.agents/skills/running-agent-evals/SKILL.md` (the repo skill agents load to run evals; `.claude/skills/running-agent-evals` is a symlink to it — edit the `.agents` copy only):
  - "Run an eval" / suite / matrix sections: note that suite and matrix invocations automatically mint a shared `EVAL_BATCH_ID` (+ default `EVAL_BATCH_LABEL`) so the dashboard groups them as one batch, and that either can be pre-set in the environment to join runs into an existing batch.
  - "Report the run" section: document the new reporter flags (`--batch`, `--batch-label`, `--kind`, `--description`) for hand re-reports, alongside the existing `--eval`/`--artifact` example.
  - "Read results" section: mention the new run fields and that the dashboard's default view is now batches (`/` → Batches / Runs / Evals; batch pages at `/batches/:id`).
- `workers/eval-reports/README.md`: one paragraph on batches + the new fields.
- `workers/main/tests/evals/manifest.json` `$comment`: define `kind` and the points convention (same wording as SKILL.md).
- `AGENTS.md` (eval results viewer section): single sentence — suite/matrix runs share an `EVAL_BATCH_ID` and the viewer groups them into batches.

## 8. Scope classification

**Required:** everything in §2 (field threading, ingest extraction, suite/matrix batch minting, manifest kinds), §3, §4.1–4.7, §5, §6, and §7 (both skill sheets ship in the same change — an agent reading a stale skill sheet will write evals against the old contract).

**Cuttable if the change runs long (each is independent):**
- §4.8 Evals rollup view (ship the switcher with just Batches/Runs if needed; keep the `?view=` param design so it slots in later).
- A `POST /api/runs/:id/reingest` admin endpoint to backfill `startPrompt` on old runs from their stored artifacts.

**Explicitly out of scope (do not do here):**
- Recalibrating existing eval scorecard point budgets to the new convention — separate follow-up once the batch view makes the imbalances visible.
- Any change to eval pass/fail semantics, `eval-criteria.ts`, or the 18 eval test files.
- An unbounded all-history batches response; `GET /api/batches` is intentionally capped at 200 and backed by the bounded recent index.
- Renaming/re-titling evals or editing manifest descriptions beyond adding `kind`.
