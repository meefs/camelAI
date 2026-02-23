# Notebook Fullscreen Modes: Charts & Tables

> Implementation plan for adding fullscreen interactive chart viewing and an enhanced table explorer to the notebook renderer. These features apply to both the in-app chat preview panel and published `*.camelai.app` pages.

---

## Context

Today, notebook charts and tables render inline in a narrow preview panel (~400-600px wide). Charts have tooltips but no zoom/pan. Tables cap at 100 rows with horizontal scroll only. There is no way to see a larger or more interactive view of any output.

### Current output action layout

```
Charts:                                    Tables:
┌──────────────────────────┐               ┌──────────────────────────────────┐
│                          │               │ col_a │ col_b │ col_c │ col_d   │
│     [chart renders       │               │───────┼───────┼───────┼─────────│
│      at panel width]     │               │ val   │ val   │ val   │ val  ▓▓ │ ← h-scroll
│                          │               │ ...   │       │       │      ▓▓ │   + fade
│                          │               ├──────────────────────────────────┤
├──────────────────────────┤               │ Showing 100 of 1,234 rows       │
│               Download ▾ │               │                 Download as CSV │
└──────────────────────────┘               └──────────────────────────────────┘
```

There are no expand, fullscreen, or zoom capabilities anywhere in the output system.

---

## Part 1: Fullscreen Dialog Foundation

### New component: `FullScreenDialog`

A reusable fullscreen overlay built on the existing shadcn `Dialog` (Radix UI). This gives us focus trapping, Escape-to-close, overlay click-to-close, and scroll lock for free.

**File:** `src/components/chat-file-preview/notebook-preview/full-screen-dialog.tsx`

```
┌──────────────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░ backdrop (black/80) ░░░░░░░░░░░░░░░░░░░░░│
│░┌──────────────────────────────────────────────────────────────┐░│
│░│ Header:  [Title]                        [action slots] [✕]  │░│
│░├──────────────────────────────────────────────────────────────┤░│
│░│                                                              │░│
│░│                                                              │░│
│░│                     Children render here                     │░│
│░│                     (full remaining space)                   │░│
│░│                                                              │░│
│░│                                                              │░│
│░└──────────────────────────────────────────────────────────────┘░│
└──────────────────────────────────────────────────────────────────┘
```

**Implementation details:**
- Override the default `DialogContent` classes: use `fixed inset-4 max-w-none translate-x-0 translate-y-0` (4 = 1rem inset from viewport edge, giving a floating-panel feel)
- Entry animation: fade-in + subtle scale (95% -> 100%), matching our existing dialog animation style
- Header: flex row with title on left, close button on right, slot in between for action buttons
- Content area: `flex-1 overflow-hidden` — each consumer handles its own scrolling
- Use the existing `Dialog`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogClose` from `src/components/ui/dialog.tsx` — just override the content sizing classes

**Props:**
```typescript
interface FullScreenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  actions?: React.ReactNode;    // rendered in header between title and close
  children: React.ReactNode;
}
```

---

## Part 2: Chart Fullscreen Mode

### Goal

Let users expand any chart to see it at near-viewport size with full interactivity. For Plotly charts, enable the built-in mode bar (zoom, pan, box select, autoscale, save image).

### Fullscreen chart layout

```
┌──────────────────────────────────────────────────────────────────┐
│░┌──────────────────────────────────────────────────────────────┐░│
│░│ "Revenue by Quarter"                    [Download ▾]    [✕]  │░│
│░├──────────────────────────────────────────────────────────────┤░│
│░│  ┌─── Plotly mode bar (zoom, pan, select, autoscale) ─────┐ │░│
│░│  │                                                         │ │░│
│░│  │                                                         │ │░│
│░│  │                                                         │ │░│
│░│  │           Chart renders at ~95vw × ~85vh                │ │░│
│░│  │           with full interactive tooltips                │ │░│
│░│  │                                                         │ │░│
│░│  │                                                         │ │░│
│░│  │                                                         │ │░│
│░│  │                                                         │ │░│
│░│  └─────────────────────────────────────────────────────────┘ │░│
│░└──────────────────────────────────────────────────────────────┘░│
└──────────────────────────────────────────────────────────────────┘
```

### Changes to existing components

#### `PlotlyChart` — add `showModeBar` prop

**File:** `src/components/chat-file-preview/notebook-preview/plotly-chart.tsx`

- Add optional prop `showModeBar?: boolean` (default: `false`)
- In `buildThemedPlotlyFigure`, instead of hardcoding `displayModeBar: false`, use the prop value
- When mode bar is enabled, also set `modeBarButtonsToRemove: ['sendDataToCloud', 'toggleSpikelines']` to keep it clean
- Everything else stays the same — responsive sizing, theme, etc.

#### `OutputActionBar` — add expand button

**File:** `src/components/chat-file-preview/notebook-preview/output-action-bar.tsx`

Add an expand/maximize button before the Download dropdown:

```
Before:                            After:
            Download ▾                      [⛶] Download ▾
