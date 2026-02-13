# Native Table Rendering for Notebook Preview

## Problem

Tables in notebook outputs (pandas DataFrames, polars tables, etc.) currently render inside sandboxed iframes via `NotebookHtmlOutput`. This makes them look foreign — unstyled, unthemed, and disconnected from the polished report aesthetic that charts now have.

Charts were extracted from iframes into native React components (Vega-Lite, Plotly) with dark/light theme support. Tables should receive the same treatment: parse the HTML table structure, render natively in the React tree, and style them to feel like a first-class element of the report.

### Current flow

```
Cell output (text/html containing <table>)
  → getOutputRender() detects HTML
  → { kind: 'html' }
  → NotebookHtmlOutput (iframe with srcDoc)
  → Unstyled browser-default table in isolated sandbox
```

### Target flow

```
Cell output (text/html containing <table>)
  → getOutputRender() detects table BEFORE generic HTML
  → { kind: 'table', ... }
  → NotebookTable (native React component)
  → Themed, responsive, dark/light-aware table
```

## Design

### Report mode table

```
┌──────────────────────────────────────────────────────────┐
│  ┌────────────────────────────────────────────────────┐  │
│  │  Name          Age   City          Salary          │  │  ← Header row
│  ├────────────────────────────────────────────────────┤  │    Sticky, muted bg
│  │  Alice          32   Paris        85,000           │  │    Bottom border
│  │  Bob            28   Lyon         72,500           │  │
│  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │  ← Alternating
│  │  Charlie        45   Marseille    91,200           │  │    zebra stripe
│  │  Diana          37   Bordeaux     68,000           │  │
│  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│  │  Eve            29   Toulouse     77,300           │  │
│  └────────────────────────────────────────────────────┘  │
│  5 rows × 4 columns                                     │  ← Footer caption
└──────────────────────────────────────────────────────────┘
  ▲                                                    ▲
  │  Rounded border, subtle shadow                     │
  │  Horizontal scroll when table overflows            │
```

### With named index column (pandas `df.index.name`)

Pandas DataFrames with a named index (e.g., `top_execs.index.name = 'Rank'`)
produce a **two-row `<thead>`**:

```html
<!-- Pandas output for named-index DataFrames -->
<thead>
  <tr>                              ← Row 1: empty index cell + column headers
    <th></th>
    <th>First Name</th>
    <th>Last Name</th>
    ...
  </tr>
  <tr>                              ← Row 2: index name + empty cells
    <th>Rank</th>
    <th></th>
    <th></th>
    ...
  </tr>
</thead>
```

The parser flattens this into a single header row: `["Rank", "First Name", "Last Name", ...]`

```
┌────────────────────────────────────────────────────────────────┐
│  ┌──────┬──────────────────────────────────────────────────┐   │
│  │ Rank │  First Name    Last Name    Company    Score     │   │
│  ├──────┼──────────────────────────────────────────────────┤   │
│  │  1   │  Philippe      SALLE        Emeria       16     │   │
│  │  2   │  Maryse        AULAGNON     Finestate    12     │   │
│  │ ░3░░ │ ░Francois░░░░░░Malan░░░░░░░Nexity░░░░░░░11░░░░ │   │
│  │  4   │  Catherine     Dargent...   Daxter       11     │   │
│  │ ░5░░ │ ░Jean░░░░░░░░░░Rottner░░░░░Réalités░░░░░11░░░░ │   │
│  └──────┴──────────────────────────────────────────────────┘   │
│  ▲                                                             │
│  Index column: muted text, right border separator              │
│  25 rows × 10 columns                                         │
└────────────────────────────────────────────────────────────────┘
```

### With unnamed index (pandas default `RangeIndex`)

When the index has no name, the first `<thead>` row has an empty `<th>`:

```
┌───────────────────────────────────────────────────────────┐
│  ┌──────┬─────────────────────────────────────────────┐   │
│  │      │  Name       Age   City         Salary       │   │
│  ├──────┼─────────────────────────────────────────────┤   │
│  │  0   │  Alice       32   Paris       85,000        │   │
│  │  1   │  Bob         28   Lyon        72,500        │   │
│  │  2   │  Charlie     45   Marseille   91,200        │   │
│  └──────┴─────────────────────────────────────────────┘   │
│  ▲                                                        │
│  Index column: muted text, right border separator         │
│  Empty header cell for unnamed index                      │
└───────────────────────────────────────────────────────────┘
```

### Wide table with horizontal scroll

