# Notebook Table Rendering Improvements

Two buckets: TableViewer (fullscreen) and NotebookTable (inline report mode).

---

## Bucket 1: TableViewer — Excel-like column behavior

**File:** `src/components/chat-file-preview/notebook-preview/table-viewer.tsx`

### 1a. Default column widths on mount

Add constants:

```typescript
const DEFAULT_MAX_COLUMN_WIDTH = 200;
const DEFAULT_INDEX_COLUMN_WIDTH = 120;
```

Add a `useEffect` that populates `columnWidths` when the table mounts or structure changes:

```typescript
useEffect(() => {
  const defaults: Record<number, number> = {};
  for (let i = 0; i < columnCount; i++) {
    defaults[i] = i < table.indexColumns ? DEFAULT_INDEX_COLUMN_WIDTH : DEFAULT_MAX_COLUMN_WIDTH;
  }
  setColumnWidths(defaults);
}, [columnCount, table.indexColumns]);
```

This gives every column a starting width so the table is immediately navigable. Users resize from there.

### 1b. Excel-like resizing (text clips when wrap is off)

Currently the table uses `w-max min-w-full` with auto layout — content forces minimum column widths, so resizing feels broken when wrap is off.

Fix: when wrap is off, switch to `table-layout: fixed` + `overflow: hidden` + `text-overflow: ellipsis` on cells. Column widths become authoritative and text clips cleanly at cell boundaries.

On the `<table>` element:

```tsx
<table
  className={cn(
    'min-w-full border-collapse text-xs',
    textWrap
      ? 'w-max [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal'
      : 'w-full table-fixed [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap'
  )}
>
```

On data `<TableCell>` elements, add clipping when wrap is off:

```tsx
className={cn(
  'px-3 py-1.5 text-xs text-foreground/90',
  numericCell && 'font-mono tabular-nums text-right',
  !textWrap && 'overflow-hidden text-ellipsis'
)}
```

Same for index column `<th scope="row">` cells and header `<th>` elements.

**Wrap toggle interaction:** wrap ON → auto layout, content drives widths, cells wrap. Wrap OFF → fixed layout, columns respect set widths, text clips. `columnWidths` state persists across toggles.

---

## Bucket 2: NotebookTable — Report mode compactness

**File:** `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`

### 2a. Max height with scroll for report mode tables

Wrap the table scroll container with a height constraint in report mode so tables don't dominate the report layout. ~20 rows visible before scrolling.

On the scroll container `<div ref={scrollRef}>`:

```tsx
className={cn(
  'min-w-0 overflow-x-auto',
  isReport && 'max-h-[600px] overflow-y-auto'
)}
```

600px ≈ header (~33px) + 20 rows (~28px each). Tables shorter than this are unaffected.

Add a sticky header so column names stay visible while scrolling vertically:

```tsx
<TableRow className={cn(
  'h-auto border-border/80 bg-muted/40 hover:bg-muted/40',
  isReport && 'sticky top-0 z-10 bg-muted/40'
)}>
```

Notebook mode is unaffected — `isReport` gates both changes.

### 2b. Truncate cell text in report mode (~50 chars)

Add a constant and helper:

```typescript
const REPORT_MAX_CELL_CHARS = 50;

function truncateCell(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + '\u2026';
}
```

In data cell rendering, truncate when in report mode. Add a `title` attribute on truncated cells so hovering reveals full text:

```tsx
{isReport && cellValue.length > REPORT_MAX_CELL_CHARS ? (
  <span title={cellValue}>{truncateCell(cellValue, REPORT_MAX_CELL_CHARS)}</span>
) : cellValue}
```

Apply to both data `<TableCell>` and index `<th scope="row">` cells.

Full text is always available in the fullscreen TableViewer (500-row cap, no truncation) and CSV download.

---

## Files modified

| File | Changes |
|------|---------|
| `table-viewer.tsx` | 1a: default column widths, 1b: table-fixed + overflow clipping |
| `notebook-table.tsx` | 2a: max-height + sticky header in report, 2b: text truncation in report |

## Files NOT modified

- `output-renderers.tsx` — mode prop already flows through correctly
- `report-mode.tsx` — height constraint lives inside NotebookTable, not here
- `spreadsheet-preview.tsx` — passes `mode="notebook"`, unaffected by report changes
- `types.ts` — no interface changes

## Verification

1. `bun run build` — confirm no type errors
2. Open a notebook with a large DataFrame in the chat preview panel
   - Report mode: table should cap at ~20 visible rows with vertical scroll, header sticks, cell text truncates at ~50 chars with hover tooltip
   - Notebook mode: no change from current behavior
3. Expand table to fullscreen (TableViewer)
   - Columns should start at 200px width with text clipped at cell boundaries
   - Resizing a column narrower should clip text (not push it)
   - Turning wrap ON should show full text, turning OFF should clip again
4. Open a CSV file in the preview panel — verify fullscreen TableViewer works the same