```

- New prop: `onExpand?: () => void`
- Render a button with `Maximize2` icon from lucide-react (the expand arrows icon)
- Button style: same muted text style as the Download button (`text-muted-foreground/70 hover:text-foreground`)
- Only render the expand button when `onExpand` is provided

#### `ChartOutputWithActions` — manage fullscreen state

**File:** `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`

- Add `useState<boolean>(false)` for `isFullScreen`
- Pass `onExpand={() => setIsFullScreen(true)}` to `OutputActionBar`
- When `isFullScreen` is true, render `FullScreenDialog` containing:
  - The same chart component (VegaLiteChart or PlotlyChart)
  - For Plotly: pass `showModeBar={true}`
  - In the header actions slot: render the same `OutputActionBar` download dropdown (without the expand button)
- The fullscreen chart will auto-fill the dialog body. Since both chart types use `width: 'container'` and `ResizeObserver`, they'll resize naturally.

#### Vega-Lite in fullscreen

Vega-Lite charts already use `width: 'container'` and respond to resize. No special handling needed — just re-render in the larger container. Tooltips and interactions carry over automatically.

---

## Part 3: Table Fullscreen Mode — The Data Explorer

### Goal

Transform the basic table into a powerful data exploration tool when expanded. Users can sort, resize columns, search, and toggle text wrapping — all without any new dependencies.

### Fullscreen table layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│░┌──────────────────────────────────────────────────────────────────────┐░│
│░│ "Sales Data"      [🔍 Filter rows...]  [⇄ Wrap] [Download ▾]  [✕]  │░│
│░├──────────────────────────────────────────────────────────────────────┤░│
│░│                                                                      │░│
│░│  ┌─────┬─────────────┬──────────┬─────────────┬──────────┬────────┐  │░│
│░│  │ idx │ Name      ↕ │ Age    ↕ │ City      ↕ │ Score  ↕ │ Grad ↕ │  │░│
│░│  ├─────┼─────────────┼──────────┼─────────────┼──────────┼────────┤  │░│
│░│  │   0 │ Alice       │      25  │ New York    │    95.3  │ A      │  │░│
│░│  │   1 │ Bob         │      30  │ London      │    87.1  │ B+     │  │░│
│░│  │   2 │ Charlie     │      35  │ Tokyo       │    92.8  │ A-     │  │░│
│░│  │   3 │ Diana       │      28  │ Paris       │    91.0  │ A-     │  │░│
│░│  │   4 │ Eve         │      32  │ Berlin      │    88.5  │ B+     │  │░│
│░│  │   · │             │          │             │          │        │  │░│
│░│  │   · │  ← index    │          │             │  right-  │        │  │░│
│░│  │   · │    columns   │          │             │  aligned │        │  │░│
│░│  │     │    sticky    │          │             │  nums    │        │  │░│
│░│  ├─────┴─────────────┴──────────┴─────────────┴──────────┴────────┤  │░│
│░│  │              ↕ resize handles between column headers            │  │░│
│░│  └────────────────────────────────────────────────────────────────┘  │░│
│░│                                                                      │░│
│░│  Showing 500 of 12,345 rows × 6 columns  ·  Sorted by Score (desc)  │░│
│░└──────────────────────────────────────────────────────────────────────┘░│
└──────────────────────────────────────────────────────────────────────────┘
```

### New component: `TableViewer`

**File:** `src/components/chat-file-preview/notebook-preview/table-viewer.tsx`

The enhanced table component used inside `FullScreenDialog`. Accepts a `ParsedTable` and provides all the interactive features. This is a single-file component — all features are straightforward enough to keep in one place.

**Props:**
```typescript
interface TableViewerProps {
  table: ParsedTable;
  title: string;
}
```

### Feature: Column sorting