```
┌─────────────────────────────────── ◀ scroll ▶ ─────────┐
│  Name    Age  City       Salary  Department  Start Da ──│──▶
│  Alice    32  Paris      85,000  Engineeri   2021-03- ──│──▶
│  Bob      28  Lyon       72,500  Marketing   2022-01- ──│──▶
└─────────────────────────────────────────────────────────┘
  Fade gradient on right edge when content overflows →
```

### Notebook mode table

Same rendering but without the outer rounded container shadow — keeps the denser, more utilitarian notebook aesthetic.

### Large table (truncated)

When a DataFrame has many rows, pandas typically truncates it in the HTML output with `...` rows. We render whatever HTML pandas provides — no additional truncation needed on our side. The row count caption shows the full dimensions.

### Dark mode

```
┌───────────────────────────────── dark ──────────────────┐
│                                                         │
│  Header bg: zinc-800/50     Text: zinc-200              │
│  Zebra bg:  zinc-800/30     Muted text: zinc-400        │
│  Borders:   zinc-700/50     Index text: zinc-500        │
│  Container: zinc-900 border                             │
│                                                         │
│  All values from Tailwind theme vars, not hardcoded     │
│  (bg-muted, text-foreground, border-border, etc.)       │
└─────────────────────────────────────────────────────────┘
```

## Implementation

### 1. Add `table` render kind to types

**File:** `src/components/chat-file-preview/notebook-preview/types.ts`

Add a new variant to the `NotebookOutputRender` union:

```typescript
export interface ParsedTable {
  /**
   * Flattened column headers. Includes the index column header (if named).
   * For a pandas DataFrame with `index.name = 'Rank'` and columns
   * ['First Name', 'Last Name', ...], this would be:
   * ['Rank', 'First Name', 'Last Name', ...]
   *
   * For an unnamed index, the first entry is an empty string: ['', 'Name', 'Age', ...]
   */
  headers: string[];
  /** Data rows. Each row is an array of cell text values, including index cells. */
  rows: string[][];
  /**
   * Number of leading columns that are index/row-label columns.
   * Pandas DataFrames use <th> inside <tbody> rows for the index.
   * Typically 1 for a standard DataFrame, 0 for `df.to_html(index=False)`.
   */
  indexColumns: number;
  /**
   * Computed dimensions string, e.g. "25 rows × 10 columns".
   * Derived from the parsed data (pandas doesn't include this in HTML output).
   */
  caption: string | null;
}

export type NotebookOutputRender =
  | { kind: 'vegalite'; spec: Record<string, unknown> }
  | { kind: 'plotly'; payload: Record<string, unknown> }
  | { kind: 'table'; table: ParsedTable }
  | { kind: 'html'; html: string }
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported' };
```

### 2. Add table detection and parsing to utils

**File:** `src/components/chat-file-preview/notebook-preview/utils.ts`

Add a `getTableData()` function that checks the `text/html` MIME output for a table pattern and parses it into `ParsedTable`. This must be called **before** the generic `getHtmlOutputDocument()` check in `getOutputRender()`.

#### Detection heuristics

A `text/html` output is a table when:
1. It contains a `<table` tag
2. It does **not** contain Vega/Plotly patterns (those are already handled upstream)
3. It does **not** contain pandas Styler signatures (`id="T_"` prefix, `class="Styler"`)
4. It has a recognizable table structure (`<thead>` + `<tbody>`, or at least `<tr>` rows)

Pandas DataFrames are the most common case. Their HTML signature:
- `class="dataframe"` on the `<table>`
- `<thead>` with **one or two** header rows (two when `df.index.name` is set)
- `<tbody>` with `<th>` for index values and `<td>` for data cells
- `<style scoped>` block inside a `<div>` wrapper (strip/ignore)
- `border="1"` attribute on the table (ignore)

Polars tables have a similar structure but without the `dataframe` class. The parser should work generically on any well-formed HTML table.

#### Real-world pandas HTML structure (from sample data)

This is what a pandas DataFrame with `index.name = 'Rank'` produces:

```html
<div>
<style scoped>
    .dataframe tbody tr th:only-of-type { vertical-align: middle; }
    .dataframe tbody tr th { vertical-align: top; }
    .dataframe thead th { text-align: right; }
</style>
<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">    ← Header row 1: empty th + column names
      <th></th>
      <th>First Name</th>
      <th>Last Name</th>
      <th>Company</th>
      ...
    </tr>
    <tr>                                ← Header row 2: index name + empty ths
      <th>Rank</th>
      <th></th>
      <th></th>
      <th></th>
      ...
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>1</th>                        ← Index value (th, not td)
      <td>Philippe</td>                 ← Data cells (td)
      <td>SALLE</td>
      <td>Emeria</td>
      ...
    </tr>
    ...
  </tbody>
</table>
</div>
```

