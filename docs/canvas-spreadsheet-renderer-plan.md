# Canvas-Based Spreadsheet Renderer — Port from Acon

## Goal

Port the custom HTML5-canvas-based CSV/Excel renderer from
`/Users/illiana/Projects/acon-desktop-app` into this repo, replacing the current
DOM-table-based `SpreadsheetPreview` used in chat file previews. The new
renderer should handle `.csv`, `.tsv`, `.xlsx`, and `.xls`, support multi-sheet
Excel workbooks, render embedded/inferred charts, and feel consistent with the
rest of this codebase (shadcn/ui chrome, Tailwind v4 theme tokens, dark mode).

## What today looks like vs. what we want

```
TODAY                                          AFTER PORT
─────────────────────────────────────         ──────────────────────────────────
File preview dispatcher                        File preview dispatcher
  └─ SpreadsheetPreview                          └─ SpreadsheetPreview (new)
       ├─ CSV/TSV only                                ├─ CSV / TSV / XLSX / XLS
       ├─ DOM <table>                                 ├─ HTML5 canvas surface
       ├─ NotebookTable (compact)                     ├─ Sheet tabs (Excel)
       └─ TableViewer (full-screen)                   ├─ Charts surface
            (sort, filter, resize)                    ├─ Formula bar + selection
                                                      ├─ Copy as TSV
                                                      ├─ Column resize, pan,
                                                      │   keyboard nav
                                                      └─ Cell colours / merges
                                                          from .xlsx metadata

xlsx/xls → "No preview available"              xlsx/xls → first-class viewer
```

## Renderer architecture (target)

```
SpreadsheetPreview (props: content, filename, contentType, layout)
   │
   │  parseSpreadsheetWorkbook(content, filename, contentType)
   │    ├─ delimited → parseDelimitedWorkbook  (hand-rolled CSV parser)
   │    └─ binary    → parseExcelWorkbook      (xlsx.read + style/merge/chart)
   ▼
SpreadsheetWorkbook { sheets[], charts[], kind }
   │
   ├──> [shadcn] Tabs ───────── sheet selector  (only if sheets.length > 1)
   ├──> [shadcn] ToggleGroup ── data | charts surface switch (only if charts)
   ├──> Formula bar ─────────── [Badge "B5"] [Input readOnly value/formula]
   │
   └──> SpreadsheetCanvasSurface
            ┌──────────────────────────────────────────────┐
            │  ScrollContainer (overflow-auto)              │
            │  ┌────────────────────────────────────────┐  │
            │  │  Sizer <div style={width,height}>       │  │ ← real scroll size
            │  │                                          │  │
            │  │  Canvas (sticky, viewport-sized)         │  │ ← repaints on
            │  │     - column headers (A, B, C…)          │  │   scroll/resize
            │  │     - row index column (1, 2, 3…)        │  │
            │  │     - cells (alt-row bg, cell colours)   │  │
            │  │     - merged cells                        │  │
            │  │     - selection overlay                   │  │
            │  │                                          │  │
            │  │  Pointer overlay <div>                   │  │ ← captures input
            │  │     - cell hit-test                       │  │   (canvas is
            │  │     - drag selection                      │  │   pointer:none)
            │  │     - column-resize handles               │  │
            │  │     - space+drag pan                      │  │
            │  └────────────────────────────────────────┘  │
            └──────────────────────────────────────────────┘
            [shadcn] ContextMenu (right-click copy)

SpreadsheetChartsSurface (charts surface only)
   └─ SpreadsheetChartGraphic ─── SVG bar / line / pie / doughnut
```

Canvas does the heavy data drawing; React + shadcn handle the chrome.

## Acon implementation summary (source of truth)

Location in acon repo:
- `src/components/chat-file-preview/spreadsheet-preview.tsx` — single 2,572-line file with everything (parsing + canvas surface + charts + types).
- `src/components/chat-file-preview/file-type-utils.ts` — file-type detection (very close to ours; mostly `getPreviewType` differs).
- `src/components/chat-file-preview/file-preview-content.tsx` — dispatches to `SpreadsheetPreview`, passes `string | ArrayBuffer`.
- `tests/spreadsheet-preview.test.tsx` — covers keyboard nav, copy, pan, charts.

