# Renderer Review Feedback

Sections 1–4 and 5c are implemented. Two items remain: fixing the code preview styling and adding spreadsheet preview.

---

## 1. REQUIRED: Fix Code Preview — Remove Container, Fix Line Spacing

The code preview currently looks wrong in two ways:

**Problem A: Double line spacing.** Lines are spaced as if double-spaced. This is a CSS bug: Shiki outputs `<pre><code><span class="line">...</span>\n<span class="line">...</span></code></pre>` — the newline characters between `</span>` and `<span>` are text nodes inside `<pre>` (which preserves whitespace), AND `.line { display: block }` adds its own line break. You get two line breaks per line.

**Problem B: Container inside container.** The code is wrapped in a `rounded-lg border bg-muted/30` card with `p-4` outer padding. The preview panel already IS a container. Nesting a card inside it wastes space and looks wrong. When the code file is the only thing being rendered, it should fill the panel directly — like you'd see in an IDE.

```
Current (bad):                              Goal:
┌── preview panel ──────────────┐          ┌── preview panel ──────────────┐
│  p-4                          │          │ ts                    [copy]  │
│  ┌─ rounded border card ──┐  │          │  1  import { Audio }          │
│  │ typescript       [copy] │  │          │  2                            │
│  │                         │  │          │  3  interface Particle {      │
│  │  1  import { Audio }    │  │          │  4    x: number;              │
│  │                         │  │          │  5    y: number;              │
│  │  3  interface Particle  │  │          │  6    vx: number;             │
│  │                         │  │          │  7    vy: number;             │
│  │  5    x: number;        │  │          │  8    life: number;           │
│  │                         │  │          │  9    maxLife: number;         │
│  │  7    y: number;        │  │          │ 10    size: number;            │
│  └─────────────────────────┘  │          │ 11    hue: number;             │
│                               │          │ 12  }                          │
└───────────────────────────────┘          └────────────────────────────────┘
   container in container,                    code fills the panel directly,
   double-spaced lines                        single-spaced, IDE-like
```

### Fix the CSS (globals.css)

The double-spacing bug: `.line { display: block }` inside `<pre>` creates two line breaks per line. Fix by making the `<code>` a flex column — flex layout collapses whitespace-only text nodes between flex children.

Replace the current `.code-preview-lines` rules with:

```css
.code-preview-lines code {
  counter-reset: line;
  display: flex;
  flex-direction: column;
}

.code-preview-lines .line::before {
  content: counter(line);
  counter-increment: line;
  display: inline-block;
  width: 3rem;
  margin-right: 1rem;
  text-align: right;
  color: var(--color-muted-foreground);
  opacity: 0.3;
  user-select: none;
}
```

Changes from current:
- **Added** `display: flex; flex-direction: column` on `code` — this collapses the whitespace text nodes between `.line` spans, fixing the double-spacing
- **Removed** `.line { display: block }` — no longer needed since flex children are block-level by default
- **Removed** `font-size: 0.75rem` from `::before` — let line numbers inherit the code font size so they're proportional
- **Reduced** opacity from 0.4 to 0.3 for subtler line numbers

### Fix the component (code-preview.tsx)

Strip away the container. The code should render directly into the panel with minimal padding — like opening a file in VS Code.

The component render should look like:

```tsx
return (
  <div className={cn('group/code relative', layout === 'dialog' && 'max-h-[60vh] overflow-auto')}>
    <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1">
      <span className="font-mono text-[11px] text-muted-foreground/50">
        {languageLabel}
      </span>
      <button
        onClick={handleCopy}
        className="rounded-md p-1 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-muted"
        aria-label="Copy code"
      >
        {copied ? (
          <Check className="size-3.5 text-green-500" />
        ) : (
          <Copy className="size-3.5 text-muted-foreground" />
        )}
      </button>
    </div>

    {highlightedCode ? (
      <div
        className="code-preview-lines overflow-x-auto font-mono text-xs leading-5 [&_pre]:m-0 [&_pre]:min-w-max [&_pre]:bg-transparent [&_pre]:px-3 [&_pre]:pb-4"
        dangerouslySetInnerHTML={{ __html: highlightedCode }}
      />
    ) : (
      <pre className="overflow-x-auto px-3 pb-4 font-mono text-xs leading-5">
        <code>{code || 'No preview content available.'}</code>
      </pre>
    )}

    {truncated && (
      <p className="px-3 pb-3 text-[11px] text-muted-foreground/50">
        Showing first {maxLines.toLocaleString()} of {totalLines.toLocaleString()} lines.
      </p>
    )}
  </div>
);
```

