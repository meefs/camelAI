# Notebook Tables — Large Data & CSV Download

Two enhancements to the native table renderer in `notebook-table.tsx`:

1. **Download as CSV** — Every table gets a "Download as CSV" action in its footer
2. **Row cap** — Tables exceeding a max row count are truncated with a clear message pointing the user to the CSV download for the full dataset

---

## Current State

The footer currently shows a plain dimensions caption:

```
┌──────────────────────────────────────────────────────────┐
│  Rank │  First Name    Last Name    Company    Score     │
├───────┼──────────────────────────────────────────────────┤
│    1  │  Philippe      SALLE        Emeria       16     │
│    2  │  Maryse        AULAGNON     Finestate    12     │
│   ... │  ...                                            │
│   25  │  Jean          Rottner      Réalités     11     │
└──────────────────────────────────────────────────────────┘
  25 rows × 10 columns                           ← plain text, nothing interactive
```

No row limit. A table with 8,000 rows would render 8,000 `<tr>` elements (~80k+ DOM nodes for a 10-column table), causing sluggish scrolling and high memory usage.

---

## Target Design

### Small table (within row cap)

Every table — regardless of size — gets a download link:

```
┌──────────────────────────────────────────────────────────┐
│  Rank │  First Name    Last Name    Company    Score     │
├───────┼──────────────────────────────────────────────────┤
│    1  │  Philippe      SALLE        Emeria       16     │
│    2  │  Maryse        AULAGNON     Finestate    12     │
│   ... │  ...                                            │
│   25  │  Jean          Rottner      Réalités     11     │
└──────────────────────────────────────────────────────────┘
  25 rows × 10 columns                  ↓ Download as CSV
                                        ▲
                               text-style button, muted,
                               triggers browser download
```

Footer layout: dimensions on the left, download action on the right, same line.

```
┌─────────────────────────────────────────────────────────────┐
│  25 rows × 10 columns                   ⬇ Download as CSV  │
└─────────────────────────────────────────────────────────────┘
  ▲ muted text, text-xs                    ▲ muted text button
  ▲ same style as current caption            with Download icon
```

### Large table (exceeds row cap)

When the parsed table has more rows than the display cap, we truncate at the cap and show a message:

```
┌──────────────────────────────────────────────────────────┐
│  Name       Age   City       Salary    Department       │
├──────────────────────────────────────────────────────────┤
│  Alice       32   Paris       85,000   Engineering      │
│  Bob         28   Lyon        72,500   Marketing        │
│  ...                                                    │
│  Row 100     44   Bordeaux    67,300   Operations       │
└──────────────────────────────────────────────────────────┘
  Showing 100 of 8,000 rows × 10 columns  ⬇ Download all rows as CSV
                                           ▲
                              "all rows" wording clarifies
                              the CSV contains the full dataset
```

