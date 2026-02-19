# Renderer Improvement Plan

Three areas of polish: center the notebook report, pad the markdown preview, and add syntax-highlighted code previews for source files.

---

## 1. Center the Notebook Report Layout

### Problem

Report mode left-aligns its content against the left edge of the preview panel. On narrow screens (panel at ~400px) this is fine — content fills the width. On wide screens (panel at 1200px+ or a published page on a desktop monitor) the content hugs the left wall with empty space on the right.

```
Current (wide screen):                     Goal (wide screen):
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│ ┌────┐ ┌──────────┐             │       │        ┌────┐ ┌──────────┐      │
│ │ TOC│ │ Content  │             │       │        │ TOC│ │ Content  │      │
│ │    │ │          │             │       │        │    │ │          │      │
│ │    │ │          │             │       │        │    │ │          │      │
│ └────┘ └──────────┘             │       │        └────┘ └──────────┘      │
│ ← left-aligned, wasted space → │       │        ← centered block →       │
└──────────────────────────────────┘       └──────────────────────────────────┘
```

On a small screen, the content should still fill the full width:

```
Narrow screen (no change):
┌────────────────────┐
│ ┌────────────────┐ │
│ │    Content     │ │
│ │ (TOC hidden)   │ │
│ │                │ │
│ └────────────────┘ │
└────────────────────┘
```

### Implementation

**File: `src/components/chat-file-preview/notebook-preview/report-mode.tsx`**

The report layout is on line 66:

```tsx
// BEFORE
<div className="notebook-report flex gap-8 px-6 py-6 @3xl:px-4">
```

Wrap the existing flex container in a centering `mx-auto` shell with a max-width. The inner flex stays left-aligned relative to itself, so text/headings don't center — only the block as a whole centers within the viewport.

```tsx
// AFTER
<div className="notebook-report mx-auto w-full max-w-5xl px-6 py-6">
  <div className="flex gap-8">
    <ReportSidebar entries={tocEntries} />
    <div className="min-w-0 max-w-3xl flex-1">
      ...
    </div>
  </div>
</div>
```

Design breakdown:

```
┌─────────────────── viewport / panel ────────────────────┐
│                                                          │
│   ┌──────────── max-w-5xl  mx-auto ───────────────┐     │
│   │  px-6                                   px-6  │     │
│   │  ┌──────┐  ┌──────── max-w-3xl ────────────┐ │     │
│   │  │ TOC  │  │                                │ │     │
│   │  │ w-44 │  │  Report header                 │ │     │
│   │  │      │  │  Body cells                    │ │     │
│   │  │      │  │  Charts, tables, text          │ │     │
│   │  │      │  │  Footer                        │ │     │
│   │  └──────┘  └────────────────────────────────┘ │     │
│   └───────────────────────────────────────────────┘     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- `max-w-5xl` (64rem / 1024px) caps the outer shell. At viewport widths below 1024px the content fills 100%. Above 1024px, the block centers with `mx-auto`.
- The inner `flex gap-8` keeps the sidebar + content side by side.
- The content column keeps its existing `max-w-3xl` (48rem) constraint.
- `px-6` stays on the outer wrapper for breathing room at all sizes.
- Remove the `@3xl:px-4` container query — it reduced padding on wide screens which is the opposite of what we want.

**No other files need changes** — the centering is purely a layout wrapper in `report-mode.tsx`. The published renderer automatically picks this up because it imports `FilePreviewContent` which renders `NotebookPreview` > `ReportMode`.

### Verification

- Preview panel at default width (~450px): content fills width, no visible change
- Preview panel stretched wide: content block centers, text stays left-aligned within
- Published notebook on a 1440px monitor: centered with comfortable margins
- Published notebook on mobile (375px): full-width, no horizontal overflow

---

## 2. Add Padding to the Markdown Preview

### Problem

When a `.md` file is previewed in the chat preview panel, the rendered markdown has no padding around it. Text, headings, and code blocks render flush against the panel edges. The same issue occurs when a `.md` file is published.

```
Current:                                    Goal:
┌──────────────────────────┐               ┌──────────────────────────────┐
│# My Document             │               │                              │
│                          │               │  # My Document               │
│Some paragraph text that  │               │                              │
│runs right up to the edge │               │  Some paragraph text with    │
│of the panel.             │               │  comfortable padding on      │
│                          │               │  all sides.                  │
│```                       │               │                              │
│code block                │               │  ```                         │
│```                       │               │  code block                  │
│                          │               │  ```                         │
└──────────────────────────┘               │                              │
                                           └──────────────────────────────┘
