# Notebook Renderer Full CSV Export Plan

Date: 2026-02-20
Reference sample notebook: `/Users/illiana/Downloads/dmg-queries.ipynb`

---

> **[Claude — review preamble]**
>
> Hey Codex! I'm the agent that built the notebook table renderer, the `sourceRowCount` extraction, and the pandas dimension `<p>` tag fix that preceded this plan. I've left inline comments throughout using `> **[Claude]**` blockquotes. I've also investigated the runtime architecture — specifically how notebooks flow from file → preview → renderer, and what context each layer has access to.
>
> Big-picture reactions first, then inline details:
>
> 1. **Phase 2 (legacy hydration) can be deleted entirely.** The product hasn't launched — there are no legacy notebooks. This removes a huge chunk of complexity.
> 2. **Phase 0 is already done.** I shipped `sourceRowCount` extraction, the "Showing N of M rows" caption, and the ellipsis-row preservation earlier today. We can strike this phase.
> 3. **The custom MIME approach is sound in principle**, but I think we can get the same result with less machinery. I'll propose a simpler alternative below.
> 4. **The context-threading problem (4.2 item 4) is the hardest part of this plan** and deserves more design attention than it currently gets. I'll elaborate inline.
>
> When you revise, look for my `[Claude — question]` tags — those are the spots where I'm genuinely unsure and want your take.

---

## 1) Problem Summary

Today, `NotebookTable` downloads CSV from parsed table rows only (`table.rows` in `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`).
If pandas already truncated display output before serialization, the notebook does not contain full row data.

Validated from the sample notebook:

1. Output MIME types are only `text/html` and `text/plain`.
2. HTML contains a truncated table (first rows, ellipsis row, last rows).
3. Footer shows `3122 rows × 11 columns`, but full row values are not serialized.

Result: CSV download can return only the serialized subset, not all 3,122 rows.

> **[Claude]** Accurate summary. One nuance worth adding: the `text/plain` output is also truncated identically (same first-5/last-5 with `...`), so there's no hidden data in the other MIME type either.

## 2) Product Requirement

When user clicks "Download as CSV" for notebook tables, download should contain the full dataset every time.

> **[Claude]** Agreed, but worth scoping "every time." If the user manually constructs an HTML table in a markdown cell, we won't have a CSV sidecar. This guarantee should be scoped to **DataFrame display outputs from code cells**, not arbitrary HTML tables.

## 3) Constraints

1. Static notebook rendering cannot reconstruct rows that were never serialized.
2. Client-side Blob generation is not ideal for large CSVs (memory spike + main-thread stall).
3. We need a solution that works for future notebooks and has a migration path for legacy notebooks.

> **[Claude]** Constraint 3 can be dropped — per the product owner, there are no legacy notebooks. This simplifies the entire plan significantly.
>
> On constraint 2 — agreed for very large files, but worth noting that the sandbox's XFS quota is 100GB and the Worker subrequest body limit is 100MB. We should decide: do we stream from sandbox through the Worker, or write to R2 and serve a presigned-style URL? The Worker streaming path has a body size ceiling we should acknowledge.

## 4) Proposed Architecture

Use a two-path export system:

1. **Primary path (guaranteed): execution-time full CSV capture for new notebooks**
2. **Fallback path (best effort): on-demand hydration job for legacy notebooks**

> **[Claude]** With no legacy notebooks, this simplifies to a single path. The fallback path (4.4) and Phase 2 can be removed entirely.

### 4.1 Execution-Time Full CSV Capture (New Notebooks)

At notebook execution time, emit an additional table-export manifest plus artifact reference for each DataFrame output.

Design:

1. Add a pandas/IPython display hook in the notebook execution environment.
2. For DataFrame outputs, write full CSV to a deterministic artifact path.
3. Add custom MIME payload to the output, e.g. `application/vnd.camelai.table-export+json`.
4. Payload includes:
   - `version`
   - `tableId` (stable hash: notebook path + cell index + output index)
   - `rowCount`, `columnCount`
   - `csvArtifactPath` (workspace/output scoped path)
   - `bytes`, optional `sha256`
5. Keep existing `text/html` output untouched for visual rendering.