Key facts the implementing agent should know:
- **Single npm dep** added: `xlsx` (v0.18.5). Used for both `.xlsx` and `.xls` parsing, plus pulling out cell styles, merges, row heights, column widths, formulas, embedded charts.
- **Limits:** `MAX_SHEET_ROWS = 2000`, `MAX_SHEET_COLUMNS = 120`. Sheets larger than this are trimmed and `wasTrimmed` is flagged so the UI can warn.
- **Virtualization:** rows are virtualized via a precomputed `rowOffsets` array; only visible rows are drawn to canvas each frame. Columns are clipped per-cell.
- **Row classification:** `detectWorkbookRowKinds` heuristically marks rows as `'title' | 'header' | 'body'` to apply distinct styling.
- **Cell styling from Excel:** background colour (from `cell.s.fgColor.rgb`), text colour auto-chosen by WCAG luminance, alignment derived from cell type (`n`/`d` → right, `b` → center).
- **Selection:** `{ anchorRow, anchorCol, focusRow, focusCol }`. Click to set, shift+click or shift+arrow to extend, drag to select range. Copy emits TSV (`\t` between cells, `\n` between rows).
- **Pan:** hold Space + drag to pan the viewport (cursor → grab/grabbing).
- **Column resize:** drag handle on column-header divider, clamps to `[88, 320]`, persisted in component state per sheet.
- **Charts:**
  - Embedded charts come from the OOXML (`workbook.files`) via `extractEmbeddedChartsFromWorkbookFiles` — parses `<barChart>`, `<lineChart>`, `<pieChart>`, `<doughnutChart>`.
  - If none are embedded, `inferWorkbookCharts` synthesizes simple charts from numeric columns.
  - Charts render as **SVG**, not canvas. Tooltip on hover, legend with colored dots.
- **No inline editing.** Formula bar is read-only.

## Current state in this repo (what we replace)

- `src/components/chat-file-preview/spreadsheet-preview.tsx` (128 lines): handrolled CSV parser → renders `NotebookTable` inline, `TableViewer` in a full-screen dialog. **Gets entirely rewritten** — preserve the export name and prop shape, but the internals change.
- `src/components/chat-file-preview/file-type-utils.ts`: `SPREADSHEET_EXTENSIONS` already includes `xlsx`/`xls`, but `getPreviewType` shunts them to `'other'`. **Edit `getPreviewType`** to return `'spreadsheet'` for xlsx/xls.
- `src/components/chat-file-preview/file-preview-content.tsx`: only fetches as text. **Edit** to fetch binary spreadsheets as `ArrayBuffer` and pass through to `SpreadsheetPreview`.
- `notebook-preview/notebook-table.tsx` and `notebook-preview/table-viewer.tsx`: **leave alone.** They are still used by notebook output renderers (DataFrame outputs etc.), which is a different surface from CSV/Excel file previews.

## File-by-file work plan

### 1. Add dependency
```bash
bun add xlsx@0.18.5
```
Confirm it lands in `package.json` `dependencies` (not devDependencies).

### 2. New files (split the acon monolith for readability)

Create under `src/components/chat-file-preview/spreadsheet/`:

| File | Responsibility |
|---|---|
| `index.ts` | Re-export `SpreadsheetPreview` for the dispatcher |
| `types.ts` | `SpreadsheetWorkbook`, `SpreadsheetSheet`, `SpreadsheetCell`, `SpreadsheetMerge`, `SpreadsheetChart`, `SpreadsheetSelection` (lift verbatim from acon) |
| `constants.ts` | `INDEX_COLUMN_WIDTH`, `HEADER_ROW_HEIGHT`, `DEFAULT_ROW_HEIGHT`, `MIN_COLUMN_WIDTH`, `MAX_COLUMN_WIDTH = 320`, `MAX_SHEET_ROWS`, `MAX_SHEET_COLUMNS`, `CHART_COLORS`, plus the **theme token map** (see Theming section) |
| `parse-delimited.ts` | `parseDelimitedWorkbook`, `parseDelimitedRows`, `getSpreadsheetDelimiter` (port verbatim) |
| `parse-excel.ts` | `parseExcelWorkbook`, `parseWorkbookSheet`, `stringifyCellValue`, `detectCellAlignment`, `normalizeHexColor`, `getForegroundForBackground`, row-kind detection, column-width auto-sizing |
| `parse-charts.ts` | `extractEmbeddedChartsFromWorkbookFiles`, `inferWorkbookCharts`, OOXML chart helpers (`getCachePoints`, `getSeriesName`, etc.) |
| `parse-workbook.ts` | Top-level `parseSpreadsheetWorkbook(content, filename, contentType)` that dispatches to delimited vs excel based on extension/MIME |
| `canvas-surface.tsx` | `SpreadsheetCanvasSurface` — viewport, scroll/resize observation, draw loop, pointer/keyboard handlers, formula bar, sheet tabs, copy button |
| `chart-surface.tsx` | `SpreadsheetChartsSurface`, `SpreadsheetChartWorkspace`, `SpreadsheetChartGraphic` (SVG charts) |
| `spreadsheet-preview.tsx` | New top-level `SpreadsheetPreview` — parses workbook, renders empty state, delegates to `SpreadsheetCanvasSurface` |
| `utils.ts` | `toColumnLabel`, `findRowIndexAtPosition`, `getRowTop`, `getSelectionBounds`, `getSelectionFrame`, `clamp`, `buildClipboardText`, `getCellValue` |