```

For published markdown, the content should also center on wide screens (same logic as notebook reports):

```
Published .md on wide screen:
┌──────────────────────────────────────────────────────────┐
│                                                           │
│          ┌──── max-w-3xl  mx-auto ─────────────┐         │
│          │  px-6                          px-6  │         │
│          │                                      │         │
│          │  # My Document                       │         │
│          │                                      │         │
│          │  Paragraph text that reads like       │         │
│          │  a normal document.                   │         │
│          │                                      │         │
│          └──────────────────────────────────────┘         │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Implementation

**File: `src/components/chat-file-preview/file-preview-content.tsx`**

The markdown rendered section is at lines 299–338. Currently:

```tsx
// Line 308–316
(markdownViewMode ?? 'rendered') === 'rendered' ? (
  <div
    className={cn(
      layout === 'panel'
        ? 'h-full overflow-auto'
        : 'max-h-[60vh] overflow-auto p-6'
    )}
  >
    <MarkdownRenderer content={textPreview} />
  </div>
```

Note: `p-6` only applies in dialog mode. Panel mode has zero padding.

Change to:

```tsx
(markdownViewMode ?? 'rendered') === 'rendered' ? (
  <div
    className={cn(
      layout === 'panel'
        ? 'h-full overflow-auto'
        : 'max-h-[60vh] overflow-auto'
    )}
  >
    <div className="mx-auto max-w-3xl px-6 py-6">
      <MarkdownRenderer content={textPreview} />
    </div>
  </div>
```

This does three things:
1. Adds `px-6 py-6` padding in both panel and dialog modes
2. Caps content width at `max-w-3xl` (48rem / 768px) — a comfortable reading width for prose
3. Centers with `mx-auto` so on wide screens the content doesn't stretch to 1200px+

Design for panel mode:

```
┌──────────── preview panel ──────────────┐
│                                          │
│   ┌──── max-w-3xl  mx-auto ──────┐      │
│   │  px-6                   px-6 │      │
│   │                              │      │
│   │  # Heading                   │      │
│   │                              │      │
│   │  Body text                   │      │
│   │                              │      │
│   │  py-6                        │      │
│   └──────────────────────────────┘      │
│                                          │
└──────────────────────────────────────────┘
```

At typical panel widths (~400–500px) the `max-w-3xl` won't kick in and content fills the width naturally. At wider widths (stretched panel, or published page) the content centers.

**File: `sandbox/create-worker/renderer/main.tsx`**

No changes needed. The published renderer uses `FilePreviewContent` with `layout="panel"`, so the padding and centering above flows through automatically.

### Verification

- Open a `.md` file in the chat preview panel: text should have comfortable padding on all sides
- Published `.md` on desktop: content centered with max-width, not stretched edge-to-edge
- Published `.md` on mobile: full-width with padding, no horizontal overflow
- Markdown source view: unchanged (it has its own `p-3` styling)
- Dialog/popover mode: padding applied consistently

---

## 3. Syntax-Highlighted Code Previews

### Problem

When previewing source code files (`.py`, `.js`, `.ts`, `.go`, `.rs`, `.sql`, `.html`, `.css`, etc.) in the chat preview panel, the content renders as plain monospace `<pre>` text — no syntax highlighting, no line numbers, no language label. This is a jarring downgrade from the polished notebook and markdown renderers.

```
Current text preview (.py file):           Goal:
┌──────────────────────────┐               ┌──────────────────────────────┐
│import pandas as pd       │               │  python                      │
│                          │               │  ┌────────────────────────┐  │
│def analyze(df):          │               │  │  1  import pandas as pd│  │
│    result = df.groupby(  │               │  │  2                     │  │
│        'category'        │               │  │  3  def analyze(df):   │  │
│    ).sum()               │               │  │  4      result = ...   │  │
│    return result         │               │  │  5      return result  │  │
│                          │               │  └────────────────────────┘  │
└──────────────────────────┘               └──────────────────────────────┘
      plain <pre>                               Shiki highlighted
```

