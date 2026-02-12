# Notebook Renderer Restyle

## Problem

The notebook preview in the chat panel renders all `.ipynb` files as a flat list of cells — every cell visible, no hierarchy, no distinction between setup code and meaningful output. The result reads like raw source code rather than a polished analysis. Users generating data-driven reports in notebooks deserve a presentation layer that treats the output as a readable document.

This plan introduces two viewing modes — **Report** and **Notebook** — toggled from the preview panel header. Report mode transforms the notebook into an article-like experience with an editorial header, sidebar table of contents, hidden boilerplate cells, and refined output styling. Notebook mode retains the traditional cell-by-cell view with improved code presentation.

---

## Design

### Mode Toggle (Preview Panel Header)

The toggle lives in the file preview header bar in `Chat.tsx`, visible only when the previewed file is a `.ipynb` notebook. It appears between the filename and the toolbar buttons.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ● analysis.ipynb                 ┌─────────┬──────────┐   ↻  ↗  ✕      │
│    workspace: /home/...           │ Report  │ Notebook │                  │
│                                   └─────────┴──────────┘                  │
└────────────────────────────────────────────────────────────────────────────┘
```

- Use the shadcn `Tabs` component (`TabsList` + `TabsTrigger`) with `variant="outline"` sizing
- Default to **Report** mode when a notebook is first opened
- Toggle state is local to the preview panel (not persisted)

### Report Mode — Full Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│                    PYTHON NOTEBOOK  ·  ANALYSIS                          │
│                                                                          │
│                    French Executive Directory —                           │
│                    Exploratory Data Analysis                              │
│                                                                          │
│                    This dataset is a directory of French                  │
│                    business executives, including their                   │
│                    personal details, roles, companies...                  │
│                                                                          │
│                    Feb 11, 2026 · 1:24 PM · 14 cells · 5 visualizations  │
│                    ──────────────────────────────────────                 │
│                                                                          │
│  ┌─────────────┐  ┌──────────────────────────────────────────────────┐   │
│  │  CONTENTS   │  │                                                  │   │
│  │             │  │  ## 1. Gender Distribution                       │   │
│  │  ▎1. Gender │  │                                                  │   │
│  │  2. Indus…  │  │  The `CIVILITE` column indicates gender:         │   │
│  │  4. Geogr…  │  │  **Monsieur** (Mr.) vs **Madame** (Ms./Mrs.).   │   │
│  │  5. Exec …  │  │                                                  │   │
│  │  9. Hobbi…  │  │  ┌──────────────────────────────────────┐        │   │
│  │  Key Find…  │  │  │                                      │        │   │
│  │             │  │  │        (Plotly chart)                 │        │   │
│  │             │  │  │                                      │        │   │
│  │             │  │  └──────────────────────────────────────┘        │   │
│  │             │  │                                                  │   │
│  │             │  │  ┌────────────────────────────────────────────┐  │   │
│  │             │  │  │  Monsieur    4,821  (68.3%)               │  │   │
│  │             │  │  │  Madame      2,237  (31.7%)               │  │   │  ← inset well
│  │             │  │  └────────────────────────────────────────────┘  │   │
│  │             │  │                                                  │   │
│  │             │  │  ──────────────────────────────────────────────  │   │
│  │             │  │  Rendered by Chiridion          6 code · Py 3.13│   │
│  └─────────────┘  └──────────────────────────────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Notebook Mode — Full Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  Markdown cell                                                      │ │
│  │  ┌─────────────────────────────────────────────────────────────┐    │ │
│  │  │  # French Executive Directory — Exploratory Data Analysis  │    │ │
│  │  │  This dataset is a directory of...                         │    │ │
│  │  └─────────────────────────────────────────────────────────────┘    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  [1]  │  import pandas as pd                             660ms    │ │
│  │       │  import matplotlib.pyplot as plt                          │ │
│  │       │  import seaborn as sns                                    │ │
│  │       ├───────────────────────────────────────────────────────────│ │
│  │       │  (no output)                                              │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  [2]  │  1  df = pd.read_csv('executives.csv')           1.3s    │ │
│  │       │  2  df.head()                                             │ │
│  │       ├───────────────────────────────────────────────────────────│ │
│  │       │     CIVILITE  NOM     PRENOM   ...                        │ │
│  │       │  0  Monsieur  Dupont  Jean     ...                        │ │
│  │       │  1  Madame    Martin  Sophie   ...                        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Inset Well (Report Mode Text Output)

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │  ← bg-muted/50
│    Monsieur    4,821  (68.3%)                                    │  ← font-mono, text-sm
│    Madame      2,237  (31.7%)                                    │  ← leading-relaxed
│                                                                  │
│    Total:      7,058                                             │
│                                                                  │  ← rounded-xl
└──────────────────────────────────────────────────────────────────┘  ← shadow-[inset_0_2px_4px_rgba(0,0,0,0.06)]
     ▲
     No border. Inset box-shadow creates recessed look.
     Generous padding (p-5). Pre-wrap whitespace.
```

### Code Cell Card (Notebook Mode)

```
┌──────────────────────────────────────────────────────────────────┐
│        │                                                         │
│  [1]   │  1  import pandas as pd                                 │  ← dark bg, syntax colored
│        │  2  import matplotlib.pyplot as plt                     │
│  660ms │  3  import seaborn as sns                               │
│        │                                                         │
│        ├─────────────────────────────────────────────────────────│
│        │                                                         │
│        │  (output area — text, chart, or image)                  │  ← lighter bg
│        │                                                         │
└──────────────────────────────────────────────────────────────────┘
  ▲ gutter     ▲ divider      ▲ code area
  w-16         border-r       flex-1
  text-muted   border-border  bg-zinc-950 dark:bg-zinc-900
  text-center
```