**How it works:**
- Each non-index column header is clickable
- Click cycles through: unsorted → ascending → descending → unsorted
- Track `sortColumn: number | null` and `sortDirection: 'asc' | 'desc'` in state
- Sort is applied to the rows array before slicing to display limit
- Numeric columns (detected via the existing `isNumeric()` helper) sort numerically; text columns sort with `localeCompare`
- Show sort indicator in the header: `↑` (asc), `↓` (desc), or dim `↕` (unsorted) using lucide `ArrowUp`, `ArrowDown`, `ArrowUpDown` icons at 12px

**Implementation notes:**
- Use `useMemo` to derive `sortedRows` from `table.rows` + sort state
- Sorting is instant for <10k rows. No debouncing needed.
- The status bar at the bottom should show the active sort: "Sorted by Score (desc)"

### Feature: Column resizing

**How it works:**
- Thin drag handles (4px wide) on the right border of each column header
- `onMouseDown` on a handle starts a resize operation
- Track in state: `resizingColumn: number | null`, `columnWidths: Map<number, number>`
- On `mousemove`, update the column width (min 60px, no max)
- On `mouseup`, finish resize
- Apply widths via inline `style={{ width }}` on `<th>` elements and a `<colgroup>` with `<col>` elements for the body
- Cursor changes to `col-resize` during drag
- Default widths are auto (no change from current behavior until user starts resizing)

**Implementation notes:**
- Attach `mousemove`/`mouseup` to `document` during resize (not the handle itself) so dragging beyond the handle still works
- Use `useRef` for the resize state to avoid re-renders on every pixel of movement — batch update via `requestAnimationFrame`
- The drag handle element: `absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/40`

### Feature: Text wrap toggle

**How it works:**
- Toggle button in the fullscreen header toolbar: `WrapText` icon from lucide (or `AlignJustify`)
- Defaults to OFF (cells use `whitespace-nowrap`, current behavior)
- When ON, cells switch to `whitespace-normal break-words` and rows grow in height to accommodate
- State: `textWrap: boolean`
- Button shows active state when wrap is enabled (e.g. `bg-muted` background)

**Implementation note:**
- Apply the class to the `<table>` element so it cascades: `[&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal`

### Feature: Global search / row filter

**How it works:**
- Search input in the fullscreen header: `Input` component with `Search` lucide icon prefix, placeholder "Filter rows..."
- Filters rows where **any cell** in the row contains the search string (case-insensitive)
- Applied AFTER sorting, BEFORE display-limit slicing
- Show count: "42 of 1,234 rows match" in the status bar when a filter is active
- Clear button (X icon) in the input when text is present

**Implementation notes:**
- Use `useMemo` with the search term to derive `filteredRows` from `sortedRows`
- Debounce the search input by 150ms to stay smooth with large datasets (use a simple `setTimeout` pattern)
- The search is a simple `row.some(cell => cell.toLowerCase().includes(term))` — this is fast for <10k rows

### Feature: Sticky index columns

**How it works:**
- In the fullscreen table, index columns (the first `table.indexColumns` columns) get `position: sticky; left: 0; z-index: 1`
- A subtle right border shadow on the last sticky column: `shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]`
- Background color matches the row's background (must be opaque, not transparent) to prevent underlying cells from showing through

**Implementation notes:**
- If `table.indexColumns > 1`, compute cumulative `left` offsets from column widths
- Apply via inline style: `style={{ position: 'sticky', left: cumulativeWidth }}`
- Body cells AND header cells for index columns need sticky positioning

### Feature: Higher row limit

- In the fullscreen `TableViewer`, raise `MAX_DISPLAY_ROWS` from 100 to **500**
- The caption still shows the full count: "Showing 500 of 12,345 rows × 6 columns"
- CSV download still exports ALL parsed rows (unchanged)

### Changes to `NotebookTable`

**File:** `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`

- Add optional prop `onExpand?: () => void`
- When provided, render an expand button in the caption bar (between the caption text and the download button):

```
Before:
  Showing 100 of 1,234 rows × 5 cols                    Download as CSV

After:
  Showing 100 of 1,234 rows × 5 cols          [⛶ Expand]  Download as CSV
```

- Expand button: `Maximize2` icon + "Expand" text, same muted style as the download button
- When clicked, calls `onExpand()`

### Changes to `OutputRenderer`

**File:** `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`

For table outputs:
- Add `useState<boolean>(false)` for `isTableFullScreen`
- Pass `onExpand={() => setIsTableFullScreen(true)}` to `NotebookTable`
- When `isTableFullScreen` is true, render `FullScreenDialog` containing `TableViewer`