### Approach

The codebase already has Shiki configured (`src/lib/shiki-config.ts`) with 20+ languages preloaded and `github-light` / `github-dark` dual themes. The `MarkdownRenderer` uses it for fenced code blocks. We should reuse the same Shiki setup for standalone file previews.

Add a new preview type `'code'` alongside the existing `'text'` type. Code files get syntax highlighting; non-code text files (`.log`, `.txt`, `.csv`) stay as plain `<pre>`.

### Implementation

#### Step 1 — Add `'code'` to the preview type system

**File: `src/components/chat-file-preview/file-type-utils.ts`**

Add `'code'` to the `PreviewType` union:

```tsx
// BEFORE
export type PreviewType =
  | 'image'
  | 'pdf'
  | 'notebook'
  | 'markdown'
  | 'text'
  | 'audio'
  | 'video'
  | 'other';

// AFTER
export type PreviewType =
  | 'image'
  | 'pdf'
  | 'notebook'
  | 'markdown'
  | 'code'
  | 'text'
  | 'audio'
  | 'video'
  | 'other';
```

Update `getPreviewType` to return `'code'` for recognized code extensions:

```tsx
// Map file extensions to Shiki language identifiers
const CODE_HIGHLIGHT_MAP: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  css: 'css',
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'shell',
  xml: 'html',
};

export function getShikiLanguage(filename: string): string | null {
  const ext = getFileExtension(filename);
  return CODE_HIGHLIGHT_MAP[ext] ?? null;
}
```

Update `getPreviewType`:

```tsx
export function getPreviewType(filename: string, contentType?: string): PreviewType {
  const category = getFileCategory(filename, contentType);
  if (category === 'image') return 'image';
  if (category === 'pdf') return 'pdf';
  if (category === 'notebook') return 'notebook';
  if (category === 'audio') return 'audio';
  if (category === 'video') return 'video';
  if (getFileExtension(filename) === 'md') return 'markdown';
  // NEW: code files with syntax highlighting support
  if (getShikiLanguage(filename) !== null) return 'code';
  if (category === 'code' || category === 'text' || category === 'spreadsheet') return 'text';
  return 'other';
}
```

#### Step 2 — Create the `CodePreview` component

**New file: `src/components/chat-file-preview/code-preview.tsx`**

This component takes source text and a filename, determines the language, and renders with Shiki highlighting + line numbers.

```
┌─────────────────────────────────────────────────────┐
│  python                                        [⎘]  │  ← language label + copy button
│  ─────────────────────────────────────────────────── │
│   1  import pandas as pd                             │  ← Shiki-highlighted code
│   2  import numpy as np                              │     with line numbers
│   3                                                  │
│   4  def analyze(df: pd.DataFrame) -> dict:          │
│   5      """Run analysis on the input data."""        │
│   6      result = df.groupby('category').agg(        │
│   7          total=('amount', 'sum'),                 │
│   8          count=('id', 'count'),                   │
│   9      )                                            │
│  10      return result.to_dict()                      │
│  11                                                   │
│  ...                                                  │
│ Showing first 500 of 1,234 lines.                    │  ← truncation notice
└─────────────────────────────────────────────────────┘
```

Component specification:

```tsx
interface CodePreviewProps {
  code: string;
  filename: string;
  layout: 'panel' | 'dialog';
  truncated: boolean;
  totalLines: number;
}
```

Key behaviors:
- Call `getShikiLanguage(filename)` to determine the language
- Use `codeToHtml()` from Shiki with the same `SHIKI_DEFAULT_THEMES` config
- Highlight asynchronously (Shiki is async); show plain `<pre>` as fallback while loading
- Render line numbers in a fixed-width left gutter (`w-12`, right-aligned, `text-muted-foreground/40`, `select-none`)
- Show the language label in the top-left corner (same style as `MarkdownRenderer` code blocks: `text-xs text-muted-foreground font-mono bg-muted/50 rounded-tl-lg rounded-br-lg`)
- Copy-all button in top-right corner (same hover-reveal pattern as `MarkdownRenderer`)
- Use the existing `[&_pre]:!bg-muted/50` Shiki wrapper pattern for background
- If truncated, show "Showing first 500 of N lines." below the code block