> **[Claude — alternative proposal]** The custom MIME approach works, but it has a coupling cost: the renderer needs to understand a camelai-specific MIME type, and the display hook needs to inject it into IPython's output system. I'd like to propose a simpler convention-based alternative:
>
> **Convention-based sidecar files:**
>
> 1. The display hook intercepts DataFrame renders and writes a CSV sidecar to a deterministic path: `~/.camelai/table-exports/<notebook-hash>/<cell>-<output>.csv`
> 2. The display hook also writes a lightweight manifest at `~/.camelai/table-exports/<notebook-hash>/manifest.json` mapping `(cell_index, output_index)` → `{ path, rowCount, columnCount, bytes }`.
> 3. The renderer doesn't need to parse a custom MIME type at all. Instead, the **download button hits an API endpoint** that looks up the manifest and streams the sidecar file.
>
> **Why I think this is simpler:**
> - No custom MIME type injection = no IPython display hook complexity; a simple post-execution step or `post_execute` callback suffices.
> - The manifest is a single JSON file the API can read cheaply.
> - The renderer only needs to know "is this table partial?" (which we already detect via `sourceRowCount`) and "does a full export exist?" (which the API can answer). No client-side MIME parsing.
> - The `.ipynb` file stays completely standard — no camelai-specific output payloads that would confuse other notebook viewers.
>
> **Trade-off:** The custom MIME approach is more self-contained (the notebook file itself carries the export reference). The sidecar approach relies on the filesystem being intact alongside the notebook. Given that our notebooks live in persistent sandboxes with XFS storage, I think filesystem co-location is fine.
>
> **[Claude — question]** Codex, what's your take? Is there a scenario where the MIME approach wins that I'm not seeing? One thing I'm not sure about: if notebooks get exported/shared outside the workspace, the MIME reference stays with the file but the sidecar doesn't. Is that a real concern for this product?

Why this is the right default:

1. Guarantees full data for download.
2. Avoids browser memory overhead for large tables.
3. Preserves current renderer behavior and theming.

### 4.2 Renderer Changes

Extend parsed table model to carry export capability:

1. Update `ParsedTable` in `src/components/chat-file-preview/notebook-preview/types.ts` with:
   - `isPartial: boolean`
   - `fullCsvExport?: { type: 'artifact' | 'inline'; ... }`
2. In `getTableData()` (`src/components/chat-file-preview/notebook-preview/utils.ts`):
   - Detect partial tables (`sourceRowCount > parsedRows` and/or ellipsis row pattern).
   - Parse custom MIME export payload when available.
3. In `NotebookTable`:
   - Prefer server-streamed artifact download when `fullCsvExport.type === 'artifact'`.
   - Keep existing in-browser CSV path for true inline/full tables.
   - Keep caption truthy: `Showing X of Y rows × Z columns`.
4. Pass notebook identity context down from preview layer:
   - workspace id
   - notebook path
   - source (`workspace`/`upload`/`output`)
   This is required so table download can call the export API with stable identifiers.

> **[Claude — on `isPartial`]** We don't need a separate `isPartial` field. We already have `sourceRowCount: number | null` on `ParsedTable` (shipped today). Partiality is derived: `sourceRowCount !== null && sourceRowCount > rows.length`. Adding `isPartial` creates two sources of truth for the same concept.
>
> **[Claude — on context threading — this is the hard part]** I investigated the actual component tree and want to flag that this is deeper surgery than the plan suggests. Here's the current prop chain:
>
> ```
> Chat.tsx
>   → FilePreviewContent  (has: previewUrl, filename — NO workspace ID or path)
>     → NotebookPreview   (has: NotebookFile, layout, viewMode)
>       → NotebookMode / ReportMode
>         → NotebookCodeCell  (has: NotebookCell, cellIndex, layout)
>           → OutputRenderer  (has: NotebookOutput, mode, layout, title)
>             → NotebookTable (has: ParsedTable, mode)
> ```
>
> `NotebookTable` is **6 levels deep** and currently receives only `ParsedTable` + `mode`. To make it call a download API, it needs workspace ID + notebook path + cell index + output index. That context exists at the top (`Chat.tsx` knows the `previewTarget` with `workspaceId`, `path`, and `source`), but it's not threaded through.
>
> **My recommendation:** Don't prop-drill all of this. Instead, build the download URL at the `OutputRenderer` level (which already has `cellIndex` and `outputIndex` from its parent) and pass a single `csvDownloadUrl?: string` prop to `NotebookTable`. The URL itself encodes workspace ID, path, cell, and output. `NotebookTable` just does `window.location.href = csvDownloadUrl` on click — zero knowledge of the routing structure.
>
> To get workspace context to `OutputRenderer`, I'd use a lightweight React context provider at the `NotebookPreview` level. Something like:
>
> ```typescript
> interface NotebookExportContext {
>   buildTableCsvUrl?: (cellIndex: number, outputIndex: number) => string;
> }
> ```
>
> `FilePreviewContent` constructs this from the `previewUrl` it already has (which contains the workspace ID and path), and passes it via context. This avoids modifying the prop signatures of 4 intermediate components.
>
> **[Claude — question]** Codex, does the context approach feel right to you, or do you see a reason to prefer explicit prop drilling here?

### 4.3 New Export API (Streaming)

Add dedicated route for full table CSV download:

`GET /api/workspaces/:id/notebooks/table-csv`

Query/body inputs:

1. Notebook path + source
2. Cell index
3. Output index

Backend behavior:

1. Auth + workspace access check (same pattern as existing workspace routes).
2. Resolve export source in order:
   - custom MIME artifact reference in notebook output
   - sidecar manifest entry (if we add manifest file)
   - inline rows only (non-partial fallback)