---

## Part 4: Spreadsheet Preview Enhancement

### Goal

The same fullscreen table explorer should work for standalone CSV/TSV file previews rendered via `SpreadsheetPreview`.

### Changes to `SpreadsheetPreview`

**File:** `src/components/chat-file-preview/spreadsheet-preview.tsx`

- Add `useState<boolean>(false)` for `isFullScreen`
- Pass `onExpand={() => setIsFullScreen(true)}` to `NotebookTable`
- When `isFullScreen` is true, render `FullScreenDialog` containing `TableViewer`
- Title for the dialog: use the `filename` prop

---

## Part 5: Published Page Compatibility

### Why it works automatically

The published page renderer (`sandbox/create-worker/renderer/main.tsx`) renders `FilePreviewContent` which renders `NotebookPreview` which renders `OutputRenderer`. Since all our changes are within the output rendering pipeline, published pages inherit fullscreen support with zero changes.

### Things to verify

1. The `Dialog` portal renders correctly in the standalone renderer context (it portals to `document.body`, which exists)
2. CDN-loaded chart libraries (Vega, Plotly) work correctly when re-rendered inside the fullscreen dialog (they should — same global state)
3. The fullscreen dialog's `z-index: 50` doesn't conflict with the published page toolbar

---

## Summary: Files to Create / Modify

### New files
| File | Purpose |
|------|---------|
| `src/components/chat-file-preview/notebook-preview/full-screen-dialog.tsx` | Reusable fullscreen dialog overlay |
| `src/components/chat-file-preview/notebook-preview/table-viewer.tsx` | Enhanced table with sort, resize, search, wrap, sticky columns |

### Modified files
| File | Change |
|------|--------|
| `output-renderers.tsx` | Add fullscreen state for charts and tables, render `FullScreenDialog` |
| `output-action-bar.tsx` | Add `onExpand` prop, render expand button |
| `plotly-chart.tsx` | Add `showModeBar` prop |
| `notebook-table.tsx` | Add `onExpand` prop, render expand button in caption bar |
| `spreadsheet-preview.tsx` | Add fullscreen state, render `FullScreenDialog` + `TableViewer` |

### No changes needed
| File | Why |
|------|-----|
| `vega-lite-chart.tsx` | Already responsive via `width: 'container'`, works in any size |
| `file-preview-content.tsx` | Fullscreen is managed below this layer |
| `renderer/main.tsx` | Published pages inherit fullscreen automatically |
| `report-mode.tsx` / `notebook-mode.tsx` | They render `OutputRenderer` which handles fullscreen |

---

## Implementation order

1. **`FullScreenDialog`** — the foundation. Simple component, quick to build and verify.
2. **`PlotlyChart` showModeBar prop** — one-line behavioral change.
3. **`OutputActionBar` expand button** — add the button and `onExpand` prop.
4. **Chart fullscreen wiring** — connect `ChartOutputWithActions` → `FullScreenDialog` → chart re-render.
5. **`TableViewer`** — the big one. Build the enhanced table with all features.
6. **`NotebookTable` expand button** — add the button and `onExpand` prop.
7. **Table fullscreen wiring** — connect `OutputRenderer` → `FullScreenDialog` → `TableViewer`.
8. **`SpreadsheetPreview` fullscreen** — wire up the same pattern for CSV/TSV files.
9. **Test both surfaces** — verify in chat preview panel and published page renderer.

---

## Future possibilities (not in this implementation)

These are ideas for where the table explorer could go next. None are needed now, but they inform the architecture (keep the `TableViewer` extensible):

| Feature | Complexity | Notes |
|---------|-----------|-------|
| **Virtual scrolling** | Medium | Show ALL rows (even 100k+). Needs `@tanstack/react-virtual` (~14kb gzip). Would replace the 500-row cap. |
| **Per-column filter dropdowns** | Medium | Filter icon in each column header, popover with unique values. Needs the shadcn Popover component (not currently installed). |
| **Column reordering** | Medium | Drag column headers to rearrange. Needs careful DnD handling. |
| **Copy selection** | Low | Click+drag to select cells, Ctrl+C to copy. Like a spreadsheet. |
| **Conditional formatting** | Medium | Color-scale numeric columns. Cool for heatmap-style exploration. |
| **Export to Excel** | Low | Use `xlsx` library. Probably overkill when CSV works. |
| **Pivot table mode** | High | Group-by + aggregate. Very powerful but complex UI. |