Styling:
```
Container:     overflow-auto rounded-lg (dialog adds max-h-[60vh])
Background:    bg-muted/50 (matches existing code block style)
Line numbers:  font-mono text-xs text-muted-foreground/40 select-none
               right-aligned in a w-12 column, pr-4 gap before code
Code:          Shiki-rendered HTML, text-sm font-mono
```

For the line numbers, Shiki's `codeToHtml` returns a `<pre><code>` with `<span class="line">` per line. The implementer should either:
- **(A)** Use CSS to add line numbers via `counter-increment` on `.line` elements (pure CSS, no JS post-processing)
- **(B)** Use Shiki's `transformers` API to inject line number spans during highlighting

Option (A) is simpler. Add to `globals.css`:

```css
.code-preview-lines .line::before {
  content: counter(line);
  counter-increment: line;
  display: inline-block;
  width: 3rem;
  margin-right: 1rem;
  text-align: right;
  color: var(--color-muted-foreground);
  opacity: 0.4;
  user-select: none;
  font-size: 0.75rem;
}

.code-preview-lines code {
  counter-reset: line;
}
```

Then the component just needs to add `code-preview-lines` class to the Shiki wrapper.

#### Step 3 — Wire into `FilePreviewContent`

**File: `src/components/chat-file-preview/file-preview-content.tsx`**

Add a new branch for `previewType === 'code'` between the existing `'text'` and `'markdown'` branches. The data fetching already handles it — `shouldFetchText` includes `previewType === 'text'`, but we need to also include `'code'`:

```tsx
// Line 123 — add 'code' to the fetch condition
const shouldFetchText =
  previewType === 'text' || previewType === 'code' || previewType === 'notebook' || previewType === 'markdown';
```

Add the rendering branch:

```tsx
{previewType === 'code' && (
  <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
    {(textStatus === 'loading' || textStatus === 'idle') && (
      <p className="p-4 text-sm text-muted-foreground">Loading preview...</p>
    )}
    {textStatus === 'error' && (
      <p className="p-4 text-sm text-muted-foreground">{textErrorMessage}</p>
    )}
    {textStatus === 'ready' && (
      <CodePreview
        code={textPreview}
        filename={filename}
        layout={layout}
        truncated={lineInfo.truncated}
        totalLines={lineInfo.totalLines}
      />
    )}
  </div>
)}
```

#### Step 4 — Update file-type-utils exports

No changes to `getFileCategory` — it still returns `'code'` for code extensions. Only `getPreviewType` changes behavior, routing code files to the new `'code'` preview type instead of falling through to `'text'`.

Files that are in `CODE_EXTENSIONS` but NOT in `CODE_HIGHLIGHT_MAP` (e.g., `.txt`, `.log`) will still return `'text'` and render as plain `<pre>`.

### Files Summary

| File | Action | Change |
|------|--------|--------|
| `src/components/chat-file-preview/file-type-utils.ts` | Modify | Add `'code'` to `PreviewType`, add `CODE_HIGHLIGHT_MAP`, add `getShikiLanguage()`, update `getPreviewType()` |
| `src/components/chat-file-preview/code-preview.tsx` | **New** | `CodePreview` component with Shiki highlighting + line numbers |
| `src/components/chat-file-preview/file-preview-content.tsx` | Modify | Add `'code'` to fetch condition, add rendering branch |
| `src/styles/globals.css` | Modify | Add `.code-preview-lines` counter-based line numbers |

### What NOT to change

- `.txt`, `.log`, `.csv`, `.tsv` files keep the plain `<pre>` rendering — they aren't programming languages
- The `MarkdownRenderer` code block highlighting is untouched — it already works correctly
- The notebook syntax highlighter (`syntax-highlighter.tsx`) is untouched — it has its own Python-specific implementation for code cells

### Verification