#### Parsing approach

Use regex-based extraction (no DOM parser needed — consistent with the existing Vega/Plotly extraction patterns in this file). The HTML table structures from pandas/polars are predictable enough for regex.

```typescript
function getTableData(output: NotebookOutput): ParsedTable | null {
  const data = output.data ?? {};
  const html = toHtml(data['text/html']);
  if (!html) return null;

  // Must contain a <table> element
  if (!/<table[\s>]/i.test(html)) return null;

  // Skip Vega/Plotly outputs (already handled upstream)
  if (/vegaEmbed\s*\(/i.test(html)) return null;
  if (/Plotly\s*\.\s*newPlot/i.test(html)) return null;

  // Skip pandas Styler output (intentionally styled, should stay in iframe)
  if (/id="T_[a-f0-9]+"/i.test(html)) return null;
  if (/class="Styler"/i.test(html)) return null;

  // Extract <thead> and <tbody> content
  const theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return null; // Need at least a body

  // Parse header rows from <thead>
  const headers = flattenHeaderRows(theadMatch?.[1] ?? '');

  // Parse body rows, tracking which cells are <th> (index) vs <td> (data)
  const { rows, indexColumns } = parseBodyRows(tbodyMatch[1]);
  if (rows.length === 0) return null;

  // Compute caption from parsed dimensions
  const dataColumns = headers.length - indexColumns;
  const caption = `${rows.length} row${rows.length !== 1 ? 's' : ''} × ${dataColumns} column${dataColumns !== 1 ? 's' : ''}`;

  return { headers, rows, indexColumns, caption };
}
```

**Header row flattening** — The key complexity. Pandas produces one or two `<thead>` rows:

```typescript
/**
 * Flatten one or two pandas-style <thead> rows into a single header array.
 *
 * Single row (unnamed index):
 *   Row 1: ["", "First Name", "Last Name", ...]
 *   → headers: ["", "First Name", "Last Name", ...]
 *
 * Two rows (named index, e.g. index.name = 'Rank'):
 *   Row 1: ["", "First Name", "Last Name", ...]   ← column names
 *   Row 2: ["Rank", "", "", ...]                   ← index name
 *   → headers: ["Rank", "First Name", "Last Name", ...]
 *
 * Merge strategy: for each column position, take the non-empty value.
 * Row 2's first cell (index name) fills row 1's empty first cell.
 */
function flattenHeaderRows(theadHtml: string): string[] {
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const headerRows: string[][] = [];

  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(theadHtml)) !== null) {
    headerRows.push(parseRowCellTexts(trMatch[1]));
  }

  if (headerRows.length === 0) return [];
  if (headerRows.length === 1) return headerRows[0];

  // Merge: for each position, prefer non-empty value from any row
  const maxLen = Math.max(...headerRows.map((r) => r.length));
  const merged: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    // Check rows in reverse so the index-name row (row 2) fills the empty slot
    let value = '';
    for (let r = headerRows.length - 1; r >= 0; r--) {
      const cell = headerRows[r]?.[i] ?? '';
      if (cell.length > 0) {
        value = cell;
        break;
      }
    }
    // If still empty but the first row has a non-empty value, use that
    if (!value) {
      for (const row of headerRows) {
        const cell = row[i] ?? '';
        if (cell.length > 0) {
          value = cell;
          break;
        }
      }
    }
    merged.push(value);
  }
  return merged;
}
```

**Detailed parsing helpers:**

```typescript
/** Strip HTML tags from a string, returning text content. */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/** Parse cell texts from a <tr> row's inner HTML. Returns text values only. */
function parseRowCellTexts(trInnerHtml: string): string[] {
  const texts: string[] = [];
  const cellRegex = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(trInnerHtml)) !== null) {
    texts.push(stripHtmlTags(match[1]));
  }
  return texts;
}

/**
 * Parse <tbody> rows. Returns cell values and detects index columns.
 * Index columns are leading <th> cells in body rows (pandas convention).
 */
function parseBodyRows(tbodyHtml: string): {
  rows: string[][];
  indexColumns: number;
} {
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[][] = [];
  let indexColumns = 0;
  let indexColumnsDetected = false;

  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(tbodyHtml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
    let leadingThCount = 0;
    let seenTd = false;

    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
      cells.push(stripHtmlTags(cellMatch[2]));
      if (!seenTd && cellMatch[1].toLowerCase() === 'th') {
        leadingThCount++;
      } else {
        seenTd = true;
      }
    }

    // Detect index columns from the first body row
    if (!indexColumnsDetected && cells.length > 0) {
      indexColumns = leadingThCount;
      indexColumnsDetected = true;
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return { rows, indexColumns };
}
```