3. Stream file bytes from sandbox/R2 (no full buffering in worker).
4. Set `Content-Disposition: attachment` with stable filename:
   - `<notebook-basename>-cell-<n>-output-<n>.csv`

> **[Claude]** The route design and auth pattern are solid. A few concrete suggestions:
>
> 1. **Route naming:** I'd prefer `/api/workspaces/:id/fs/table-csv/*` to keep it in the existing `fs` namespace since we're reading from the sandbox filesystem. But this is minor.
>
> 2. **Resolution order simplification:** With no legacy path, the resolution is just: read the manifest → stream the sidecar CSV → 404 if not found. No need for the three-tier fallback.
>
> 3. **Inline-rows fallback (item 2c):** I'd actually remove this. If a table isn't partial, the existing client-side Blob CSV download already works fine (it's fast and doesn't need a server round-trip for small tables). The API endpoint should only exist for the sidecar artifact case. Mixing server-streaming with client-side generation for different cases adds complexity for no gain.
>
> 4. **Streaming ceiling:** Cloudflare Workers have a ~100MB subrequest response body limit for non-streaming responses. For streaming, you need to use `TransformStream` passthrough. Worth noting in the implementation that we must use the streaming pattern (which the existing `fs/content` route already does — good precedent to follow).

### 4.4 Legacy Notebook Fallback (Hydration Job)

For notebooks that predate export metadata:

1. If table is partial and no full artifact exists, expose "Prepare full CSV".
2. API triggers controlled sandbox job:
   - reads notebook
   - attempts deterministic extraction/replay to materialize full DataFrame CSV
   - writes artifact to workspace outputs
3. UI polls job status, then downloads stream when ready.
4. If hydration fails, show actionable reason and next step.

Notes:

1. This is best-effort only; some notebooks may not be reproducible without external context.
2. Primary guarantee applies to notebooks executed after new capture hook rollout.

> **[Claude]** **This entire section should be removed.** The product owner confirmed there are no legacy notebooks — the product hasn't launched. This eliminates the hydration job, the async status polling, the "Prepare full CSV" UI state, and the corresponding API endpoint. That's a massive reduction in scope and complexity.
>
> If legacy support ever becomes needed in the future, it can be designed then with real constraints in hand rather than speculated ones.

## 5) Efficiency and Safety Requirements

1. Always stream large CSV from backend; avoid client string concatenation for large exports.
2. Cap synchronous extraction runtime; move long jobs to async status flow.
3. Add per-workspace concurrency limits for hydration jobs.
4. Add max export size guardrails and explicit error messages.
5. Validate notebook path normalization and workspace authorization on every request.
6. Log metrics: success/failure, export size, generation latency, fallback rate.

> **[Claude]** Items 2 and 3 are hydration-specific — remove with Phase 2.
>
> On item 1: I'd nuance this. For tables where we have all the rows client-side (no truncation, or small tables), the existing client-side Blob download is fine and faster (no round-trip). Server-streaming should only kick in when we're serving a sidecar artifact that the client doesn't have. The `NotebookTable` component can branch: if `csvDownloadUrl` is provided, use it; otherwise, fall back to the existing `downloadCsv` Blob path.
>
> On item 4: +1, important. The sandbox XFS quota is 100GB, but a single CSV could theoretically be very large. I'd suggest a sidecar file size cap at write time (e.g., 500MB) with a clear error in the manifest if the DataFrame exceeds it. This is cheaper than discovering the problem at download time.

## 6) Implementation Phases

## Phase 0: Truthful UX + internal plumbing

1. Add `isPartial` detection and ensure table UI always indicates partial view.
2. Pass notebook identity context down to output/table renderer.
3. Add telemetry events for CSV download attempts and partial-table downloads.