### Sidebar Active State

```
  CONTENTS
                          ← monospace, uppercase, tracking-widest, text-muted-foreground/50
  ▎1. Gender Distribution ← active: text-foreground font-semibold + 2px left accent bar
   2. Industry Sector...  ← inactive: text-muted-foreground, truncate
   4. Geographic Dist...
   5. Executive Age &...
   9. Hobbies & Inter...
   Key Findings          ← no section number = still shows in TOC
```

---

## Implementation

### Step 0 — Add a Display/Heading Font

The report mode header and section headings call for a serif or display-weight font. The current stack only has Figtree (sans) and Geist Mono (mono).

**File: `src/root.tsx`**

Add a Google Font import for a display serif. Recommended: **Instrument Serif** (clean editorial feel, good weight range, pairs well with Figtree).

Add to the existing Google Fonts stylesheet URL:
```
Instrument+Serif:ital,wght@0,400;1,400
```

**File: `src/styles/globals.css`**

Add a CSS custom property alongside the existing font vars:
```css
--font-display: "Instrument Serif", ui-serif, Georgia, "Times New Roman", serif;
```

This font is used *only* in report mode for the title and section headings. Everything else continues to use Figtree and Geist Mono.

---

### Step 1 — Extract `NotebookPreview` into Its Own File

**Current state:** `NotebookPreview` lives inline in `file-preview-content.tsx` (lines 241–317) alongside all the helper functions and types.

**New file: `src/components/chat-file-preview/notebook-preview/index.tsx`**

Move these items out of `file-preview-content.tsx` into the new module:
- All `Notebook*` interfaces (`NotebookOutput`, `NotebookCell`, `NotebookFile`, `NotebookOutputRender`)
- All helper functions (`toText`, `toHtml`, `buildPlotlyHtmlDocument`, `buildHtmlDocument`, `getHtmlOutputDocument`, `getOutputText`, `getImageDataUrl`, `getOutputRender`)
- `NotebookHtmlOutput` component
- `NotebookPreview` component (will be expanded significantly)

Export `NotebookPreview`, `NotebookFile`, and `NotebookCell` from the new file's index. Update the import in `file-preview-content.tsx` to pull from the new location.

**New directory structure:**
```
src/components/chat-file-preview/notebook-preview/
├── index.tsx                  ← Main NotebookPreview component + mode switching
├── types.ts                   ← Notebook interfaces (NotebookFile, NotebookCell, NotebookOutput, etc.)
├── utils.ts                   ← Shared helpers (toText, toHtml, getOutputRender, etc.)
├── cell-classifier.ts         ← Report mode cell classification heuristics
├── notebook-header.ts         ← Header extraction logic (title, subtitle, metadata)
├── report-mode.tsx            ← ReportModeView component
├── notebook-mode.tsx          ← NotebookModeView component
├── report-header.tsx          ← Editorial header component
├── report-sidebar.tsx         ← Table of contents sidebar
├── report-footer.tsx          ← Footer component
├── report-markdown-cell.tsx   ← Markdown cell rendering (report mode)
├── notebook-code-cell.tsx     ← Code cell with gutter (notebook mode)
├── notebook-markdown-cell.tsx ← Markdown cell in card (notebook mode)
├── output-renderers.tsx       ← Output rendering (shared between modes)
├── syntax-highlighter.tsx     ← Python syntax highlighting for notebook mode
└── plotly-placeholder.tsx     ← Loading placeholder for Plotly charts
```

---

### Step 2 — Add Mode Toggle to Preview Panel Header

**File: `src/components/Chat.tsx`**

In the file preview header bar (around line 2687), detect when the previewed file is a notebook and render a mode toggle.

**State addition:**
```tsx
const [notebookViewMode, setNotebookViewMode] = useState<'report' | 'notebook'>('report');
```

**Detection helper:**
```tsx
const isNotebookPreview = previewTarget?.kind === 'file' && previewFileName.endsWith('.ipynb');
```

**Header modification** — insert the toggle between the filename area and the toolbar buttons:

```tsx
<div className="flex items-center justify-between px-4 py-2 border-b border-border">
  {/* Left: filename */}
  <div className="min-w-0 flex items-center gap-2">
    <div className="w-2 h-2 bg-blue-500 rounded-full shrink-0" />
    <div className="min-w-0">
      <div className="text-sm font-medium truncate">{previewFileName}</div>
      <div className="text-xs text-muted-foreground truncate">
        {previewTarget.source}: {previewTarget.path}
      </div>
    </div>
  </div>

  {/* Center: mode toggle (notebooks only) */}
  {isNotebookPreview && (
    <Tabs value={notebookViewMode} onValueChange={(v) => setNotebookViewMode(v as 'report' | 'notebook')}>
      <TabsList className="h-7">
        <TabsTrigger value="report" className="text-xs px-3 h-6">Report</TabsTrigger>
        <TabsTrigger value="notebook" className="text-xs px-3 h-6">Notebook</TabsTrigger>
      </TabsList>
    </Tabs>
  )}

  {/* Right: toolbar buttons (existing) */}
  <div className="flex items-center gap-2">
    {/* ... existing Reload, Open in new tab, Close buttons ... */}
  </div>
</div>
```