- Preview a `.py` file: syntax highlighted with line numbers
- Preview a `.ts` file: highlighted with TypeScript grammar
- Preview a `.json` file: highlighted with JSON grammar
- Preview a `.txt` file: plain `<pre>`, no highlighting (unchanged)
- Preview a `.csv` file: plain `<pre>`, no highlighting (unchanged)
- Publish a `.py` file: syntax highlighted on the published page (inherits from `FilePreviewContent`)
- Dark mode: colors switch to `github-dark` theme automatically
- Large file (>500 lines): truncation notice appears

---

## 4. Additional Polish Recommendations

These are smaller improvements the implementer can optionally tackle after the three main changes above.

### 4a. Spreadsheet Preview (CSV/TSV)

Currently `.csv` and `.tsv` files render as raw text in a `<pre>` block. The notebook renderer already has a sophisticated `NotebookTable` component (`notebook-preview/notebook-table.tsx`) that handles:
- Column alignment detection (numeric → right-align)
- Alternating row colors
- Horizontal scroll with gradient fade
- CSV export

**Recommendation:** Create a `SpreadsheetPreview` component that parses CSV/TSV into rows and reuses the same table styling from `NotebookTable`. Add `'spreadsheet'` to `PreviewType` and route `.csv`/`.tsv` files to it.

This is a moderate effort but would be a significant UX improvement — structured data should look structured.

### 4b. Image Preview Checkerboard Background

Images with transparency (PNG, WebP) currently render on the theme background color, making it hard to see where the image ends and the background begins.

**Recommendation:** Add a subtle checkerboard pattern behind images (the standard pattern from Figma/Photoshop). A CSS-only approach:

```css
.image-transparency-grid {
  background-image:
    linear-gradient(45deg, var(--color-muted) 25%, transparent 25%),
    linear-gradient(-45deg, var(--color-muted) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--color-muted) 75%),
    linear-gradient(-45deg, transparent 75%, var(--color-muted) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
```

Low effort, nice visual improvement.

### 4c. SVG Preview (Render Instead of Source)

Currently `.svg` files are categorized as `'image'` and render in an `<img>` tag. This works but doesn't allow interaction. Consider:
- Keep the current `<img>` rendering as default (safe, sandboxed)
- No change needed — SVG rendering actually works fine as-is

### 4d. Text Preview Padding Consistency

The plain text `<pre>` preview in panel mode has no padding (same issue as markdown). Currently at line 281:

```tsx
layout === 'panel'
  ? 'h-full max-h-full'          // no padding!
  : 'max-h-[60vh] rounded-md border bg-muted/30 p-3'
```

**Recommendation:** Add `p-4` to the panel mode text preview:

```tsx
layout === 'panel'
  ? 'h-full max-h-full p-4'
  : 'max-h-[60vh] rounded-md border bg-muted/30 p-3'
```

This is a one-line change that improves the text preview experience.

---

## Implementation Order

1. **Markdown padding** (smallest change, immediate visual improvement)
2. **Notebook centering** (small change in one file, high impact)
3. **Code syntax highlighting** (new component, moderate effort)
4. **Optional polish** (4d text padding first since it's trivial, then others as desired)

## Files Summary (All Changes)

| File | Action | Purpose |
|------|--------|---------|
| `src/components/chat-file-preview/file-preview-content.tsx` | Modify | Markdown padding + centering, code preview branch, text padding |
| `src/components/chat-file-preview/notebook-preview/report-mode.tsx` | Modify | Center the report layout |
| `src/components/chat-file-preview/file-type-utils.ts` | Modify | Add `'code'` preview type, language map |
| `src/components/chat-file-preview/code-preview.tsx` | **New** | Syntax-highlighted code preview component |
| `src/styles/globals.css` | Modify | Line number CSS for code previews |

## Components Used

- `codeToHtml` from `shiki` — already a dependency, used in `MarkdownRenderer`
- `SHIKI_DEFAULT_THEMES`, `PRELOAD_LANGUAGES` from `@/lib/shiki-config` — existing config
- `cn()` from `@/lib/utils` — class merging
- `Check`, `Copy` from `lucide-react` — copy button icons (same as `MarkdownRenderer`)

## Not in Scope

- Notebook mode layout changes (only report mode centers)
- Markdown renderer component changes (padding is added at the container level, not inside `MarkdownRenderer`)
- New dependencies (everything uses existing Shiki setup)
- Published page toolbar changes (the toolbar in `renderer/main.tsx` is untouched)