Key changes from current:
- **No outer `p-4` wrapper, no `max-w-[1800px]`** — code files fill the panel width naturally (code doesn't need centering, unlike prose)
- **No `rounded-lg border bg-muted/30` container** — the panel IS the container
- **`[&_pre]:bg-transparent`** instead of `[&_pre]:!bg-muted/50` — use the panel's own background, not a tinted overlay
- **`text-xs leading-5`** — `text-xs` is 12px (standard IDE size), `leading-5` is 20px line-height (1.67 ratio, tight and comfortable for code). This replaces `text-sm` which was 14px
- **Language label** — small, subtle, muted (`text-[11px] text-muted-foreground/50`), not a badge in a `bg-muted/60` pill. Sticky so it stays visible while scrolling
- **Copy button** — same hover-reveal, just smaller and no background pill
- **Truncation notice** — smaller, subtler, same muted treatment

### Why no container

The general principle: **when a file is the sole content of the preview panel, it should fill the panel directly.** The panel border/background IS the container. Putting a card inside a card:
- Wastes valuable horizontal/vertical space (double padding)
- Creates visual noise (border inside border)
- Doesn't match how IDEs present files

This applies to code files, and should be kept in mind for any future preview types. Markdown rendering of code *blocks* inside a document is different — those ARE inline elements within a document and look correct with their own container styling.

---

## 2. REQUIRED: Implement Spreadsheet Preview (CSV/TSV)

Currently `.csv` and `.tsv` files render as raw monospace text in a `<pre>` block. They should render as styled tables using the existing `NotebookTable` component, which already handles column alignment, alternating rows, scroll fade, and CSV download.

### What to build

A new `SpreadsheetPreview` component that:
1. Parses raw CSV/TSV text into headers + rows
2. Passes the result to the existing `NotebookTable` component
3. Falls back to `<pre>` if parsing fails

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ┌──────────┬──────────┬──────────┬──────────┬───── →      │
│   │ name     │ category │ amount   │ count    │             │
│   ├──────────┼──────────┼──────────┼──────────┤             │
│   │ Widget A │ tools    │    12.50 │        3 │  ← numeric  │
│   │ Widget B │ parts    │   145.00 │       12 │    right-   │
│   │ Widget C │ tools    │     8.75 │        1 │    aligned  │
│   └──────────┴──────────┴──────────┴──────────┘             │
│                                              gradient fade → │
│   42 rows × 4 columns                              [⬇ CSV]  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Files to change (3 modified, 1 new)

#### 1. `src/components/chat-file-preview/file-type-utils.ts` — add `'spreadsheet'` preview type

Add `'spreadsheet'` to the `PreviewType` union:

```tsx
export type PreviewType =
  | 'image'
  | 'pdf'
  | 'notebook'
  | 'markdown'
  | 'code'
  | 'spreadsheet'   // ← ADD THIS
  | 'text'
  | 'audio'
  | 'video'
  | 'other';
```

Update `getPreviewType()` — add one line before the `'text'` fallthrough:

```tsx
export function getPreviewType(filename: string, contentType?: string): PreviewType {
  const category = getFileCategory(filename, contentType);
  if (category === 'image') return 'image';
  if (category === 'pdf') return 'pdf';
  if (category === 'notebook') return 'notebook';
  if (category === 'audio') return 'audio';
  if (category === 'video') return 'video';
  if (getFileExtension(filename) === 'md') return 'markdown';
  if (getShikiLanguage(filename) !== null) return 'code';
  if (category === 'spreadsheet') return 'spreadsheet';  // ← ADD THIS LINE
  if (category === 'code' || category === 'text') return 'text';  // ← remove 'spreadsheet' from fallthrough
  return 'other';
}
```

`SPREADSHEET_EXTENSIONS` already includes `csv`, `tsv`, `xlsx`, `xls`. `getFileCategory` already returns `'spreadsheet'` for these. We just need `getPreviewType` to route them instead of falling through to `'text'`.

For `.xlsx`/`.xls` (binary files), the text fetch will fail, so the error state will show "Unable to preview this file." — that's fine.

#### 2. NEW: `src/components/chat-file-preview/spreadsheet-preview.tsx`

```tsx
'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { NotebookTable } from './notebook-preview/notebook-table';
import { getFileExtension } from './file-type-utils';
import type { ParsedTable } from './notebook-preview/types';

interface SpreadsheetPreviewProps {
  content: string;
  filename: string;
  layout: 'panel' | 'dialog';
}

function parseCSV(text: string, delimiter: string): ParsedTable | null {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      current.push(field);
      field = '';
    } else if (char === '\n' || (char === '\r' && text[i + 1] === '\n')) {
      current.push(field);
      field = '';
      if (current.some((c) => c.length > 0)) {
        rows.push(current);
      }
      current = [];
      if (char === '\r') i++;
    } else {
      field += char;
    }
  }

  current.push(field);
  if (current.some((c) => c.length > 0)) {
    rows.push(current);
  }

  if (rows.length === 0) return null;

  return {
    headers: rows[0],
    rows: rows.slice(1),
    indexColumns: 0,
    caption: null,
  };
}

export function SpreadsheetPreview({ content, filename, layout }: SpreadsheetPreviewProps) {
  const delimiter = getFileExtension(filename) === 'tsv' ? '\t' : ',';
  const table = useMemo(() => parseCSV(content, delimiter), [content, delimiter]);

  if (!table) {
    return (
      <pre
        className={cn(
          'w-full min-w-0 overflow-auto p-4 text-xs text-foreground',
          layout === 'dialog' && 'max-h-[60vh]'
        )}
      >
        {content || 'No preview content available.'}
      </pre>
    );
  }

  return (
    <div className={cn('p-4', layout === 'dialog' && 'max-h-[60vh] overflow-auto')}>
      <NotebookTable table={table} mode="notebook" />
    </div>
  );
}
```

The `parseCSV` function handles: comma and tab delimiters, quoted fields with commas/newlines, escaped quotes (`""` → `"`), `\r\n` and `\n` line endings. Returns `null` on empty/malformed input → falls back to `<pre>`.

`NotebookTable` already handles: numeric right-alignment, alternating row colors, horizontal scroll with gradient fade, CSV download button, truncation at 100 rows.

#### 3. `src/components/chat-file-preview/file-preview-content.tsx` — wire it up

Add import:

```tsx
import { SpreadsheetPreview } from './spreadsheet-preview';
```

Add `'spreadsheet'` to the fetch condition:

```tsx
const shouldFetchText =
  previewType === 'text' ||
  previewType === 'code' ||
  previewType === 'spreadsheet' ||  // ← ADD
  previewType === 'notebook' ||
  previewType === 'markdown';
```

Add rendering branch between `'code'` and `'markdown'`:

```tsx
{previewType === 'spreadsheet' && (
  <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
    {(textStatus === 'loading' || textStatus === 'idle') && (
      <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
    )}
    {textStatus === 'error' && (
      <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
    )}
    {textStatus === 'ready' && (
      <SpreadsheetPreview
        content={textPreview}
        filename={filename}
        layout={layout}
      />
    )}
  </div>
)}
```

### Verification

- [ ] Preview a `.csv` file → styled table with headers, numeric right-alignment, alternating rows
- [ ] Preview a `.tsv` file → same table rendering, tab-delimited
- [ ] CSV with quoted fields containing commas → parsed correctly
- [ ] CSV with >100 rows → "Showing 100 of N rows" truncation from `NotebookTable`
- [ ] CSV download button works
- [ ] Published `.csv` → styled table on the live page
- [ ] Empty or malformed CSV → falls back to `<pre>`
- [ ] `.xlsx` file → shows error message (binary, can't fetch as text)