**Pass mode to `FilePreviewContent`:**

Add an optional `notebookViewMode` prop to `FilePreviewContentProps`:
```tsx
export interface FilePreviewContentProps {
  filename: string;
  previewUrl: string;
  contentType?: string;
  layout?: PreviewLayout;
  notebookViewMode?: 'report' | 'notebook';  // NEW
}
```

Thread it through to `NotebookPreview`:
```tsx
<NotebookPreview notebook={notebook} layout={layout} viewMode={notebookViewMode ?? 'report'} />
```

**Imports needed in `Chat.tsx`:**
- `Tabs`, `TabsList`, `TabsTrigger` from `@/components/ui/tabs`

---

### Step 3 — Types & Utilities Module

**New file: `src/components/chat-file-preview/notebook-preview/types.ts`**

Move all interfaces here. Extend `NotebookCell` with execution metadata:

```typescript
export interface NotebookCellMetadata {
  execution?: {
    'iopub.execute_input'?: string;   // ISO 8601 start time
    'shell.execute_reply'?: string;    // ISO 8601 end time
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  traceback?: string[];
  ename?: string;
  evalue?: string;
  data?: Record<string, unknown>;
}

export interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  metadata?: NotebookCellMetadata;
}

export interface NotebookKernelspec {
  display_name?: string;
  language?: string;
  name?: string;
}

export interface NotebookLanguageInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface NotebookFile {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: {
    kernelspec?: NotebookKernelspec;
    language_info?: NotebookLanguageInfo;
    [key: string]: unknown;
  };
  cells?: NotebookCell[];
}

export type CellClassification = 'show' | 'setup';

export interface ClassifiedCell {
  cell: NotebookCell;
  classification: CellClassification;
  index: number;
}

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface NotebookHeader {
  title: string | null;
  subtitle: string | null;
  executionTimestamp: Date | null;
  cellCount: number;
  visualizationCount: number;
  titleCellIndex: number | null;       // index of cell consumed by header
}
```

**New file: `src/components/chat-file-preview/notebook-preview/utils.ts`**

Move these existing helpers here (from `file-preview-content.tsx`):
- `toText`
- `toHtml`
- `buildPlotlyHtmlDocument`
- `buildHtmlDocument`
- `getHtmlOutputDocument`
- `getOutputText`
- `getImageDataUrl`
- `getOutputRender`

Add new helpers:

```typescript
/** Format execution duration from start/end ISO timestamps */
export function formatExecutionTime(startIso?: string, endIso?: string): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Strip markdown formatting (bold, italic, backticks) from text */
export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')    // bold
    .replace(/\*(.+?)\*/g, '$1')          // italic
    .replace(/`(.+?)`/g, '$1')            // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')   // links
    .trim();
}

/** Format a Date as "Feb 11, 2026 · 1:24 PM" */
export function formatNotebookDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }) + '  ·  ' + date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/** Check if an output contains a chart/image MIME type */
export function hasVisualOutput(outputs: NotebookOutput[]): boolean {
  return outputs.some(o => {
    const data = o.data ?? {};
    return (
      'application/vnd.plotly.v1+json' in data ||
      'image/png' in data ||
      'image/svg+xml' in data ||
      'text/html' in data
    );
  });
}
```

---

### Step 4 — Cell Classification

**New file: `src/components/chat-file-preview/notebook-preview/cell-classifier.ts`**

This module classifies each code cell as `'show'` or `'setup'` for report mode. Markdown cells are always `'show'`.

```typescript
import type { NotebookCell, CellClassification } from './types';
import { hasVisualOutput, toText } from './utils';

export function classifyCell(cell: NotebookCell): CellClassification {
  // Markdown cells are always shown
  if (cell.cell_type === 'markdown') return 'show';

  const source = toText(cell.source);
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];

  // Rule 5: Chart/image producers are ALWAYS shown
  if (hasVisualOutput(outputs)) return 'show';

  const lines = source.split('\n').filter(l => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });

  if (lines.length === 0) return 'setup';

  // Rule 1: Import-heavy cells
  const importLines = lines.filter(l => /^\s*(import |from .+ import )/.test(l));
  if (importLines.length / lines.length >= 0.6) return 'setup';

  // Rule 2: Data loading cells
  const loadingPatterns = [
    '.read_csv(', '.read_sql(', '.read_excel(',
    '.read_json(', '.read_parquet(', '.read_feather(',
    '.read_pickle(', '.read_hdf(', '.read_stata(',
  ];
  if (loadingPatterns.some(p => source.includes(p))) return 'setup';

  // Rule 3: Data profiling cells
  const profilingPatterns = [
    '.info()', '.describe()', '.head()', '.tail()',
    '.dtypes', '.columns', '.shape', '.sample(',
    '.nunique()', '.value_counts()',
  ];
  if (profilingPatterns.some(p => source.includes(p))) {
    const outputText = outputs.map(o => getOutputText(o)).join('\n');
    const isProfileOutput =
      (outputText.match(/\d+\/\d+/g)?.length ?? 0) >= 3 ||
      /dtype:|non-null|memory usage|RangeIndex/.test(outputText);
    if (isProfileOutput) return 'setup';
  }

  // Rule 4: Configuration cells
  const configPatterns = [
    'warnings.filterwarnings', '%matplotlib',
    'sns.set', 'plt.style', 'pd.set_option',
    'pd.options.', 'plt.rcParams',
  ];
  const isConfigOnly = lines.every(l =>
    configPatterns.some(p => l.trim().startsWith(p) || l.trim().includes(p))
  );
  if (isConfigOnly) return 'setup';

  // Rule 6: Default — show
  return 'show';
}

export function classifyCells(cells: NotebookCell[]): ClassifiedCell[] {
  return cells.map((cell, index) => ({
    cell,
    classification: classifyCell(cell),
    index,
  }));
}
```