> Keeping the split shallow (one feature per file, no nested folders) makes the diff easy to review and the canvas-surface file still readable. The single biggest file (`canvas-surface.tsx`) will land around ~1100 LOC; the rest are well under 500.

### 3. Replace existing `spreadsheet-preview.tsx`

Delete the body of `src/components/chat-file-preview/spreadsheet-preview.tsx`
and replace with a one-liner re-export so any other importer still works:

```ts
export { SpreadsheetPreview, getSpreadsheetDelimiter } from './spreadsheet';
export type { SpreadsheetPreviewProps } from './spreadsheet';
```

(Search for other importers of `getSpreadsheetDelimiter`/`parseDelimitedTable`
before deleting them; if `parseDelimitedTable` is referenced anywhere outside
this module, keep a thin compat shim that wraps `parseDelimitedWorkbook`.)

### 4. Update `file-type-utils.ts`

`getPreviewType` currently does:
```ts
if (isDelimitedSpreadsheet) return 'spreadsheet';
if (category === 'spreadsheet') return 'other';
```
Change to:
```ts
if (category === 'spreadsheet') return 'spreadsheet';
```
(The `isDelimitedSpreadsheet` short-circuit becomes redundant — remove it.)

### 5. Update `file-preview-content.tsx`

Today the spreadsheet branch does `response.text()` and passes a string. After
the change, binary spreadsheet types must be read as `ArrayBuffer`.

Concretely:

- Add a helper `isBinarySpreadsheet(filename, contentType)` that returns true
  for `.xlsx`/`.xls` or matching MIME (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel`, `application/vnd.ms-excel.sheet.binary.macroEnabled.12`, etc.). Live alongside `getPreviewType`.
- Add a parallel state to `textPreview`: `spreadsheetBinary: ArrayBuffer | null`.
- In the `useEffect` fetch:
  - If `previewType === 'spreadsheet'` AND `isBinarySpreadsheet`, call `response.arrayBuffer()` and store it in `spreadsheetBinary`. Skip the text-line truncation path; binary parsers manage their own limits.
  - If delimited, keep current behaviour (truncate to 500 lines, store as text).
- In the render branch for `'spreadsheet'`, pass either the `ArrayBuffer` or the `string` to the new `SpreadsheetPreview`. The component handles both.
- Drop the `MAX_SPREADSHEET_LINES` truncation badge for binary files (they have their own `wasTrimmed` UI inside the canvas surface).

### 6. Tests

Port `tests/spreadsheet-preview.test.tsx` from acon, then adjust:
- This repo uses Vitest already (see `bun run test`). Acon's test setup is the same shape; copy the test file and update import paths.
- Add a fixture for an `.xls` (binary) and one delimited CSV with quoted commas.
- Add a test for the new `getPreviewType` behaviour: `xlsx`/`xls` resolve to `'spreadsheet'`.
- Add a test for `file-preview-content.tsx`'s binary-vs-text fetch branching (mock fetch, assert `arrayBuffer()` is called for `.xlsx`).

### 7. Bundle-size — lazy-load the renderer

`xlsx@0.18.5` is sizeable (~700KB minified). **Code-split it.**

In `file-preview-content.tsx`, replace the static import with:

```ts
const SpreadsheetPreview = lazy(() =>
  import('./spreadsheet').then((m) => ({ default: m.SpreadsheetPreview }))
);
```

Wrap the spreadsheet branch in `<Suspense>` with the same `Loader2` fallback
the file already uses for media (`<Loader2 className="h-6 w-6 animate-spin
text-muted-foreground" />`). React Router framework mode is fine with this —
the preview already renders inside a client island.

> Note: acon does **not** lazy-load this — it ships `SpreadsheetPreview` and
> `xlsx` in the main bundle. That's appropriate in an Electron app (no
> network cost, single user, big binary anyway), but not for a web app where
> ~700KB on the critical path matters for users who never open a spreadsheet.
> This is a deliberate departure from acon, not an oversight.

