# Canvas Spreadsheet Renderer — Round 1 Feedback

The first pass is solid. The parser, canvas draw loop, virtualization, selection
model, copy-as-TSV, dark-mode-aware theme reads, and lazy-loading are all
landed and look right. The feedback below is about polish — making the surface
feel like Excel/Google Sheets, fixing one structural mistake (charts), and
trimming chrome that's eating space.

> Test file used for charts: `/Users/illiana/Downloads/Runway Expenses.xlsx`.
> Multi-tab workbook; some tabs have zero charts, some have 4+; most charts
> are pie charts.

---

## 1. Move the filename out of its own banner row, into the actions row

**Where it lives now:** `src/components/chat-file-preview/spreadsheet/canvas-surface.tsx:951-975` — there's a dedicated header row inside the spreadsheet shell that shows the filename + a subtitle ("Workbook preview" / "Delimited preview" / "Workbook charts") + a Copy button. This row sits *inside* the canvas component.

**The problem:** The filename is already shown in the dialog/popover header at `src/components/chat-file-preview/file-preview-popover.tsx:34-52` (as the `DialogTitle`). The banner inside the canvas duplicates it and burns ~50px of vertical space — Excel/Sheets give you almost the entire viewport for the grid.

**The fix:** Delete the inner filename banner entirely. For the popover case the existing `DialogTitle` is already the file name, so nothing further is needed. For non-popover usages (panel layout), the surrounding chrome already owns the title.