---

### Step 5 — Header Extraction

**New file: `src/components/chat-file-preview/notebook-preview/notebook-header.ts`**

Extracts the editorial header from the notebook structure.

```typescript
import type { NotebookFile, NotebookHeader } from './types';
import { toText, stripMarkdownFormatting, hasVisualOutput } from './utils';

export function extractHeader(notebook: NotebookFile): NotebookHeader {
  const cells = notebook.cells ?? [];
  let title: string | null = null;
  let subtitle: string | null = null;
  let titleCellIndex: number | null = null;

  // Find the first markdown cell with a # heading
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.cell_type !== 'markdown') continue;

    const source = toText(cell.source);
    const lines = source.split('\n');
    const h1LineIndex = lines.findIndex(l => /^#\s+/.test(l.trim()));

    if (h1LineIndex === -1) continue;

    title = stripMarkdownFormatting(lines[h1LineIndex].replace(/^#\s+/, ''));
    titleCellIndex = i;

    // Subtitle = all paragraph lines after the h1 in this cell
    const remainingLines = lines.slice(h1LineIndex + 1);
    const subtitleLines: string[] = [];
    for (const line of remainingLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) break;      // stop at next heading
      if (trimmed.length > 0) subtitleLines.push(trimmed);
    }
    if (subtitleLines.length > 0) {
      subtitle = stripMarkdownFormatting(subtitleLines.join(' '));
    }
    break;
  }

  // Execution timestamp from first code cell with metadata
  let executionTimestamp: Date | null = null;
  for (const cell of cells) {
    if (cell.cell_type !== 'code') continue;
    const startTime = cell.metadata?.execution?.['iopub.execute_input'];
    if (typeof startTime === 'string') {
      const parsed = new Date(startTime);
      if (!isNaN(parsed.getTime())) {
        executionTimestamp = parsed;
        break;
      }
    }
  }

  // Visualization count = code cells with chart/image outputs
  const visualizationCount = cells.filter(c =>
    c.cell_type === 'code' && hasVisualOutput(c.outputs ?? [])
  ).length;

  return {
    title,
    subtitle,
    executionTimestamp,
    cellCount: cells.length,
    visualizationCount,
    titleCellIndex,
  };
}
```

---

### Step 6 — Report Mode Components

#### 6a — Report Header

**New file: `src/components/chat-file-preview/notebook-preview/report-header.tsx`**

```tsx
import type { NotebookHeader } from './types';
import { formatNotebookDate } from './utils';
import { Separator } from '@/components/ui/separator';

interface ReportHeaderProps {
  header: NotebookHeader;
}

export function ReportHeader({ header }: ReportHeaderProps) {
  const metadataItems: string[] = [];
  if (header.executionTimestamp) {
    metadataItems.push(formatNotebookDate(header.executionTimestamp));
  }
  metadataItems.push(`${header.cellCount} cells`);
  if (header.visualizationCount > 0) {
    metadataItems.push(`${header.visualizationCount} visualizations`);
  }

  return (
    <div className="mb-8">
      {/* Category label */}
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50 mb-4">
        Python Notebook  ·  Analysis
      </p>

      {/* Title */}
      {header.title && (
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-normal tracking-tight text-foreground leading-tight mb-3">
          {header.title}
        </h1>
      )}

      {/* Subtitle */}
      {header.subtitle && (
        <p className="text-base text-muted-foreground leading-relaxed max-w-[540px] mb-5">
          {header.subtitle}
        </p>
      )}

      {/* Metadata line */}
      <p className="font-mono text-xs text-muted-foreground/60">
        {metadataItems.join('  ·  ')}
      </p>

      <Separator className="mt-6" />
    </div>
  );
}
```

#### 6b — Report Sidebar (Table of Contents)

**New file: `src/components/chat-file-preview/notebook-preview/report-sidebar.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { TocEntry } from './types';

interface ReportSidebarProps {
  entries: TocEntry[];
}

export function ReportSidebar({ entries }: ReportSidebarProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    // Set up intersection observer to track active section
    const headingElements = entries
      .map(e => document.getElementById(e.id))
      .filter(Boolean) as HTMLElement[];

    if (headingElements.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (intersectionEntries) => {
        // Find the first visible heading
        for (const entry of intersectionEntries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    headingElements.forEach(el => observerRef.current!.observe(el));

    return () => observerRef.current?.disconnect();
  }, [entries]);

  if (entries.length === 0) return null;

  const handleClick = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  };

  return (
    <nav className="sticky top-4 hidden lg:block w-44 shrink-0 pt-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/50 mb-3">
        Contents
      </p>
      <ul className="space-y-1.5">
        {entries.map(entry => {
          const isActive = activeId === entry.id;
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => handleClick(entry.id)}
                className={cn(
                  'block w-full text-left text-[13px] leading-snug truncate transition-colors',
                  entry.level === 3 && 'pl-3',
                  isActive
                    ? 'text-foreground font-semibold border-l-2 border-primary pl-2.5'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {entry.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

**TOC entry extraction** — add a helper in `utils.ts`:

```typescript
export function extractTocEntries(cells: NotebookCell[], titleCellIndex: number | null): TocEntry[] {
  const entries: TocEntry[] = [];
  let counter = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.cell_type !== 'markdown') continue;

    const source = toText(cell.source);
    const lines = source.split('\n');

    for (const line of lines) {
      const h2Match = line.match(/^##\s+(.+)/);
      const h3Match = line.match(/^###\s+(.+)/);

      if (h2Match) {
        const text = stripMarkdownFormatting(h2Match[1]);
        const id = `toc-${counter++}`;
        entries.push({ id, text, level: 2 });
      } else if (h3Match) {
        const text = stripMarkdownFormatting(h3Match[1]);
        const id = `toc-${counter++}`;
        entries.push({ id, text, level: 3 });
      }
    }
  }

  return entries;
}
```

#### 6c — Report Footer

**New file: `src/components/chat-file-preview/notebook-preview/report-footer.tsx`**

```tsx
import { Separator } from '@/components/ui/separator';