After implementing, run `bun run build` and confirm `xlsx` lands in its own
chunk and is not in the entry chunk.

## Theming

Use the existing design-system tokens; dark mode must work.

Acon hardcodes a beige/brown palette directly in the component. Map each
constant to the equivalent token in this repo's theme:

| Acon constant | Hex | Maps to |
|---|---|---|
| `PREVIEW_SHELL_CLASS` background | `#fbfaf7` | `bg-card` |
| `PREVIEW_PANEL_CLASS` background | `#f4f0e5` | `bg-muted` |
| `PREVIEW_SUBTLE_PANEL_CLASS` | `#f0ece2` | `bg-muted/60` |
| `PREVIEW_CHIP_CLASS` | `#efe8d6` | `bg-accent` |
| `PREVIEW_INPUT_CLASS` | `#ffffff` | `bg-background` |
| `PREVIEW_TEXT_CLASS` | `#221b12` | `text-foreground` |
| `PREVIEW_MUTED_TEXT_CLASS` | `#6b5f49` | `text-muted-foreground` |
| `PREVIEW_SOFT_MUTED_TEXT_CLASS` | `#7a6a50` | `text-muted-foreground/80` |

That handles the React/Tailwind chrome. The harder part is the **canvas
itself** — `context.fillStyle = '#ffffff'` etc. are written into the draw
loop. We need those colours to come from CSS so dark mode works.

**Approach:** in `canvas-surface.tsx`, read theme colours from CSS variables at
draw time:

```ts
function readCanvasTheme(canvas: HTMLCanvasElement) {
  const styles = getComputedStyle(canvas);
  const oklchToRgba = (raw: string) => /* tiny helper, see note below */;
  return {
    background:        oklchToRgba(styles.getPropertyValue('--background')),
    cellBgEven:        oklchToRgba(styles.getPropertyValue('--card')),
    cellBgOdd:         oklchToRgba(styles.getPropertyValue('--muted')),
    headerBg:          oklchToRgba(styles.getPropertyValue('--accent')),
    titleRowBg:        oklchToRgba(styles.getPropertyValue('--secondary')),
    text:              oklchToRgba(styles.getPropertyValue('--foreground')),
    mutedText:         oklchToRgba(styles.getPropertyValue('--muted-foreground')),
    border:            oklchToRgba(styles.getPropertyValue('--border')),
    selectionFill:     'rgba(59, 130, 246, 0.10)',  // chart-1 blue tint
    selectionStroke:   oklchToRgba(styles.getPropertyValue('--ring')),
  };
}
```

A few notes on this:

- This repo uses **OKLCH** colours (e.g. `oklch(0.141 0.005 285.823)`). Canvas
  2D's `fillStyle` accepts OKLCH in modern browsers, so the simplest path is to
  pass the raw `oklch(...)` string straight to `fillStyle` without conversion.
  Verify in the dev browser before adding any conversion shim. If support is
  spotty, use a tiny `oklch → rgb` helper (the implementing agent can write a
  ~30-line one or pull `culori`'s `formatRgb`, but adding a dep just for this
  is overkill).
- Read the theme **inside the draw effect**, not at module load, so it picks up
  dark-mode toggles (the effect already reruns on viewport changes; add a
  `useEffect` that listens for `matchMedia('(prefers-color-scheme: dark)')`
  changes and increments a `themeRev` counter that the draw effect depends on).
- **Cell colours from Excel** (`cell.backgroundColor`) should still be honoured
  verbatim — those are user-authored data, not theme colours. Only the
  un-styled "default" colours come from the theme.
- **Chart colours** (`CHART_COLORS = ['#2563EB', ...]`): replace with the
  existing chart palette `--chart-1` … `--chart-5` for consistency with the
  rest of the app.

If the theme-from-CSS-vars approach turns out to be flaky in practice (e.g.
contrast issues against Excel-supplied cell colours), fallback is to define a
small set of canvas-specific tokens in `globals.css` (`--canvas-cell-bg-odd`,
etc.) so designers can tune them independently. Don't add those preemptively.

## shadcn component mapping for the chrome

The acon version uses raw Tailwind for everything. Replace with installed
shadcn primitives where appropriate — none of these need to be added; verify
each is already in `src/components/ui/` (per the exploration: all are).