**Caption:** Pandas does not include row/column dimensions in the HTML output. The caption is computed from the parsed data itself: `{rows.length} rows × {headers.length - indexColumns} columns`. If the table has a `<caption>` element, extract that text instead.

#### Wire into `getOutputRender()`

Insert the table check between plotly and generic HTML:

```typescript
export function getOutputRender(output: NotebookOutput): NotebookOutputRender {
  const vegaLiteSpec = getVegaLiteSpec(output);
  if (vegaLiteSpec) {
    return { kind: 'vegalite', spec: vegaLiteSpec };
  }

  const plotlyPayload = getPlotlyPayload(output);
  if (plotlyPayload) {
    return { kind: 'plotly', payload: plotlyPayload };
  }

  // NEW: Table detection before generic HTML
  const tableData = getTableData(output);
  if (tableData) {
    return { kind: 'table', table: tableData };
  }

  const htmlOutput = getHtmlOutputDocument(output);
  if (htmlOutput) {
    return { kind: 'html', html: htmlOutput };
  }

  // ... rest unchanged
}
```

### 3. Create the NotebookTable component

**File:** `src/components/chat-file-preview/notebook-preview/notebook-table.tsx` (new)

This is the core visual component. It renders parsed table data as native themed HTML.

```tsx
import { cn } from '@/lib/utils';
import { useRef, useState, useEffect } from 'react';
import type { ParsedTable } from './types';

interface NotebookTableProps {
  table: ParsedTable;
  mode: 'report' | 'notebook';
}
```

#### Component structure

```tsx
export function NotebookTable({ table, mode }: NotebookTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowRight, setOverflowRight] = useState(false);

  // Detect horizontal overflow for fade indicator
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      setOverflowRight(el.scrollWidth > el.clientWidth + el.scrollLeft + 1);
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      observer.disconnect();
    };
  }, [table]);

  const isReport = mode === 'report';

  return (
    <div className="relative w-full min-w-0">
      {/* Outer container — report gets rounded border + shadow */}
      <div
        className={cn(
          'relative overflow-hidden',
          isReport && 'rounded-xl border border-border/60 shadow-sm'
        )}
      >
        {/* Scroll container */}
        <div ref={scrollRef} className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            {/* Header */}
            {table.headers.length > 0 && (
              <thead>
                <tr className="border-b border-border/80 bg-muted/40">
                  {table.headers.map((header, i) => (
                    <th
                      key={i}
                      className={cn(
                        'px-3 py-2 text-left text-xs font-medium text-muted-foreground',
                        'whitespace-nowrap',
                        i < table.indexColumns && 'text-muted-foreground/60'
                      )}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
            )}

            {/* Body */}
            <tbody>
              {table.rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className={cn(
                    'border-b border-border/40 transition-colors',
                    'hover:bg-muted/30',
                    rowIdx % 2 === 1 && 'bg-muted/20'
                  )}
                >
                  {row.map((cell, colIdx) => {
                    const isIndex = colIdx < table.indexColumns;
                    return isIndex ? (
                      <th
                        key={colIdx}
                        scope="row"
                        className={cn(
                          'px-3 py-1.5 text-left text-xs font-normal',
                          'text-muted-foreground/70 whitespace-nowrap',
                          'border-r border-border/40'
                        )}
                      >
                        {cell}
                      </th>
                    ) : (
                      <td
                        key={colIdx}
                        className={cn(
                          'px-3 py-1.5 text-xs text-foreground/90',
                          'whitespace-nowrap',
                          isNumeric(cell) && 'tabular-nums text-right font-mono'
                        )}
                      >
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Right overflow fade gradient */}
        {overflowRight && (
          <div
            className={cn(
              'pointer-events-none absolute top-0 right-0 bottom-0 w-8',
              'bg-gradient-to-l from-background to-transparent'
            )}
          />
        )}
      </div>

      {/* Caption / dimensions */}
      {table.caption && (
        <p className="mt-1.5 text-xs text-muted-foreground/60">
          {table.caption}
        </p>
      )}
    </div>
  );
}
```

#### Numeric detection helper

```typescript
/** Check if a cell value looks numeric for right-alignment and monospace. */
function isNumeric(value: string): boolean {
  if (!value || value === '...' || value === 'NaN' || value === 'None') return false;
  // Matches integers, floats, negatives, comma-separated, percentages, scientific
  return /^-?[\d,]+(\.\d+)?([eE][+-]?\d+)?%?$/.test(value.trim());
}
```