interface ReportFooterProps {
  codeCellCount: number;
  languageVersion?: string;
}

export function ReportFooter({ codeCellCount, languageVersion }: ReportFooterProps) {
  const rightText = [
    `${codeCellCount} code ${codeCellCount === 1 ? 'cell' : 'cells'}`,
    languageVersion ? `Python ${languageVersion}` : null,
  ].filter(Boolean).join('  ·  ');

  return (
    <div className="mt-12">
      <Separator />
      <div className="flex items-center justify-between pt-3">
        <span className="font-mono text-[10px] text-muted-foreground/40">
          Rendered by Chiridion
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/40">
          {rightText}
        </span>
      </div>
    </div>
  );
}
```

#### 6d — Report Mode View (Main Report Composition)

**New file: `src/components/chat-file-preview/notebook-preview/report-mode.tsx`**

This is the top-level component that composes the report layout: header, sidebar, body, footer.

```tsx
import { useMemo } from 'react';
import type { NotebookFile, ClassifiedCell, TocEntry } from './types';
import { toText, extractTocEntries } from './utils';
import { extractHeader } from './notebook-header';
import { classifyCells } from './cell-classifier';
import { ReportHeader } from './report-header';
import { ReportSidebar } from './report-sidebar';
import { ReportFooter } from './report-footer';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { OutputRenderer } from './output-renderers';

interface ReportModeProps {
  notebook: NotebookFile;
}

