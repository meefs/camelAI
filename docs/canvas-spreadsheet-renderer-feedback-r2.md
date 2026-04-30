# Canvas Spreadsheet Renderer — Round 2 Feedback

The chart correctness fix landed cleanly and the tightened grid feels much
closer to Excel. A few things from round 1 were missed or interpreted
differently than intended; this pass focuses on those plus a couple of new
items.

---

## 1. Actions row in the popover header

### A) Filename placement and order

**Where:** `src/components/chat-file-preview/file-preview-popover.tsx:77-156`.

**What's there now:** the filename chip is on the **left**, then a `justify-between` flex pushes everything else right, so the row reads:

```
[Filename chip]                          [Refresh] [Download] [Copy] [Close]
```

**What was asked for:** put the filename **between** the Refresh button and the rest of the actions, with a separator on each side. Concretely:

```
[Refresh] │ [Filename chip] │ [Copy?]                          [Download] [Close]
```

**On Download placement:** check `src/components/preview-panel/preview-toolbar.tsx:449-484` — the canonical chat preview toolbar puts Refresh on the **left** and Download on the **right** (Download is the final element before any view-mode tabs). Match that convention here: keep Download on the right edge, and Close after it. So the popover row should read left-to-right:

`[Refresh] [Sep] [FilenameChip] [Sep] [Copy (when spreadsheet active)]   …   [Download] [Close]`

Use shadcn `Separator` with `orientation="vertical"` (the same one used in `preview-toolbar.tsx:336, 423`) and an `ml-auto` on the trailing `[Download][Close]` group instead of the current `justify-between` on the parent.

### B) Remove "Open in new tab" for non-app files

**Where:** `src/components/preview-panel/preview-toolbar.tsx:454` — the `ExternalLink` `ToolbarButton` is rendered unconditionally, before the file-type branch.

**Problem:** for spreadsheet (and really any non-app file: pdf, image, csv, xlsx, code…), Open-in-new-tab and Download do the same thing — both hit the file URL, and the browser either renders or downloads. Two icons, one outcome. For app previews it's meaningful; for files it's noise.

**Fix:** only render the `ExternalLink` button when `fileType === 'app'`. Move the `ToolbarButton icon={ExternalLink} …` line into `AppToolbarActions` (or render it conditionally in the parent guarded on `fileType === 'app'`). For all file types, the row should be:

`[Refresh] [Sep] [view-mode tabs if any]                          [Download]`

This affects every file preview, not just spreadsheets — confirm it's the desired behaviour for pdf/image/notebook/markdown previews too (almost certainly yes).

---

## 2. Drop the spreadsheet's outer container

**Where:** `src/components/chat-file-preview/spreadsheet/canvas-surface.tsx:982`:

```tsx
<div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
```

The popover's `DialogContent` already has rounded corners + a border + background; this inner shell creates a visible nested rectangle. Drop the wrapper styling — keep only the layout primitives:

```tsx
<div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
```

The interior surfaces (formula bar with `border-b`, grid with `bg-muted`, sheet tab bar) already provide the visual structure.

---

## 3. Data ↔ Charts: tabs with the `line` variant, not a button group

**Where:** `canvas-surface.tsx:983-1007`. Today this is a shadcn `ToggleGroup` with `variant="outline"` and a muted-background wrapper. Visually it reads as two pill buttons sitting in a tray — it doesn't say "these are alternative views".

**Fix:** swap to shadcn `Tabs` with `variant="line"`. That variant exists in `src/components/ui/tabs.tsx:33` (`gap-1 bg-transparent`, plus the underline indicator wired in via the `after:` pseudo at line 70). It gives the standard underline-on-active treatment that the codebase already uses in `preview-toolbar.tsx:373` and reads unambiguously as a tab switcher.

Concretely:

```tsx
<Tabs
  value={activeSurface}
  onValueChange={(value) => {
    if (value === 'data' || value === 'charts') setActiveSurface(value);
  }}
>
  <TabsList variant="line" className="h-8 px-3">
    <TabsTrigger value="data">Data</TabsTrigger>
    <TabsTrigger value="charts">
      Charts
      <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[0.625rem]">
        {workbook.charts.length}
      </Badge>
    </TabsTrigger>
  </TabsList>
</Tabs>
```

Drop the surrounding `bg-muted/40 px-3 py-2` div — the line variant doesn't need a tray.

---

## 4. Chart surface: one renderer + tab strip, not a vertical scroll

**Where:** `src/components/chat-file-preview/spreadsheet/chart-surface.tsx:442-450`:

```tsx
<div className="space-y-4">
  {charts.map((chart) => (
    <SpreadsheetChartWorkspace key={chart.id} chart={chart} />
  ))}
</div>
```

This stacks every chart vertically and forces a long scroll on workbooks with many charts (the `Runway Expenses.xlsx` test file has 10+).

**Fix:** restore the single-chart-with-tabs UX (the same shape from the previous iteration when we had inferred charts):

- Hold an `activeChartIndex` state in `SpreadsheetChartsSurface`.
- Render exactly one `SpreadsheetChartWorkspace` for `charts[activeChartIndex]`.
- Render a chart tab strip above it. Each tab shows the chart title (truncated) with the sheet name as a sub-label so the user knows where in the workbook each chart lives. Reuse the `SheetTabBar` chevron-scroller pattern (`spreadsheet/sheet-tab-bar.tsx`) since the same overflow problem applies — likely worth extracting that into a shared `OverflowTabBar` component, but a copy is fine for v1.
- Only render the tab strip when `charts.length > 1`. With a single chart, just render the chart.
- Reset `activeChartIndex` to 0 when the workbook changes.

Layout shape:

```
┌────────────────────────────────────────────────────────────┐
│ [‹] [Chart 1 ▼ Sheet A] [Chart 2 ▼ Sheet B] [Chart 3 ▼ …] [›]│  ← tab strip
├────────────────────────────────────────────────────────────┤
│                                                              │
│              [active chart fills this space]                 │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

---

## 5. Remove the type/sheet tag pills above each chart

**Where:** `chart-surface.tsx:404-412`:

```tsx
<div className="mb-1 flex flex-wrap items-center gap-2">
  <span className="rounded-full bg-secondary …">{getChartKindLabel(chart.kind)}</span>
  <span className="rounded-full bg-accent …">{chart.sheetName}</span>
</div>
```

Delete this whole block. Once §4 lands, the active sheet/chart is already conveyed by the tab strip; the type pill ("Pie", "Column", etc.) is redundant chart metadata that doesn't earn its space. Also delete the `getChartKindLabel` helper at `chart-surface.tsx:49-62` if it's now unused.

The remaining `<h3>{chart.title || 'Excel Chart'}</h3>` is fine to keep as the chart heading inside the workspace card.

---

## Recap / order to implement

1. **Popover toolbar order** — move filename between Refresh and other actions, separators on both sides, `ml-auto` for the trailing Download+Close pair (§1A).
2. **Remove `ExternalLink` for non-app files** in `preview-toolbar.tsx` (§1B).
3. **Drop the outer rounded-xl border + bg-card wrapper** from the spreadsheet shell (§2).
4. **Swap the Data/Charts ToggleGroup for `Tabs variant="line"`** (§3).
5. **Replace the vertical chart list with a single chart + tab strip** (§4).
6. **Remove the chart-type and sheet-name pill badges** from the chart header (§5).

After those, sanity-check with the `Runway Expenses.xlsx` file: scrolling between tabs should feel light, the chart tab strip should overflow-scroll, and the popover header should match the rest of the app's preview toolbar conventions.