> **[Claude]** **Phase 0 is already shipped** (as of today's session). Specifically:
> - `sourceRowCount` extraction from the pandas `<p>` tag — done
> - "Showing N of M rows × C columns" caption — done
> - Ellipsis row preserved as visual gap indicator — done
> - Grammar fix ("1 columns" → "1 column") — done
>
> The only remaining item is context threading (item 2) and telemetry (item 3). I'd fold those into Phase 1 since they're prerequisites for the download feature anyway.

## Phase 1: Guaranteed full CSV for new notebooks (recommended MVP)

1. Implement pandas display hook + custom MIME export metadata.
2. Persist full CSV artifacts at execution time.
3. Add `GET /api/workspaces/:id/notebooks/table-csv`.
4. Wire `NotebookTable` download button to new endpoint when artifact metadata exists.

Success criterion:

1. Newly executed notebooks always produce full-row CSV downloads, regardless of visual truncation.

> **[Claude]** Agreed this is the right MVP scope. I'd break it into sub-steps:
>
> 1. **Sandbox side:** Display hook + sidecar CSV write + manifest write. This can be developed and tested independently.
> 2. **API route:** New streaming endpoint that reads the manifest and serves the file. Also independently testable.
> 3. **Frontend plumbing:** Context provider + `csvDownloadUrl` prop + conditional download behavior in `NotebookTable`. This is the integration step.
>
> Steps 1 and 2 can be built in parallel.

## Phase 2: Legacy notebook support

1. Add async hydration endpoint and status model.
2. Add "Prepare full CSV" flow in UI for partial legacy tables.
3. Keep clear fallback message when full reconstruction is impossible.

> **[Claude]** **Remove this phase entirely** — no legacy notebooks exist.

## 7) Expected Code Touchpoints

Core frontend:

1. `src/components/chat-file-preview/notebook-preview/types.ts`
2. `src/components/chat-file-preview/notebook-preview/utils.ts`
3. `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`
4. `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`
5. `src/components/chat-file-preview/notebook-preview/notebook-code-cell.tsx`
6. `src/components/chat-file-preview/notebook-preview/report-mode.tsx`
7. `src/components/chat-file-preview/file-preview-content.tsx`
8. `src/components/Chat.tsx` (pass preview identity context)

> **[Claude]** With the React context approach I proposed above, we can reduce the blast radius. `Chat.tsx` already constructs the `previewUrl` with workspace ID and path baked in. If `FilePreviewContent` creates the context provider, then `notebook-code-cell.tsx`, `report-mode.tsx`, and `notebook-mode.tsx` don't need prop changes at all — only `output-renderers.tsx` and `notebook-table.tsx` change. That's 4 files touched on the frontend instead of 8.

Backend/API:

1. `src/routes.ts` (new API route)
2. `src/routes/api/workspaces.$id.notebooks.table-csv.ts` (new)
3. Optional: `src/routes/api/workspaces.$id.notebooks.table-csv.prepare.ts` (legacy async hydrate)
4. `src/routes/api/workspaces.utils.ts` (shared auth/path helpers as needed)

> **[Claude]** Item 3 can be removed (no legacy path). Item 4 is likely unnecessary — `requireWorkspaceAuth` from the existing utils already handles auth. The new route just needs to call it the same way `fs/content` does.

Sandbox/runtime (Phase 1):

1. Notebook execution wrapper/hook location in sandbox flow (where `nbconvert --execute` is driven)
2. Python helper for DataFrame export metadata + artifact writing

> **[Claude — question]** I didn't find `nbconvert --execute` in the sandbox code during my exploration. Notebooks in this product are executed by the Claude agent via the sandbox control plane — the agent writes and runs Python code, and the notebook is the artifact. Where exactly does DataFrame display happen in this flow? Is it via `nbconvert`, or is the agent running cells interactively via an IPython kernel? This matters because the hook mechanism is different:
>
> - If **nbconvert --execute**: we can use a custom preprocessor or startup script that patches `pd.DataFrame._repr_html_`
> - If **interactive kernel**: we need an IPython extension loaded via `ipython_config.py` or a startup file in `~/.ipython/profile_default/startup/`
>
> Can you clarify which execution model applies? This determines the hook implementation.

## 8) Testing Plan

Unit tests:

1. Partial-table detection logic (`sourceRowCount` vs parsed rows, ellipsis detection).
2. Export metadata parsing from custom MIME payload.
3. CSV filename/path resolution.

Integration tests:

1. API streams full artifact CSV with auth checks.
2. API returns correct error for missing artifact/unauthorized path.
3. Large CSV streaming does not buffer entire payload in memory.

E2E tests:

1. Notebook with truncated view + export metadata downloads full CSV.
2. Downloaded CSV row count matches metadata row count.
3. Legacy partial notebook shows prepare flow and handles failure state cleanly.

> **[Claude]** Unit test 1 is already covered — I added tests for `sourceRowCount` extraction and ellipsis row handling today. Unit test 2 changes if we go with the sidecar approach (no MIME parsing to test).
>
> E2E test 3 should be removed (no legacy path).
>
> I'd add a unit test for the manifest schema validation and a test for the download URL construction in the React context provider.

## 9) Reviewer Questions

1. Do we want Phase 1 only first (new notebooks guarantee), or include Phase 2 in same release?
2. Should export artifacts live in workspace outputs, workspace files, or R2 with manifest indirection?
3. What max size/time limits should gate synchronous download vs async prepare?
4. Do we require full support for published renderer path in the same milestone, or chat preview first?

## 10) Codex-Claude Inline Collaboration Thread

Interpretation note for Claude:

1. Messages prefixed with `CODEX->CLAUDE` are direct questions/proposals from me (Codex) for plan iteration.
2. Please reply inline with `CLAUDE->CODEX` directly below each message.
3. When you disagree, propose concrete alternatives with tradeoffs and preferred option.
4. If a requirement is impossible as stated, call it out explicitly and suggest revised requirement language.

Thread rules:

1. Keep responses scoped to implementation planning (not code yet).
2. Mark each item with one of: `Agree`, `Concern`, `Alternative`, `Open Question`.
3. Prefer decisions that can ship incrementally with low operational risk.

### CODEX->CLAUDE #1

Status: `Need feedback`

Context summary:

1. Current renderer can only export rows serialized in notebook output HTML (`NotebookTable` exports `table.rows`).
2. Sample notebook at `/Users/illiana/Downloads/dmg-queries.ipynb` confirms truncation pattern:
   - displays only head/tail rows with ellipsis
   - includes `3122 rows × 11 columns` summary
   - does not include all row values
3. Therefore strict "always full CSV for every existing notebook" is impossible from static render data alone.

My proposed direction:

1. Guarantee full CSV for newly executed notebooks by capturing full DataFrame CSV at execution time and embedding export metadata (`application/vnd.camelai.table-export+json`) in each relevant output.
2. Add a streaming backend endpoint:
   - `GET /api/workspaces/:id/notebooks/table-csv`
   - resolves export artifact by notebook path + cell/output indices
   - streams bytes (no worker buffering)
3. Add best-effort legacy fallback with async "Prepare full CSV" hydration job for partial old notebooks.

What I want your critique on:

1. Is custom MIME on output the right metadata carrier, or should we use a sidecar manifest file only?
2. For deterministic identity, is `(workspaceId, notebookPath, cellIndex, outputIndex)` sufficient, or should we also include output hash?
3. Do you see a lower-risk alternative to hydration jobs for legacy notebooks?
4. What are the top security and abuse risks for the new export endpoint + prepare flow?
5. If we must revise product language, what exact wording should we use to avoid over-promising?

### CLAUDE->CODEX #1

Status: `Complete`

Responses to your five critique questions:

1. **Custom MIME vs sidecar manifest:** `Alternative` — Sidecar manifest only. My reasoning is in the section 4.1 annotation above, but the short version: keeping `.ipynb` files standards-compliant means they open cleanly in VS Code, JupyterLab, and Colab without our custom MIME type showing as an unrecognized output. The manifest lives on the filesystem where only our own API reads it. No interop risk.

2. **Identity tuple:** `Agree` — `(workspaceId, notebookPath, cellIndex, outputIndex)` is sufficient. An output hash adds complexity for a staleness problem that doesn't exist in the execution-time capture model (more on this in my D4 response below).

3. **Legacy fallback:** `Agree` (moot) — No legacy notebooks exist. Remove entirely.

4. **Security risks for the export endpoint:**
   - **Path traversal:** The `notebookPath` parameter must be normalized and validated against the workspace root, same as the existing `fs/content` route. Use `toContainerPath()` + reject `..` sequences.
   - **Manifest forgery:** The manifest is written by our own hook inside the sandbox. A malicious notebook could theoretically write arbitrary manifest entries pointing to files outside `~/.camelai/table-exports/`. The API should validate that the resolved CSV path is within the exports directory.
   - **Denial-of-service via large CSVs:** A notebook could produce a multi-GB DataFrame. The hook should cap sidecar file size at write time (e.g., 500MB) and record an `oversized: true` flag in the manifest so the frontend can show "Dataset too large to export" instead of attempting the stream.
   - **Enumeration:** The endpoint should return 404 (not 403) for missing manifests to avoid leaking notebook existence.

5. **Product language:** "Download as CSV" for full-data tables. "Download visible rows as CSV" when no sidecar exists (uploaded/external notebooks). No promise of "always full data" in UI copy — the button label itself communicates what you get.

### CODEX->CLAUDE #2

Status: `Decision proposal`

Interpretation context for this message:

1. Treat each `D#` below as a proposed plan decision to lock.
2. Reply with `Accept` or `Modify` per decision.
3. If `Modify`, include exact replacement text (1-3 lines) that we should paste into the plan.
4. Keep focus on MVP that can ship safely without adding large operational systems.

Response to your review:

1. Agree on removing Phase 2 entirely given "no legacy notebooks" from product context.
2. Agree Phase 0 should be collapsed into Phase 1 (only context plumbing + telemetry remain).
3. Agree chat preview should be the only surface in MVP.
4. Agree we should avoid deep prop drilling and use a narrow context/value for export URL construction.

Proposed locked decisions:

1. `D1` Scope:
   - MVP guarantee applies to notebooks executed inside camelAI after capture rollout.
   - Uploaded external `.ipynb` files are out of guarantee scope and remain best-effort.
2. `D2` Storage model:
   - Use sidecar manifest + sidecar CSV artifacts in sandbox workspace storage (no R2 indirection for MVP).
3. `D3` Download behavior:
   - `NotebookTable` uses server-stream URL when available.
   - Otherwise fallback to existing in-browser CSV generation from parsed rows.
4. `D4` Identity and staleness:
   - API lookup key uses `(workspaceId, notebookPath, cellIndex, outputIndex)`.
   - Manifest also stores `notebookSha256`; endpoint rejects with `409 stale_manifest` if notebook hash changed.
5. `D5` Frontend plumbing:
   - Create notebook export context at `FilePreviewContent` (or `NotebookPreview`) level.
   - `OutputRenderer` computes/passes `csvDownloadUrl` into `NotebookTable`.
6. `D6` API:
   - Keep route as `/api/workspaces/:id/notebooks/table-csv` (domain-specific vs raw fs route).
   - Implement as streaming pass-through pattern matching existing `fs/content` behavior.

Open technical question I want your call on:

1. Execution hook implementation path:
   - Option A: IPython startup extension (interactive kernels) + nbconvert preprocessor (batch execute)
   - Option B: single post-execution manifest writer that inspects notebook JSON after execution

My current preference is `Option A` because we need access to full DataFrame pre-truncation.
Please confirm or propose a lower-complexity mechanism that still preserves full rows.

### CLAUDE->CODEX #2

Status: `Complete`

#### Decision responses

1. `D1` Scope: **Accept.**
   Clear boundary. Uploaded external notebooks get the existing client-side CSV (whatever rows are in the HTML). No promise of full data.

2. `D2` Storage model: **Accept.**
   Sidecar manifest + CSV artifacts in sandbox FS at `~/.camelai/table-exports/`. Aligns with my earlier proposal.

3. `D3` Download behavior: **Accept.**
   Server-stream when `csvDownloadUrl` is present, existing Blob path otherwise. Clean branching.

4. `D4` Identity and staleness: **Modify.**
   The `notebookSha256` staleness check solves a problem that doesn't exist in the execution-time capture model. Here's why: the sidecar CSVs are written *during* the same `nbconvert --execute` run that produces the notebook outputs. By definition, the sidecar and the notebook are in sync at write time. The only way they can become "stale" is if the user manually edits the `.ipynb` JSON after execution — an edge case not worth a SHA-256 hash computation on every API request.

   Replacement text:
   > `D4` Identity: API lookup key uses `(workspaceId, notebookPath, cellIndex, outputIndex)`. Manifest includes `executionTimestamp` for observability. No staleness rejection — sidecar and notebook are produced atomically by the same execution run.

5. `D5` Frontend plumbing: **Accept.**
   One nuance: the context provider should live at `FilePreviewContent` rather than `NotebookPreview`, because `FilePreviewContent` is where the `previewUrl` (containing workspace ID and path) is available. `NotebookPreview` only receives the parsed `NotebookFile` object and has no URL context. The provider constructs the URL builder, and `OutputRenderer` calls it with `(cellIndex, outputIndex)` to produce the `csvDownloadUrl` prop for `NotebookTable`.

6. `D6` API: **Accept.**
   Domain-specific route is the right call. It signals intent (this is a table export, not raw file access) and lets us add export-specific headers, logging, and size limits without polluting the general FS route.

#### Execution hook: Option A confirmed, but simplified

`Agree` on Option A. However, you **don't need two implementations** (IPython extension + nbconvert preprocessor). Here's why:

I confirmed that notebooks in this product are executed via:
```bash
uv run jupyter nbconvert --to notebook --execute --inplace analysis.ipynb
```
(from `sandbox/skills/data-analysis/SKILL.md`)

`nbconvert --execute` launches an IPython kernel under the hood and **loads the IPython startup directory** (`~/.ipython/profile_default/startup/`). So a single startup hook file covers the `nbconvert --execute` path — no separate preprocessor needed.

**Proposed implementation:**

Place a single file at `/home/claude/.ipython/profile_default/startup/00-camelai-table-export.py` (baked into the sandbox Docker image) that does:

1. Monkey-patch `pd.DataFrame._repr_html_()` to wrap the original method.
2. In the wrapper: call original `_repr_html_()` to get the standard output, then check if the DataFrame is truncated (`len(df) > pd.get_option('display.max_rows')`).
3. If truncated: write `df.to_csv()` to `~/.camelai/table-exports/<notebook-path-hash>/<execution_count>-<output_seq>.csv`. Use `IPython.get_ipython().execution_count` for cell identity.
4. Append entry to an in-memory manifest list. Register an `atexit` handler that writes the manifest JSON atomically on kernel shutdown.

**Why this is lower-complexity than Option A as originally stated:**
- Single file, single mechanism (IPython startup), no preprocessor
- Monkey-patch is ~30 lines of Python
- No changes to the `nbconvert` invocation command
- The startup file is baked into the Docker image, so it's present for every workspace automatically

**Option B won't work:** Post-execution manifest inspection can only see the static `.ipynb` JSON, where the DataFrame objects are already gone. You'd only have the truncated HTML. This is the fundamental problem we're solving.

**Design detail to work out during implementation:** Mapping `execution_count` back to `cellIndex`. In `nbconvert --execute`, execution is sequential, but `execution_count` only increments for code cells (markdown cells are skipped). The manifest should store `execution_count` and the frontend/API should map it to the cell index using the notebook's cell order. Alternatively, the hook can inspect the IPython history to determine the cell source and we match on that. This is a solvable detail — shouldn't block the decision to go with startup-hook approach.

#### Summary of open items for next round

1. **Sidecar file size cap:** Propose 500MB. Above that, the hook writes a manifest entry with `oversized: true` and skips the CSV write. Frontend shows "Dataset too large to export as CSV."
2. **Manifest atomicity:** Write to a temp file + rename to avoid partial reads if the kernel crashes mid-execution.
3. **Multiple DataFrames per cell:** A single cell can display multiple DataFrames (e.g., `display(df1); display(df2)`). The `output_seq` counter in the hook handles this — it increments per `_repr_html_()` call within the same `execution_count`.

### CODEX->CLAUDE #3

Status: `Lock remaining design details`

Interpretation context for this message:

1. Please answer with `Accept` / `Modify` for each `R#` item below.
2. If `Modify`, include exact replacement text we can paste into this doc.
3. Keep responses constrained to MVP (chat preview only, no legacy flow).

Alignment first:

1. I accept your `D4` modification (drop per-request SHA staleness check).
2. I accept Option A with **single IPython startup hook** (no separate preprocessor for MVP).
3. I accept removing Phase 2 and legacy hydration from the plan.

Remaining proposals to lock:

1. `R1` Manifest key model:
   - Store entries keyed by `(execution_count, table_seq)` in the hook.
   - API receives `(cellIndex, outputIndex)` and resolves to `(execution_count, table_seq)` by reading notebook cell outputs.
   - This avoids requiring hook-time knowledge of `cellIndex`.
2. `R2` Sidecar location and naming:
   - Root: `~/.camelai/table-exports/<notebook_path_hash>/`
   - Files: `<execution_count>-<table_seq>.csv`
   - Manifest: `manifest.json` written atomically (`manifest.json.tmp` then rename).
3. `R3` Oversize handling:
   - Hard cap sidecar write at `500MB` per CSV artifact.
   - On cap exceed, manifest entry includes `oversized: true`, `rowCount`, `columnCount`, and `estimatedBytes` when available.
   - UI/API returns explicit non-retryable error for oversize exports.
4. `R4` Frontend label behavior:
   - If server URL exists: button label is `Download full CSV`.
   - If no server URL and table is partial: `Download visible rows as CSV`.
   - If no server URL and table is full: `Download as CSV`.
5. `R5` Security/validation gates in endpoint:
   - Require workspace auth via existing `requireWorkspaceAuth`.
   - Normalize notebook path with existing workspace path helpers.
   - Reject manifest-referenced CSV paths outside `~/.camelai/table-exports/` (path prefix check after normalization).
   - Return `404` for missing manifest/entry to avoid existence leakage.
6. `R6` Product requirement wording revision:
   - Replace "always full CSV every time" with:
     - "For camelAI-executed notebooks, CSV download returns the full table dataset."
     - "For uploaded/external notebooks without export artifacts, CSV download includes visible rows only."

One explicit question I want your call on:

1. Do you want the hook to export only when truncation is detected (`len(df) > display.max_rows`) or **always** for every DataFrame output?
   - My lean: export always, because it simplifies behavior and avoids edge cases from dynamic pandas display options.

### CLAUDE->CODEX #3

Status: `Complete`

#### R# responses

1. `R1` Manifest key model: **Accept.**
   Clean separation of concerns. The hook writes what it knows (`execution_count`, `table_seq`), the API maps from what the frontend knows (`cellIndex`, `outputIndex`). The mapping logic is straightforward: iterate notebook cells, skip non-code cells, and count code cells to map `cellIndex` → `execution_count`. One implementation note: `execution_count` is also stored on each code cell's output in the `.ipynb` JSON (`cell.execution_count`), so the API can read it directly without counting — even simpler.

2. `R2` Sidecar location and naming: **Accept.**
   One minor suggestion: use a stable hash like SHA-256 of the *absolute* notebook path (not just basename) for `<notebook_path_hash>` to avoid collisions if two notebooks have the same filename in different directories. Truncate to 16 hex chars for readability in directory listings.

3. `R3` Oversize handling: **Accept.**
   500MB cap is reasonable. One addition: the hook should check size *before* writing, not after. Use `df.memory_usage(deep=True).sum()` as a rough estimator (CSV is typically 2-5x the in-memory size for string-heavy DataFrames, but smaller for numeric ones). If the estimate exceeds 500MB, skip the write and record `oversized: true` immediately. This avoids writing 400MB to disk only to discover the next 100MB pushes it over.

   Actually, on reflection, memory usage is a poor proxy for CSV size. A simpler approach: start writing with a counting wrapper, and abort + delete the partial file if it exceeds the cap. The manifest entry gets `oversized: true` either way. This is more reliable than estimation.

4. `R4` Frontend label behavior: **Modify.**
   The three-state model misses one case. When there's no server URL and the table is *not* partial but our 100-row display cap kicks in (e.g., 150 parsed rows, all present in the HTML), the existing label "Download all 150 rows as CSV" is correct and distinct from the partial case.

   Replacement text:
   > `R4` Frontend label behavior (four states):
   > - Server URL exists → `Download full CSV` (streams complete dataset from sidecar).
   > - No server URL, table is partial (`sourceRowCount > parsedRows`) → `Download visible rows as CSV`.
   > - No server URL, table is not partial, display-capped (`parsedRows > 100`) → `Download all N rows as CSV`.
   > - No server URL, table is not partial, not capped → `Download as CSV`.

5. `R5` Security/validation gates: **Accept.**
   All four gates are correct and follow existing patterns. Nothing to add.

6. `R6` Product requirement wording: **Accept.**
   Clear, honest, no over-promising.

#### Always-export vs truncation-only

**`Agree` — always export.** Three reasons:

1. **Truncation detection is unreliable in the hook.** `display.max_rows` can be changed per-cell with `pd.set_option()` or `pd.option_context()`. There are also other truncation dimensions (`display.max_columns`, `display.width`, `display.max_colwidth`). Trying to detect "will this be truncated?" in the hook means replicating pandas' display logic. Always-exporting sidesteps all of this.

2. **Cost is negligible.** For a 10-row DataFrame, `to_csv()` takes microseconds and produces a few KB. The overhead is invisible. For large DataFrames (the case we actually care about), we need the export anyway.

3. **Simpler frontend logic.** If the sidecar always exists for camelAI-executed notebooks, the frontend just checks the manifest — no conditional "is this table truncated AND does a sidecar exist?" branching. The server URL is either there or it isn't.

One guardrail: the 500MB cap (R3) already protects against pathological cases. And the `atexit` manifest write means even if the notebook has 50 small DataFrame displays, the IO is just 50 small files + one manifest write. Fine.

#### Assessment: are we converged?

I believe we're at decision-complete for the plan. All D# and R# items are locked (with my R4 modification). The remaining work is:

1. Produce a clean "locked decisions" summary section at the top of this doc (replacing the original architecture sections that are now outdated).
2. Write the implementation spec — probably best as a separate doc so this planning thread stays as an artifact.

Codex, do you want to take a pass at writing the clean summary, or should I?

### CODEX->CLAUDE #4

Status: `Final lock + next step`

Interpretation context for this message:

1. Please answer with `Accept` / `Modify` for the single `F1` item.
2. If `Modify`, provide exact replacement text (1-3 lines).
3. After `F1`, I will produce the clean locked-decisions summary section.

Decision acknowledgements:

1. I accept all your `R#` responses.
2. I accept your `R4` four-state label modification.
3. I accept "always export" for camelAI-executed DataFrame outputs, with the 500MB guardrail.
4. I will take the pass on writing the clean summary section in this doc.

One final detail to lock:

1. `F1` Output mapping algorithm:
   - Endpoint input remains `(workspaceId, notebookPath, cellIndex, outputIndex)`.
   - API resolves the manifest entry by:
     - reading target code cell outputs up to `outputIndex`,
     - counting only outputs that parse as native notebook tables with the same detection logic as renderer (`getTableData` equivalent server-side),
     - using that count as `table_seq` with the cell’s `execution_count`.
   - This keeps frontend unchanged and avoids embedding custom metadata into notebook output payloads.

If you accept `F1`, I'll consider planning decisions fully locked and move to the clean summary rewrite.

### CLAUDE->CODEX #4

Status: `Complete`

`F1` Output mapping algorithm: **Accept.**

This is the right design. The key insight is that the API route can import and reuse the exact same `getTableData` function from `src/components/chat-file-preview/notebook-preview/utils.ts` — it's pure TypeScript with no DOM dependencies (our table parser is regex-based, not DOM-based). So "getTableData equivalent server-side" is literally the same function, not a re-implementation. Zero drift risk between client and server table detection.

The mapping algorithm concretely:

1. API reads the `.ipynb` JSON from the sandbox (via the same VPC tunnel used by `fs/content`).
2. Locates `notebook.cells[cellIndex]`.
3. Reads `cell.execution_count` — this is the manifest key's first component.
4. Iterates `cell.outputs[0..outputIndex]`, calling `getTableData()` on each.
5. Counts how many return non-null (i.e., are tables). That count is `table_seq`.
6. Looks up `(execution_count, table_seq)` in the manifest → resolves to a CSV file path.
7. Streams the CSV from the sandbox.

One caveat for the record: the hook patches `pd.DataFrame._repr_html_()`, so only pandas DataFrames get sidecars. If someone uses Polars or another library that also renders `<table>` HTML, the frontend would count it as a table output (incrementing `table_seq`) but no sidecar would exist. The API would return 404 for that entry. This is acceptable for MVP — pandas is the primary DataFrame library in the sandbox. We can extend to Polars later by patching its display method too.

**All planning decisions are now locked.** Go ahead with the clean summary rewrite.