**Inspiration for the visual treatment of identifiers in the actions row** is `src/components/preview-panel/preview-toolbar.tsx:70-131` — the `ClickToCopyUrlBar` chip used for live app URLs. It's a small `font-mono`/`bg-muted/50` chip in the toolbar row. We don't need a one-to-one copy (a filename isn't a link), but the *shape* — a single dense actions row with refresh, download, and a small chip carrying the identifier — is what we should mirror in the popover header.

Concretely:

- Remove the `<div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">…</div>` block from `canvas-surface.tsx`.
- Move the **Copy selection** button into the popover toolbar (`file-preview-popover.tsx`) so the actions row reads: `[Filename chip] [Refresh] [Download] [Copy] [Close]`. The filename chip should be styled like `ClickToCopyUrlBar` (small, `bg-muted/50`, truncates with ellipsis at ~300px). Copy-on-click can copy the file path; not strictly required for v1.
- The Data/Charts toggle and the formula bar stay where they are (those are content, not chrome).

---

## 2. Tighten the grid — too much padding, lines too thick

The grid feels chunky compared to Excel/Sheets. A few specific dials to turn in `src/components/chat-file-preview/spreadsheet/constants.ts` and the draw loop in `canvas-surface.tsx`:

| Setting | Today | Proposed | Rationale |
|---|---|---|---|
| `DEFAULT_ROW_HEIGHT` | 28 | **22** | Excel default is ~20px; Sheets is ~21px. 28 looks like a marketing table. |
| `HEADER_ROW_HEIGHT` | 34 | **24** | Should be only marginally taller than a body row, not 6px taller. |
| `MIN_COLUMN_WIDTH` | 88 | **64** | Excel default column width is ~64px; ours forces near-double. |
| `INDEX_COLUMN_WIDTH` | 56 | **40** | The row-number gutter is too wide; 3-digit row numbers fit in 40px easily. |
| Cell text horizontal padding | 8 | **4** | In `drawText` (`canvas-surface.tsx:411-416`) the `+ 8` / `- 8` offsets pad each side. 4px matches Sheets. |
| Border line | `theme.border` (full opacity) at `lineWidth = 1` | use a `border-subtle` token at ~50–60% opacity, keep `lineWidth = 1` | Currently every cell gets a hard `--border` stroke on all four sides via `strokeRect(x + 0.5, y + 0.5, ...)`, which gives a heavier-than-Excel look. Drop to a softer line: e.g. mix `--border` 50% with `--background`, or compute `color-mix(in oklab, var(--border) 50%, transparent)` and pass that to `strokeStyle`. |
| Selection stroke | `lineWidth = 2` | **1.5** | Excel selection is ~1.5px. Two pixels reads as "active edit mode". |

Also: the cell `strokeRect` is currently drawn for *every* cell. For a large grid, a cleaner Excel-like look is to draw **only horizontal and vertical gridlines** as long lines once per row/column rather than per-cell rectangles. That gives crisp single-pixel gridlines without doubling-up at cell intersections. If the per-cell approach is easier to keep, at minimum reduce the stroke to a softer color as above.

---

## 3. Sheet tabs — overflow and visual treatment

**Where:** `canvas-surface.tsx:1101-1131`. Built on shadcn `Tabs` / `TabsList` with `variant="outline"`, each `TabsTrigger` has `max-w-[180px] shrink-0 truncate`.

**Problems:**
1. With many sheets, tabs spill out of `TabsList` because shadcn's `Tabs` isn't designed as a horizontal scroller — the `overflow-x-auto` on `TabsList` works, but the underlying flex layout still lets adjacent tabs visually overlap when names are long, because `truncate` only shrinks within the tab's reserved width.
2. The "outline" tab variant doesn't look like Excel — Excel sheet tabs are at the **bottom**, look like file-folder tabs (rounded-bottom, raised when active, subdued when inactive), and have left/right scroll arrows.

**Fix:** Stop using shadcn `Tabs` for this — it's the wrong primitive. Build a bespoke horizontal tab strip in a new `sheet-tab-bar.tsx`:

```
┌──────────────────────────────────────────────────────────────────┐
│  [‹] [›]  ┌─────────┐ ┌──────────┐ ┌───────────────────┐ ┌────┐ │
│           │ Sheet1  │ │  Sheet2  │ │  Long Sheet Name… │ │ +  │ │ (no +
│           └─────────┘ └──────────┘ └───────────────────┘ └────┘ │  for v1)
│  ═════════│ active  │═══════════════════════════════════════════ │
└──────────────────────────────────────────────────────────────────┘
```

Specifically:
- Position at the **bottom** of the spreadsheet shell, not below the formula bar. Excel-native users look for it there.
- Each tab is a `<button>` with:
  - `rounded-t-md` (rounded-bottom is rare in browsers — most Excel-clones use `rounded-t` and a connecting bottom border).
  - Active: `bg-card border border-border border-b-card -mb-px relative z-10` (the tab visually sits on top of the surface border).
  - Inactive: `bg-muted/40 text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground`.
  - `max-w-[160px] truncate` for the label, with the full name in `title` (already there).
- Wrap the tab list in a horizontally-scrollable container with **left/right chevron buttons** that appear when the tabs overflow. Use `IntersectionObserver` or scroll position to enable/disable the chevrons. shadcn doesn't ship a paged scroller — wire `<ChevronLeft />` / `<ChevronRight />` from lucide to `scrollLeft += 200` / `-= 200` on the container.
- Honor middle-click / context-menu for future "rename / duplicate" affordances by leaving the button structure clean (no extra wrapping divs).

Keep the existing keyboard support: arrow-left/arrow-right on the tab strip should move between sheets when focused.

---

## 4. Charts — wrong by design, not just wrong by polish

This is the structural problem. The user described it precisely: **the renderer should never invent charts; it should only display embedded charts**, and it should let users scroll through *all* embedded charts in the workbook.

**Where the bug lives:**

- `src/components/chat-file-preview/spreadsheet/parse-excel.ts:198-205`:
  ```ts
  charts: embeddedCharts.length > 0 ? embeddedCharts : inferWorkbookCharts(sheets),
  ```
  When a file has zero embedded charts, this falls back to inventing one inferred chart per sheet. That's where the "nonsense line graph per tab" comes from.

- `src/components/chat-file-preview/spreadsheet/parse-charts.ts:55-211` defines `inferSheetChart` and `inferWorkbookCharts`. These should not run for user files.

**Fix (parsing side):**

1. In `parse-excel.ts`, replace the line above with simply:
   ```ts
   charts: embeddedCharts,
   ```
2. Delete `inferSheetChart` and `inferWorkbookCharts` from `parse-charts.ts` (and their helpers `inferChartHeaderRow`, `getSheetTitle` if not used elsewhere). Their only caller is the line above.
3. Remove the unused `inferred` arm from `SpreadsheetChart['source']` in `types.ts`. All charts are now `'embedded'`. While we're there, drop `describeChartSource` in `chart-surface.tsx` and the "Generated from table data" copy.

**Fix (UI side):**

- The Data/Charts toggle in `canvas-surface.tsx:977-1001` should be hidden when there are zero embedded charts. The current `hasCharts = workbook.charts.length > 0` check already does this — once inferred charts are gone, files like the test workbook's chart-less sheets will simply not show the toggle.
- Verify the Charts surface lists all embedded charts across all sheets, not just the active sheet. Looking at `chart-surface.tsx:432-512`: it iterates `workbook.charts`, which is the flat workbook-wide list, so this part is already correct. Each chart entry includes its `sheetName` and the chart-tab UI surfaces that as a sub-label. Good.
- The chart-tab strip at `chart-surface.tsx:472-503` (the custom tabs above the chart canvas) is probably the right pattern for "scroll through all charts". With many charts (the test file has 4+ on some sheets, total likely 10+) those tabs will overflow the same way the sheet tabs do — apply the same chevron-scroller treatment from §3 here. Alternatively, render charts as a **vertically scrolling list of cards** (one card per chart, sheet name as a sub-header) — that probably matches "scroll through each chart" better than tabs do.

**Verify embedded chart extraction handles the test file correctly:**

`extractEmbeddedChartsFromWorkbookFiles` in `parse-charts.ts:405-457` walks the OOXML relationships graph (`xl/worksheets/_rels/sheet{N}.xml.rels` → drawing → chart). With the inferred-chart fallback removed, this becomes the *only* source of charts, so it has to be robust on `Runway Expenses.xlsx`. The implementing agent should:

1. Open that file in the dev preview after the change and confirm pie charts render. Most of the workbook's charts are pies; if the OOXML extractor misses pie variants (`pie3DChart`, `pieChart` with `varyColors`), they'll silently disappear. Add `pie3DChart`, `bar3DChart`, `line3DChart` to the `chartNode` lookup at line 442-447 if needed.
2. Confirm the chart count per sheet matches the file (some sheets have 4+ charts, all of them should be picked up — `chartPathsBySheet` uses a `Set<string>` per sheet, which should already handle multiple drawings per sheet).
3. If a chart's data is empty (`getCachePoints` returns `[]`), log it and skip rather than rendering an empty box.

---

## 5. Smaller polish (low-priority but worth catching)

- **`PREVIEW_*` class constants in `constants.ts`** are now thin aliases over Tailwind tokens (`bg-card`, `bg-muted`, etc.). They no longer add value as constants — they just indirect a single class through a name. Inline them and delete the constants. (Originally they were holding the beige acon palette; now they're vestigial.)
- **Subtitle line** ("Workbook preview" / "Delimited preview" / "Workbook charts") in the header banner — gone with §1, but call out that we don't need to reintroduce it elsewhere. The file extension already conveys the type.
- **Selection chip "Cell"** when nothing selected (`canvas-surface.tsx:1006-1008`) — fine, but consider showing the active sheet's range like Excel does (e.g. `A1` with no selection still shows `A1` because A1 is the focused cell on load). Looking at the init effect on line 213-218, a selection IS set on load, so this should already render `A1`; just sanity-check it's not flashing `Cell` first.
- **Resize handle hover color** is `hover:bg-blue-500/20` (`canvas-surface.tsx:1065`). Replace with `hover:bg-ring/20` to honor the theme.
- **`xs/relaxed` font sizing in shadcn `TabsContent`** doesn't apply here because we're not using `TabsContent`, but worth noting the canvas font is hardcoded to `12px ui-sans-serif, system-ui, sans-serif`. After the row-height tightening in §2, consider dropping cell text to **11px** to match Excel. Header/index text is already 11px and looks right.

---

## Ordering for the implementer

Roughly in this order — earlier items unblock later ones and the chart fix is the only behavioral correctness issue:

1. **Charts (§4)** — drop inferred charts, verify embedded extraction on `Runway Expenses.xlsx`, decide on tabs-vs-list for the chart surface.
2. **Filename → actions row (§1)** — delete the inner banner; move Copy into the popover toolbar; add a filename chip styled like `ClickToCopyUrlBar`.
3. **Tighten grid (§2)** — constants + draw-loop padding + lighter borders.
4. **Sheet tabs (§3)** — bespoke bottom-anchored Excel-style tab bar with chevron scrolling.
5. **Polish (§5)** — inline the `PREVIEW_*` constants, swap the resize-handle hover color, drop body text to 11px.

After all five, walk through the original behaviour checklist in `docs/canvas-spreadsheet-renderer-plan.md` again to make sure nothing regressed.