| UI element | shadcn component | Notes |
|---|---|---|
| Sheet selector tabs | `Tabs` (`tabs.tsx`) | Only render if `workbook.sheets.length > 1`. `value={activeSheetIndex}`, scrollable horizontally for many sheets. |
| Data ↔ Charts switcher | `ToggleGroup` (`toggle-group.tsx`, single-select) | Only if `workbook.charts.length > 0`. Two items: "Data", "Charts". |
| Copy button | `Button` (`button.tsx`, `variant="ghost" size="sm"`) | Use `lucide-react` `Copy` icon. Briefly swap to `Check` icon after copy (acon does this with a `copied` state). |
| Selected-cell label ("B5") | `Badge` (`badge.tsx`, `variant="secondary"`) | Sits to left of the formula bar. |
| Formula bar | `Input` (`input.tsx`, `readOnly`) | `font-mono`, full width. Shows formula prefixed with `=` if `cell.formula` is set, else value. |
| Right-click context menu | `ContextMenu` (`context-menu.tsx`) | Wrap the canvas pointer overlay. One item: "Copy" (with `⌘C` shortcut hint). |
| Truncation warning ("Showing first 2000 rows…") | `Alert` (`alert.tsx`, `variant="default"`) or just a small muted line | Inline, above the canvas, only when `wasTrimmed`. A muted text line is probably enough; reserve `Alert` for harder problems. |
| Chart tooltip | Plain absolutely-positioned `<div>` | shadcn `Tooltip` is for elements; chart tooltips need to follow pointer position over SVG. Keep it custom but style to match (`bg-popover text-popover-foreground border rounded-md shadow-md text-xs`). |
| Empty / parse-error state | Match the existing dispatcher's "Unable to preview this file." pattern from `file-preview-content.tsx` | Don't introduce a new component. |

For panel vs dialog layout (`layout` prop), keep the acon behaviour: same
component, just adjust max-height/padding via `cn()` like the existing code
already does.

## Behaviour checklist

The implementing agent should verify each of these by hand in a browser:

- [ ] `.csv` with quoted fields containing commas renders correctly.
- [ ] `.tsv` is detected and uses tab delimiter.
- [ ] `.xlsx` with multiple sheets renders sheet tabs and switches between them.
- [ ] `.xlsx` with merged cells renders the merge as a single cell spanning rows/cols.
- [ ] `.xlsx` cell background colours are preserved on canvas; text colour auto-flips for contrast.
- [ ] `.xlsx` with formulas shows `=SUM(...)` in formula bar when cell is selected.
- [ ] Click selects a cell; shift+arrow extends the selection range.
- [ ] `Cmd/Ctrl+C` copies the selection to clipboard as TSV.
- [ ] Right-click shows a "Copy" context menu.
- [ ] Hold Space + drag pans the viewport; cursor changes to grab.
- [ ] Column resize handle on header divider works; widths persist per sheet (within the component lifetime).
- [ ] Scrolling stays smooth on a 2000-row sheet (virtualization works).
- [ ] An `.xlsx` with an embedded chart shows the "Charts" toggle and renders bar/line/pie/doughnut as appropriate.
- [ ] An `.xlsx` with no embedded chart but obvious tabular numeric data still produces an inferred chart.
- [ ] Sheet exceeding the row/column cap renders a "Showing first N rows" notice.
- [ ] Dark mode: theme colours flip; canvas re-renders within one frame of the theme change.
- [ ] Existing `NotebookTable` / `TableViewer` usages in notebook output renderers are unaffected (regression check — open a notebook with a `.head()` table output).

## Test plan (commands)

```bash
bun run typecheck                      # must pass
bun run test:run -- spreadsheet        # ported unit tests
bun run lint                           # no new violations
bun run dev                            # manual checklist above
```

No worker, sandbox, or e2e changes are needed for this work.

## Out of scope

- **Computer tab integration.** The computer tab today only opens text files in
  Monaco; CSV/Excel files don't get a viewer. The new `SpreadsheetPreview` is
  designed as a self-contained component that takes `(content, filename,
  contentType, layout)`, so wiring it into the computer tab later is in
  principle just "fetch the file, mount the component". The reason it's out
  of scope **for this PR** is the surrounding work, not the component itself:
  the computer tab currently has no file-type dispatcher, no ArrayBuffer
  fetch path, no "this file isn't editable in Monaco, show a preview
  instead" branch, and no design for how the preview coexists with the
  editor's read/write/save UX. That belongs in a focused follow-up PR.
- **Inline cell editing.** Acon's renderer is read-only. Don't add editing.
- **Replacing `NotebookTable` / `TableViewer`** for notebook outputs. Different
  surface, different needs, different scale; leave them in place.
- **Server-side rendering of the canvas.** Not needed — file previews are
  client-rendered.
