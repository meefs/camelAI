# Notebook Full CSV Export Plan (Locked)

Date locked: 2026-02-20

Reference sample notebook: `/Users/illiana/Downloads/dmg-queries.ipynb`  
Thread archive: `docs/notebook-full-csv-export-thread.md`

## 1) Requirement (final wording)

1. For camelAI-executed notebooks, CSV download returns the full table dataset.
2. For uploaded/external notebooks without export artifacts, CSV download includes visible rows only.

## 2) Scope

In scope (MVP):

1. Chat preview notebook renderer only.
2. New notebooks executed in camelAI after rollout.
3. Pandas DataFrame table outputs.

Out of scope (MVP):

1. Legacy hydration/"prepare full CSV" jobs.
2. Published renderer path.
3. Non-pandas table producers (for example Polars) unless explicitly added later.

## 3) Locked Decisions

1. Storage model:
   - Sidecar CSV artifacts + sidecar manifest in sandbox workspace storage.
   - Root path: `~/.camelai/table-exports/<notebook_path_hash>/`.
   - `notebook_path_hash` = SHA-256 of absolute notebook path, truncated to 16 hex chars.

2. Capture model:
   - Always export for pandas DataFrame outputs (not truncation-conditional).
   - Single IPython startup hook baked into sandbox image:
     - `/home/claude/.ipython/profile_default/startup/00-camelai-table-export.py`
   - No separate nbconvert preprocessor in MVP.

3. Artifact limits:
   - Hard cap: `500MB` per CSV artifact.
   - Write with counting wrapper; if cap exceeded, abort + delete partial file.
   - Manifest records `oversized: true` so UI/API return non-retryable oversize message.

4. Manifest keying:
   - Hook keys entries by `(execution_count, table_seq)`.
   - Filename format: `<execution_count>-<table_seq>.csv`.
   - Manifest written atomically (`manifest.json.tmp` then rename).

5. API route:
   - `GET /api/workspaces/:id/notebooks/table-csv`
   - Domain-specific endpoint (not raw fs/content route).
   - Streaming pass-through behavior (no full buffering).

6. Output mapping algorithm (`F1`):
   - Endpoint input remains `(workspaceId, notebookPath, cellIndex, outputIndex)`.
   - API reads target cell, gets `cell.execution_count`.
   - API scans outputs `0..outputIndex`, counting outputs that parse as native notebook tables.
   - That count is `table_seq`; lookup `(execution_count, table_seq)` in manifest.
   - Reuse same table detection logic as renderer to avoid drift.

7. Frontend behavior:
   - If server URL exists: `Download full CSV`.
   - No server URL + partial table (`sourceRowCount > parsedRows`): `Download visible rows as CSV`.
   - No server URL + non-partial + display-capped (`parsedRows > 100`): `Download all N rows as CSV`.
   - No server URL + non-partial + not capped: `Download as CSV`.

8. Security gates:
   - Use existing workspace auth (`requireWorkspaceAuth`).
   - Normalize notebook path with existing workspace path helpers.
   - Enforce resolved CSV path stays under `~/.camelai/table-exports/` after normalization.
   - Return `404` for missing manifest/entry (avoid existence leakage).

## 4) Data Contract (MVP)

Manifest file: `~/.camelai/table-exports/<notebook_path_hash>/manifest.json`

Suggested shape:

```json
{
  "version": 1,
  "executionTimestamp": "2026-02-20T20:00:00.000Z",
  "entries": [
    {
      "execution_count": 7,
      "table_seq": 1,
      "csv_relative_path": "7-1.csv",
      "rowCount": 3122,
      "columnCount": 11,
      "oversized": false,
      "bytes": 1830021
    }
  ]
}
```

Notes:

1. `csv_relative_path` is relative to manifest directory.
2. If oversized, entry may omit `csv_relative_path` and set `oversized: true`.

## 5) Implementation Plan

## Phase A: Runtime capture

1. Add IPython startup hook in sandbox image.
2. Patch pandas DataFrame HTML repr path and persist sidecar CSV + manifest entries.
3. Add atomic manifest write at kernel/process shutdown.
4. Add size-cap enforcement with partial-file cleanup.

## Phase B: Backend endpoint

1. Add route to `src/routes.ts`.
2. Add `src/routes/api/workspaces.$id.notebooks.table-csv.ts`.
3. Implement auth, path normalization, manifest lookup, table-seq resolution, and CSV streaming.
4. Return typed errors for not-found and oversized cases.

## Phase C: Frontend integration

1. Add export URL builder context at `src/components/chat-file-preview/file-preview-content.tsx`.
2. In `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`, build/pass `csvDownloadUrl` for table outputs.
3. In `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`, add four-state label logic and server-download branch.
4. Keep existing in-browser CSV fallback path.

## 6) File Touchpoints

Likely MVP touchpoints:

1. `sandbox` image/runtime startup files for IPython hook.
2. `src/routes.ts`
3. `src/routes/api/workspaces.$id.notebooks.table-csv.ts` (new)
4. `src/components/chat-file-preview/file-preview-content.tsx`
5. `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`
6. `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`
7. `src/components/chat-file-preview/notebook-preview/utils.ts` (shared table detection import/export as needed)

## 7) Testing

Unit:

1. Manifest schema validation and lookup keying.
2. Table-seq mapping from `(cellIndex, outputIndex)`.
3. Four-state label selection logic.

Integration:

1. Endpoint streams CSV for valid manifest entry.
2. Endpoint returns `404` for missing manifest/entry.
3. Endpoint returns oversize error when `oversized: true`.
4. Path-prefix guard blocks manifest path escape.

E2E:

1. camelAI-executed truncated DataFrame notebook downloads full CSV.
2. Uploaded external notebook without sidecar shows/exports visible rows only.

## 8) Rollout Success Criteria

1. Full CSV downloads available for camelAI-executed pandas table outputs in chat preview.
2. No regression to existing visible-rows fallback behavior.
3. No auth/path traversal regressions in new endpoint.