export function ReportMode({ notebook }: ReportModeProps) {
  const cells = notebook.cells ?? [];
  const header = useMemo(() => extractHeader(notebook), [notebook]);
  const classifiedCells = useMemo(() => classifyCells(cells), [cells]);
  const tocEntries = useMemo(() => extractTocEntries(cells, header.titleCellIndex), [cells, header]);

  const codeCellCount = cells.filter(c => c.cell_type === 'code').length;
  const languageVersion = notebook.metadata?.language_info?.version;

  // Filter: only 'show' cells, skip the title cell's h1 content
  const visibleCells = classifiedCells.filter(c => c.classification === 'show');

  return (
    <div className="flex gap-8 px-4 py-6">
      {/* Sidebar (hidden on narrow viewports) */}
      <ReportSidebar entries={tocEntries} />

      {/* Main content */}
      <div className="min-w-0 flex-1 max-w-2xl">
        <ReportHeader header={header} />

        <div className="space-y-6">
          {visibleCells.map(({ cell, index }) => {
            if (cell.cell_type === 'markdown') {
              const source = toText(cell.source);
              // If this is the title cell, strip the h1 heading and subtitle
              // (they are already rendered in the header)
              let displaySource = source;
              if (index === header.titleCellIndex) {
                const lines = source.split('\n');
                const h1Index = lines.findIndex(l => /^#\s+/.test(l.trim()));
                if (h1Index !== -1) {
                  // Remove h1 line and all following paragraph lines until next heading
                  const remaining: string[] = [];
                  let pastSubtitle = false;
                  for (let i = h1Index + 1; i < lines.length; i++) {
                    if (!pastSubtitle && !lines[i].trim().startsWith('#') && lines[i].trim().length > 0) {
                      continue; // skip subtitle paragraph
                    }
                    pastSubtitle = true;
                    remaining.push(lines[i]);
                  }
                  // Also keep lines before h1
                  displaySource = [...lines.slice(0, h1Index), ...remaining].join('\n').trim();
                }
              }
              if (!displaySource) return null;

              return (
                <ReportMarkdownSection key={`cell-${index}`} source={displaySource} tocEntries={tocEntries} />
              );
            }

            // Code cell — only show outputs (code is hidden in report mode)
            const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
            if (outputs.length === 0) return null;

            return (
              <div key={`cell-${index}`} className="space-y-4">
                {outputs.map((output, oi) => (
                  <OutputRenderer
                    key={`output-${index}-${oi}`}
                    output={output}
                    mode="report"
                    layout="panel"
                    title={`Output ${oi + 1}`}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <ReportFooter codeCellCount={codeCellCount} languageVersion={languageVersion} />
      </div>
    </div>
  );
}
```

The `ReportMarkdownSection` component handles injecting `id` attributes onto headings for TOC scroll-tracking. It wraps `MarkdownRenderer` and post-processes the rendered HTML to add IDs based on heading text, matching them to `tocEntries`. This can be done by rendering markdown to an element and using a `ref` + `useEffect` to stamp IDs onto `h2`/`h3` elements.

---

### Step 7 — Notebook Mode Components

#### 7a — Python Syntax Highlighter

**New file: `src/components/chat-file-preview/notebook-preview/syntax-highlighter.tsx`**

A lightweight Python-specific syntax highlighter for code cells. Uses regex-based tokenization (no external library dependency beyond what's already in the project).

**Note:** The existing codebase already uses Shiki for `MarkdownRenderer` code blocks. The implementer should decide whether to:
- **(A) Reuse Shiki** — call the same Shiki highlighter with `lang: 'python'`. Preferred if bundle size is acceptable and Shiki is already loaded client-side.
- **(B) Lightweight regex highlighter** — a simple function that wraps tokens in `<span>`s with color classes. Smaller bundle, faster render, but less accurate highlighting.

Either approach works. The key requirements:
- Dark background (`bg-zinc-950 dark:bg-zinc-900`)
- Line numbers displayed in a narrow left column, muted color, right-aligned
- Syntax colors for: keywords, builtins, strings, comments, numbers, decorators
- Monospace font (`font-mono`)

#### 7b — Notebook Code Cell

**New file: `src/components/chat-file-preview/notebook-preview/notebook-code-cell.tsx`**

```tsx
import type { NotebookCell } from './types';
import { toText, formatExecutionTime } from './utils';
import { OutputRenderer } from './output-renderers';

interface NotebookCodeCellProps {
  cell: NotebookCell;
  cellIndex: number;
}

export function NotebookCodeCell({ cell, cellIndex }: NotebookCodeCellProps) {
  const source = toText(cell.source);
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const execCount = typeof cell.execution_count === 'number'
    ? `[${cell.execution_count}]`
    : '[ ]';

  const execTime = formatExecutionTime(
    cell.metadata?.execution?.['iopub.execute_input'],
    cell.metadata?.execution?.['shell.execute_reply']
  );

  const lines = source.split('\n');

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Code area with gutter */}
      <div className="flex">
        {/* Gutter */}
        <div className="w-16 shrink-0 flex flex-col items-center justify-between py-3 px-2 border-r border-border bg-muted/30 text-muted-foreground">
          <span className="font-mono text-[11px]">{execCount}</span>
          {execTime && (
            <span className="font-mono text-[10px] text-muted-foreground/50">{execTime}</span>
          )}
        </div>

        {/* Code block */}
        <div className="flex-1 min-w-0 overflow-auto bg-zinc-950 dark:bg-zinc-900 p-3">
          <pre className="font-mono text-[13px] leading-relaxed text-zinc-100">
            {/* Line numbers + syntax-highlighted code */}
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="inline-block w-8 shrink-0 text-right pr-4 text-zinc-600 select-none text-xs">
                  {i + 1}
                </span>
                <code>{/* syntax-highlighted line */}{line}</code>
              </div>
            ))}
          </pre>
        </div>
      </div>

      {/* Outputs */}
      {outputs.length > 0 && (
        <div className="border-t border-border bg-muted/10 p-3 space-y-2">
          {outputs.map((output, oi) => (
            <OutputRenderer
              key={`output-${cellIndex}-${oi}`}
              output={output}
              mode="notebook"
              layout="panel"
              title={`Output ${oi + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

#### 7c — Notebook Markdown Cell

**New file: `src/components/chat-file-preview/notebook-preview/notebook-markdown-cell.tsx`**

Wraps the markdown content in a card container for notebook mode.

```tsx
import type { NotebookCell } from './types';
import { toText } from './utils';
import { MarkdownRenderer } from '@/components/markdown-renderer';

interface NotebookMarkdownCellProps {
  cell: NotebookCell;
}

export function NotebookMarkdownCell({ cell }: NotebookMarkdownCellProps) {
  const source = toText(cell.source);
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="text-[11px] font-medium text-muted-foreground mb-2">Markdown</div>
      <MarkdownRenderer content={source || '_Empty cell_'} />
    </div>
  );
}
```

#### 7d — Notebook Mode View

**New file: `src/components/chat-file-preview/notebook-preview/notebook-mode.tsx`**

```tsx
import type { NotebookFile } from './types';
import { NotebookCodeCell } from './notebook-code-cell';
import { NotebookMarkdownCell } from './notebook-markdown-cell';

interface NotebookModeProps {
  notebook: NotebookFile;
}

export function NotebookMode({ notebook }: NotebookModeProps) {
  const cells = notebook.cells ?? [];

  return (
    <div className="space-y-3 p-3">
      {cells.map((cell, index) => (
        cell.cell_type === 'markdown'
          ? <NotebookMarkdownCell key={`cell-${index}`} cell={cell} />
          : <NotebookCodeCell key={`cell-${index}`} cell={cell} cellIndex={index} />
      ))}
    </div>
  );
}
```

---

### Step 8 — Shared Output Renderers

**New file: `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`**

Renders cell outputs with mode-aware styling.

```tsx
import type { NotebookOutput } from './types';
import { getOutputRender } from './utils';
import { NotebookHtmlOutput } from './html-output';
import { cn } from '@/lib/utils';

interface OutputRendererProps {
  output: NotebookOutput;
  mode: 'report' | 'notebook';
  layout: 'panel' | 'dialog';
  title: string;
}

export function OutputRenderer({ output, mode, layout, title }: OutputRendererProps) {
  const render = getOutputRender(output);

  if (render.kind === 'html') {
    return <NotebookHtmlOutput html={render.html} layout={layout} title={title} />;
  }

  if (render.kind === 'image') {
    return (
      <img
        src={render.src}
        alt={title}
        className="max-w-full rounded"
      />
    );
  }

  if (render.kind === 'text') {
    if (mode === 'report') {
      // Inset well styling
      return (
        <pre className={cn(
          'rounded-xl bg-muted/50 p-5',
          'font-mono text-sm text-foreground/80 leading-[1.65]',
          'whitespace-pre-wrap',
          'shadow-[inset_0_2px_4px_rgba(0,0,0,0.06)]',
        )}>
          {render.text}
        </pre>
      );
    }
    // Notebook mode
    return (
      <pre className="overflow-auto rounded bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap border-t">
        {render.text}
      </pre>
    );
  }

  if (render.kind === 'unsupported') {
    return (
      <div className="text-xs text-muted-foreground italic">
        Output type is not supported in preview.
      </div>
    );
  }

  return null;
}
```

**Error output** handling — add to the output renderer:
```tsx
// Check for error outputs specifically
if (output.output_type === 'error') {
  const errorText = [output.ename, output.evalue].filter(Boolean).join(': ');
  const traceback = Array.isArray(output.traceback) ? output.traceback.join('\n') : '';
  return (
    <pre className="overflow-auto rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 p-3 font-mono text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap">
      {errorText}{traceback ? '\n' + traceback : ''}
    </pre>
  );
}
```

---

### Step 9 — Plotly Loading Placeholder

**New file: `src/components/chat-file-preview/notebook-preview/plotly-placeholder.tsx`**

Shown while the Plotly iframe loads. A light gray dashed-border rectangle with a subtle bar-chart silhouette and the word "Chart".

```tsx
export function PlotlyPlaceholder() {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 h-[320px]">
      <div className="flex flex-col items-center gap-2 text-muted-foreground/40">
        {/* Simple bar chart silhouette using divs */}
        <div className="flex items-end gap-1 h-12">
          <div className="w-2.5 h-4 rounded-sm bg-muted-foreground/15" />
          <div className="w-2.5 h-7 rounded-sm bg-muted-foreground/15" />
          <div className="w-2.5 h-5 rounded-sm bg-muted-foreground/15" />
          <div className="w-2.5 h-9 rounded-sm bg-muted-foreground/15" />
          <div className="w-2.5 h-6 rounded-sm bg-muted-foreground/15" />
          <div className="w-2.5 h-10 rounded-sm bg-muted-foreground/15" />
          <div className="w-2.5 h-8 rounded-sm bg-muted-foreground/15" />
        </div>
        <span className="font-mono text-xs">Chart</span>
      </div>
    </div>
  );
}
```

Use this as the initial content for the Plotly iframe container, replaced once the iframe loads. The `NotebookHtmlOutput` component should be updated to show this placeholder while loading (via an `onLoad` handler + state toggle).

---

### Step 10 — Main Index / Mode Switcher

**New file: `src/components/chat-file-preview/notebook-preview/index.tsx`**

This is the main entry point, replacing the old `NotebookPreview` in `file-preview-content.tsx`.

```tsx
import type { NotebookFile } from './types';
import { ReportMode } from './report-mode';
import { NotebookMode } from './notebook-mode';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type PreviewLayout = 'dialog' | 'panel';

interface NotebookPreviewProps {
  notebook: NotebookFile;
  layout: PreviewLayout;
  viewMode: 'report' | 'notebook';
}

export function NotebookPreview({ notebook, layout, viewMode }: NotebookPreviewProps) {
  return (
    <div className={cn(
      'overflow-auto',
      layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]',
    )}>
      {viewMode === 'report' ? (
        <ReportMode notebook={notebook} />
      ) : (
        <NotebookMode notebook={notebook} />
      )}
    </div>
  );
}

// Re-export types needed by file-preview-content.tsx
export type { NotebookFile } from './types';
```

---

### Step 11 — Update `file-preview-content.tsx`

**File: `src/components/chat-file-preview/file-preview-content.tsx`**

1. Remove all notebook-related interfaces, helpers, and components (lines 15–317)
2. Import from the new module:
   ```tsx
   import { NotebookPreview } from './notebook-preview';
   import type { NotebookFile } from './notebook-preview';
   ```
3. Add `notebookViewMode` to props:
   ```tsx
   export interface FilePreviewContentProps {
     filename: string;
     previewUrl: string;
     contentType?: string;
     layout?: PreviewLayout;
     notebookViewMode?: 'report' | 'notebook';
   }
   ```
4. Pass `viewMode` through:
   ```tsx
   <NotebookPreview
     notebook={notebook}
     layout={layout}
     viewMode={notebookViewMode ?? 'report'}
   />
   ```

---

## Markdown Rendering in Report Mode

The report mode needs headings to have `id` attributes for TOC scroll tracking. The existing `MarkdownRenderer` does not add IDs to headings.

**Options for the implementer:**

**(A) Post-process approach** — wrap `MarkdownRenderer` output in a `ref`'d container, then in a `useEffect` find all `h2`/`h3` elements and assign `id` attributes based on the TOC entries. This avoids modifying `MarkdownRenderer` at all.

**(B) Prop-based approach** — add an optional `headingIds` map prop to `MarkdownRenderer` that, when provided, stamps IDs onto rendered headings. Only the notebook report mode passes this prop; all other callsites are unaffected.

Approach **(A)** is recommended — it keeps changes contained within the notebook module.

---

## Report Mode Typography Mapping

| Element | Font | Tailwind classes |
|---------|------|-----------------|
| Category label | Mono | `font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50` |
| Title (h1) | Display | `font-[family-name:var(--font-display)] text-3xl font-normal tracking-tight` |
| Section headings (h2) | Display | `font-[family-name:var(--font-display)] text-xl font-normal tracking-tight` |
| Sub-headings (h3) | Display | `font-[family-name:var(--font-display)] text-lg font-normal` |
| Body text | Sans | `text-base text-muted-foreground leading-[1.7]` (default Figtree) |
| Inline code | Mono | `font-mono text-sm bg-muted/60 px-1.5 py-0.5 rounded` |
| Text output (inset well) | Mono | `font-mono text-sm leading-[1.65]` |
| Metadata line | Mono | `font-mono text-xs text-muted-foreground/60` |
| TOC label | Mono | `font-mono text-[10px] uppercase tracking-[0.2em]` |
| TOC active entry | Sans | `text-[13px] font-semibold text-foreground` |
| TOC inactive entry | Sans | `text-[13px] text-muted-foreground` |
| Footer | Mono | `font-mono text-[10px] text-muted-foreground/40` |

To apply the display font to headings inside `MarkdownRenderer` in report mode, add a CSS class scope:

**File: `src/styles/globals.css`**

```css
.notebook-report .markdown-content h1,
.notebook-report .markdown-content h2,
.notebook-report .markdown-content h3 {
  font-family: var(--font-display);
  font-weight: 400;
  letter-spacing: -0.01em;
}

.notebook-report .markdown-content h2 {
  font-size: 1.25rem;
  margin-top: 2.5rem;
  margin-bottom: 0.75rem;
}

.notebook-report .markdown-content h3 {
  font-size: 1.125rem;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
}

.notebook-report .markdown-content p {
  color: var(--color-muted-foreground);
  line-height: 1.7;
}
```

Then wrap the report mode body content in `<div className="notebook-report">`.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/root.tsx` | Modify | Add Instrument Serif font import |
| `src/styles/globals.css` | Modify | Add `--font-display` variable + `.notebook-report` heading overrides |
| `src/components/Chat.tsx` | Modify | Add `notebookViewMode` state, toggle UI, pass mode to `FilePreviewContent` |
| `src/components/chat-file-preview/file-preview-content.tsx` | Modify | Remove inline notebook code, import from new module, add `notebookViewMode` prop |
| `src/components/chat-file-preview/notebook-preview/index.tsx` | **New** | Main entry — mode switcher |
| `src/components/chat-file-preview/notebook-preview/types.ts` | **New** | All notebook interfaces |
| `src/components/chat-file-preview/notebook-preview/utils.ts` | **New** | Shared helpers (moved + new) |
| `src/components/chat-file-preview/notebook-preview/cell-classifier.ts` | **New** | Report mode cell classification |
| `src/components/chat-file-preview/notebook-preview/notebook-header.ts` | **New** | Header extraction |
| `src/components/chat-file-preview/notebook-preview/report-mode.tsx` | **New** | Report mode view |
| `src/components/chat-file-preview/notebook-preview/report-header.tsx` | **New** | Editorial header |
| `src/components/chat-file-preview/notebook-preview/report-sidebar.tsx` | **New** | TOC sidebar with scroll tracking |
| `src/components/chat-file-preview/notebook-preview/report-footer.tsx` | **New** | Footer |
| `src/components/chat-file-preview/notebook-preview/notebook-mode.tsx` | **New** | Notebook mode view |
| `src/components/chat-file-preview/notebook-preview/notebook-code-cell.tsx` | **New** | Code cell with gutter + syntax highlighting |
| `src/components/chat-file-preview/notebook-preview/notebook-markdown-cell.tsx` | **New** | Markdown cell in card |
| `src/components/chat-file-preview/notebook-preview/output-renderers.tsx` | **New** | Mode-aware output rendering |
| `src/components/chat-file-preview/notebook-preview/plotly-placeholder.tsx` | **New** | Plotly loading placeholder |
| `src/components/chat-file-preview/notebook-preview/syntax-highlighter.tsx` | **New** | Python syntax highlighting |

## Components Used

- `Tabs`, `TabsList`, `TabsTrigger` from `@/components/ui/tabs` — mode toggle
- `Separator` from `@/components/ui/separator` — header/footer dividers
- `ScrollArea` from `@/components/ui/scroll-area` — scrollable containers (if needed)
- `MarkdownRenderer` from `@/components/markdown-renderer` — markdown cell rendering
- `cn()` from `@/lib/utils` — conditional class merging
- `Tooltip`, `TooltipTrigger`, `TooltipContent` from `@/components/ui/tooltip` — existing toolbar tooltips

## Not in Scope

- **Persisting view mode preference** — the toggle resets when the preview closes; no localStorage or server state needed
- **Print/export to PDF** — report mode is view-only within the preview panel
- **Editing notebook cells** — the renderer is read-only
- **Custom Plotly theming** — Plotly charts render with transparent backgrounds but are otherwise unstyled by the app
- **Mobile sidebar** — on narrow viewports the sidebar simply hides via `hidden lg:block`; no drawer or collapsible behavior
- **Dialog layout mode** — the `FilePreviewPopover` modal continues to use the existing notebook rendering; the report/notebook toggle is only available in the panel layout