### 4. Wire into OutputRenderer

**File:** `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`

Add the table rendering branch:

```tsx
import { NotebookTable } from './notebook-table';

// Inside OutputRenderer, after plotly check and before html check:
if (render.kind === 'table') {
  return (
    <div className="w-full min-w-0">
      <NotebookTable table={render.table} mode={mode} />
    </div>
  );
}
```

### 5. Update cell classifier for table awareness

**File:** `src/components/chat-file-preview/notebook-preview/cell-classifier.ts`

The existing cell classifier uses `hasVisualOutput()` from utils to determine if a cell has visual output (used for the report-mode header `visualizationCount`). Tables should be counted as visual output.

Check that `hasVisualOutput()` already returns `true` for `text/html` outputs containing tables. If it uses MIME type checks, tables will already pass since they're `text/html`. No change should be needed here, but verify.

### 6. Ensure `hasVisualOutput` counts tables

**File:** `src/components/chat-file-preview/notebook-preview/utils.ts`

The `hasVisualOutput()` function (used by `notebook-header.ts` to count visualizations for the header) should already return `true` for HTML outputs. Verify this handles tables correctly — since tables are `text/html`, they should already be counted. No change expected.

---

## Styling Details

### Typography

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| Header cell | System sans (inherit) | `text-xs` (12px) | `font-medium` (500) | `text-muted-foreground` |
| Data cell | System sans (inherit) | `text-xs` (12px) | Normal (400) | `text-foreground/90` |
| Numeric cell | Mono (`font-mono`) | `text-xs` (12px) | Normal (400) | `text-foreground/90` |
| Index cell | System sans (inherit) | `text-xs` (12px) | Normal (400) | `text-muted-foreground/70` |
| Caption | System sans (inherit) | `text-xs` (12px) | Normal (400) | `text-muted-foreground/60` |

### Colors (via Tailwind theme tokens)

| Element | Light | Dark |
|---------|-------|------|
| Header bg | `bg-muted/40` | Inherits (zinc-800-ish) |
| Zebra stripe | `bg-muted/20` | Inherits (zinc-800-ish) |
| Hover | `bg-muted/30` | Inherits |
| Borders | `border-border/40` to `/80` | Inherits |
| Container border | `border-border/60` | Inherits |
| Gradient fade | `from-background` | Inherits |

All colors use theme CSS variables — no hardcoded hex values. Dark mode works automatically.

### Spacing

| Element | Value |
|---------|-------|
| Cell padding | `px-3 py-1.5` (12px horizontal, 6px vertical) |
| Header padding | `px-3 py-2` (12px horizontal, 8px vertical) |
| Container border radius | `rounded-xl` (report mode only) |
| Caption margin | `mt-1.5` |

### Responsive behavior

- Horizontal scroll via `overflow-x-auto` on scroll container
- Fade gradient on right edge when content overflows (dissolves to `background`)
- Gradient hides on scroll-to-end (JS scroll listener)
- No fixed heights — table grows to fit content naturally
- `whitespace-nowrap` on cells prevents line breaks in data values

## Files Summary

| File | Change |
|------|--------|
| `types.ts` | Add `ParsedTable` interface and `table` variant to `NotebookOutputRender` |
| `utils.ts` | Add `getTableData()` parser, `stripHtmlTags()`, `parseRowCells()` helpers; insert table check in `getOutputRender()` |
| `notebook-table.tsx` | New file — native table renderer with theming, overflow detection, numeric alignment |
| `output-renderers.tsx` | Add `table` render branch, import `NotebookTable` |

## Not in Scope

- **Sorting/filtering** — Tables are read-only data displays, not interactive data grids
- **Cell editing** — No inline editing of values
- **Pandas Styler output** — `df.style.to_html()` produces heavily styled HTML with inline CSS for conditional formatting, gradients, color scales, bar charts, etc. These should continue rendering in the iframe (`NotebookHtmlOutput`) since the custom styling is intentional. The table parser skips HTML that contains pandas Styler signatures (`id="T_..."` or `class="Styler"`)
- **MultiIndex columns** — Pandas `MultiIndex` on *columns* creates complex multi-row headers with `colspan`/`rowspan` merging. The current parser handles the common two-row named-index pattern but does not handle arbitrary multi-level column hierarchies. These fall through to the iframe renderer. Enhancement for later.
- **LaTeX/math in cells** — If cells contain rendered math, they'll display as text. Not common in DataFrames.