Footer wording changes:
- Caption: `Showing {CAP} of {TOTAL} rows × {COLS} columns`
- Download label: `Download all rows as CSV` (makes it clear the download isn't truncated)

---

## Row Cap: 100 Rows

**Why 100:**

| Candidate | DOM cells (10 cols) | Tradeoff |
|-----------|-------------------|----------|
| 50        | ~500              | Too aggressive — pandas default shows 60, so we'd truncate most default output |
| **100**   | **~1,000**        | **Fast on all devices. Exceeds pandas default (60). Enough to spot data patterns, outliers, distributions.** |
| 200       | ~2,000            | Still fine perf-wise but diminishing returns for readability in a report |
| 500       | ~5,000            | Starts to feel sluggish on lower-end devices; table dominates the report layout |

100 rows is well above the pandas default truncation (60 rows = first 30 + last 30), so most standard DataFrame displays will render in full. Only explicitly un-truncated or very large outputs get capped.

The cap is applied at **render time** in the component, not at parse time. `ParsedTable.rows` still holds all parsed rows — the component slices to the first 100 for display and uses the full array for CSV generation.

Define the constant at the top of `notebook-table.tsx`:

```typescript
const MAX_DISPLAY_ROWS = 100;
```

---

## Implementation

All changes are in **one file**: `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`

No changes to `types.ts`, `utils.ts`, or `output-renderers.tsx`.

### 1. Add the row cap constant and compute display state

At the top of the `NotebookTable` component, compute truncation state:

```typescript
const MAX_DISPLAY_ROWS = 100;

export function NotebookTable({ table, mode }: NotebookTableProps) {
  // ... existing refs and state ...

  const totalRows = table.rows.length;
  const isTruncated = totalRows > MAX_DISPLAY_ROWS;
  const displayRows = isTruncated ? table.rows.slice(0, MAX_DISPLAY_ROWS) : table.rows;

  // Use displayRows instead of table.rows in the JSX render loop
  // ...
```

The existing `{table.rows.map((row, rowIndex) => ...)}` in the `<TableBody>` becomes `{displayRows.map((row, rowIndex) => ...)}`.

### 2. CSV download function

Add a `downloadCsv` callback that builds a CSV from the **full** `table.rows` (not the truncated `displayRows`):

```typescript
const downloadCsv = useCallback(() => {
  const escapeCell = (value: string): string => {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const lines: string[] = [];

  // Header row
  if (table.headers.length > 0) {
    lines.push(table.headers.map(escapeCell).join(','));
  }

  // All data rows (full dataset, not truncated)
  for (const row of table.rows) {
    lines.push(row.map(escapeCell).join(','));
  }

  const csvContent = lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'table-data.csv';
  link.click();

  URL.revokeObjectURL(url);
}, [table.headers, table.rows]);
```

**CSV format:** RFC 4180 compliant — values containing commas, double quotes, or newlines are wrapped in double quotes with internal quotes escaped as `""`. The full dataset (all rows, not just displayed) is included.

### 3. Redesign the footer

Replace the current plain `<p>` caption with a flex row containing dimensions + download button:

**Current** (lines 156–158):
```tsx
{table.caption ? (
  <p className="mt-1.5 text-xs text-muted-foreground/60">{table.caption}</p>
) : null}
```

**New:**
```tsx
<div className="mt-1.5 flex items-center justify-between gap-4 text-xs text-muted-foreground/60">
  <span>{captionText}</span>
  <button
    type="button"
    onClick={downloadCsv}
    className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
  >
    <Download className="size-3" />
    {downloadLabel}
  </button>
</div>
```

Import `Download` from `lucide-react` (already used in the neighboring `file-preview-popover.tsx`).

Import `useCallback` (already imported in the file).

**Caption text logic:**

```typescript
// Compute the data column count (excluding index columns)
const dataColumns = Math.max(0, table.headers.length - table.indexColumns);

const captionText = isTruncated
  ? `Showing ${MAX_DISPLAY_ROWS.toLocaleString()} of ${totalRows.toLocaleString()} rows × ${dataColumns.toLocaleString()} columns`
  : table.caption;

const downloadLabel = isTruncated
  ? 'Download all rows as CSV'
  : 'Download as CSV';
```

When truncated, we override `table.caption` with a custom string that makes the truncation explicit. The download label adds "all rows" to clarify the CSV contains everything.

---

## Summary of Changes

| File | Change |
|------|--------|
| `notebook-table.tsx` | Add `MAX_DISPLAY_ROWS` constant (100); compute `displayRows` slice; add `downloadCsv` callback; redesign footer with flex layout, caption text, and download button; import `Download` from lucide-react |

**No other files change.** Types, parser, and output-renderers are untouched.

## Not in Scope

- **Pagination / "show more" button** — Truncation + CSV download is sufficient. Users who need to browse beyond 100 rows should download the CSV and open it in a spreadsheet.
- **Virtual scrolling** — Adds significant complexity (windowed rendering, scroll position management). The 100-row cap keeps the DOM small enough that it's unnecessary.
- **Max-height scroll container with sticky header** — Not needed given the 100-row cap. 100 rows in a compact table fits comfortably in a scrollable report without overwhelming the layout. Could be added later if desired.
- **Server-side CSV generation** — The CSV is generated client-side from the already-parsed `ParsedTable` data. No network request needed.
