# Notebook Export & Individual Output Downloads

## Status (February 17, 2026)

Report-level PDF export has been removed from the product and codebase.

Current supported behavior:
1. Toolbar download for raw `.ipynb`
2. Per-chart/per-table downloads (CSV/PNG/SVG where supported)

The remainder of this document is retained as historical implementation context from the original proposal.

## Problem

The notebook preview panel has a single download option: download the raw `.ipynb` file. Users want two additional capabilities:

1. **Download the report as PDF** — a beautiful, light-mode version of the report without interactive chrome, ready for sharing or printing.
2. **Download individual outputs** — charts should offer SVG, PNG, and CSV (underlying data); tables already have CSV.

---

## Design

### 1. Toolbar Download Menu

Currently the notebook toolbar download button directly downloads the `.ipynb` file (single format, no dropdown). We need a dropdown menu with two options.

**Before:**
```
[ ↻ ] │ [ Report │ Notebook ] │ [ ↓ ] ──────────── [ ⧉ ]
                                  ^
                          single-click download
```

**After:**
```
[ ↻ ] │ [ Report │ Notebook ] │ [ ↓ ▾ ] ──────────── [ ⧉ ]
                                   │
                          ┌────────────────────────────┐
                          │ ↓  Download notebook (.ipynb)│
                          │ ↓  Download as PDF           │
                          └────────────────────────────┘
```

**Dropdown styling** — match the privacy toggle pattern (`Chat.tsx:409–440`):

- Trigger: `Button variant="ghost" size="icon-sm"` wrapping the `Download` icon (same as current) but now opens a `DropdownMenu`
- Content: `DropdownMenuContent align="start"`, each item is a `DropdownMenuItem`
- Each item has a `Download` icon (size-3.5, `text-muted-foreground`) and a label
- No `DropdownMenuLabel` or `DropdownMenuSeparator` needed — just two clean items

**Implementation:** Modify `getDownloadFormats()` in `preview-toolbar.tsx` to return two entries for `ipynb`:

```typescript
case 'ipynb':
  return [
    { label: 'Download notebook (.ipynb)', filename: name, action: 'download' },
    { label: 'Download as PDF', filename: name.replace(/\.ipynb$/, '.pdf'), action: 'pdf' },
  ];
```

The existing `DownloadButton` already renders a dropdown when `formats.length > 1`. We just need to intercept the `pdf` action to trigger the print flow instead of a file download.

---

### 2. Output Action Bars (Charts)

Below each chart (Vega-Lite and Plotly), add a subtle action bar with a download dropdown. Match the existing table caption bar style (`notebook-table.tsx:228–244`).

**Chart action bar:**
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│                  [Vega/Plotly Chart]                  │
│                                                      │
└──────────────────────────────────────────────────────┘
                                              ↓ Download ▾
                                    ┌──────────────────────┐
                                    │  Download as SVG     │
                                    │  Download as PNG     │
                                    │  Download data (CSV) │
                                    └──────────────────────┘
```

**Table action bar (no change):**
```
┌──────────────────────────────────────────────────────┐
│  col1  │  col2  │  col3  │  col4  │  col5            │
├──────────────────────────────────────────────────────┤
│  ...   │  ...   │  ...   │  ...   │  ...             │
└──────────────────────────────────────────────────────┘
  Showing 100 of 5,000 rows × 5 columns    ↓ Download all rows as CSV
```

Tables already have their caption + download button baked into `NotebookTable`. No changes needed for tables.

**Action bar styling** — use the same visual language as the table caption bar:

```tsx
<div className="mt-1.5 flex items-center justify-end text-xs text-muted-foreground/60">
  {/* DropdownMenu trigger styled as inline text button */}
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors">
        <Download className="size-3" />
        Download
        <ChevronDown className="size-2.5 opacity-60" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem>Download as SVG</DropdownMenuItem>
      <DropdownMenuItem>Download as PNG</DropdownMenuItem>
      <DropdownMenuItem>Download data (CSV)</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

This appears in both Report mode and Notebook mode, beneath every chart output.

---

### 3. PDF Export via Print

Use the browser's native `window.print()` with print-specific CSS. This produces the highest-quality PDFs (vector SVG charts, selectable text, proper pagination) with zero extra dependencies.

**Flow:**
```
User clicks "Download as PDF"
         │
         ▼
  ┌─────────────────────┐
  │ Save current theme   │ ← remember if dark mode was active
  │ Force light mode     │ ← remove 'dark' class from <html>
  │ Add print class      │ ← body.chiridion-printing-report
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  window.print()      │ ← browser shows Save as PDF dialog
  └──────────┬──────────┘
             │
         afterprint
             │
             ▼
  ┌─────────────────────┐
  │ Restore theme        │ ← re-add 'dark' if it was active
  │ Remove print class   │
  └─────────────────────┘
```

**Print CSS strategy** — uses `visibility` trick to show only the report:

```css
@media print {
  body.chiridion-printing-report {
    visibility: hidden;
  }

  body.chiridion-printing-report .notebook-report {
    visibility: visible;
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
  }

  body.chiridion-printing-report .notebook-report * {
    visibility: visible;
  }

  /* Hide sidebar TOC — content uses full width in PDF */
  body.chiridion-printing-report .notebook-report .report-sidebar {
    display: none !important;
  }

  /* Hide all output action bars */
  body.chiridion-printing-report .output-action-bar {
    display: none !important;
  }

  /* Full width for content column */
  body.chiridion-printing-report .notebook-report > div {
    max-width: 100%;
  }

  /* Page break hints */
  body.chiridion-printing-report .notebook-report .space-y-8 > * {
    break-inside: avoid;
  }

  /* Print margins */
  @page {
    margin: 1.5cm 2cm;
  }
}
```

---

## Implementation

### File 1 (new): `src/components/chat-file-preview/notebook-preview/output-action-bar.tsx`

A shared component that renders the download dropdown below chart outputs. Handles SVG, PNG, and CSV export for both Vega-Lite and Plotly charts.

**Props:**
```typescript
interface OutputActionBarProps {
  kind: 'vegalite' | 'plotly';
  containerRef: React.RefObject<HTMLDivElement>;
  /** Vega-Lite spec or Plotly payload — used for CSV data extraction */
  spec: Record<string, unknown>;
  title: string;
}
```

**Component structure:**
```tsx
export function OutputActionBar({ kind, containerRef, spec, title }: OutputActionBarProps) {
  return (
    <div className="output-action-bar mt-1.5 flex items-center justify-end text-xs text-muted-foreground/60">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={cn(
            'inline-flex shrink-0 items-center gap-1 text-xs transition-colors',
            'text-muted-foreground/70 hover:text-foreground'
          )}>
            <Download className="size-3" />
            Download
            <ChevronDown className="size-2.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => exportAsSvg(kind, containerRef, title)}>
            Download as SVG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => exportAsPng(kind, containerRef, title)}>
            Download as PNG
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => exportDataAsCsv(kind, spec, title)}
            disabled={!hasExtractableData(kind, spec)}
          >
            Download data (CSV)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

---

### File 2 (new): `src/components/chat-file-preview/notebook-preview/chart-export-utils.ts`

Utility functions for chart export. All exports create a Blob and trigger a browser download.

#### SVG Export

```typescript
export function exportAsSvg(
  kind: 'vegalite' | 'plotly',
  containerRef: React.RefObject<HTMLDivElement>,
  title: string
): void {
  const container = containerRef.current;
  if (!container) return;

  const svgElement = container.querySelector('svg');
  if (!svgElement) return;

  // Clone SVG so we don't mutate the live chart
  const clone = svgElement.cloneNode(true) as SVGElement;

  // Ensure xmlns attribute for standalone SVG
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const svgString = new XMLSerializer().serializeToString(clone);
  triggerBlobDownload(
    new Blob([svgString], { type: 'image/svg+xml' }),
    `${sanitizeFilename(title)}.svg`
  );
}
```

#### PNG Export

Two strategies depending on chart kind:

**Vega-Lite:** Use the Vega view's built-in `toImageURL('png', scaleFactor)` method if accessible, otherwise fall back to SVG-to-canvas approach.

**Plotly:** Use `Plotly.toImage(plotDiv, { format: 'png', width: 1200, height: 800, scale: 2 })`.

**Fallback (SVG → Canvas → PNG):**
```typescript
async function svgToPng(svgElement: SVGElement, scale = 2): Promise<Blob> {
  const svgString = new XMLSerializer().serializeToString(svgElement);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.src = url;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);

  URL.revokeObjectURL(url);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  });
}
```

#### CSV Data Export

**Vega-Lite data extraction:**
```typescript
function extractVegaData(spec: Record<string, unknown>): Record<string, unknown>[] | null {
  // Prefer spec.data.values (most common in notebook outputs)
  const data = spec.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.values) && data.values.length > 0) {
    return data.values as Record<string, unknown>[];
  }

  // Check for named datasets
  const datasets = spec.datasets as Record<string, unknown[]> | undefined;
  if (datasets) {
    const first = Object.values(datasets)[0];
    if (Array.isArray(first) && first.length > 0) return first as Record<string, unknown>[];
  }

  // Check layer specs for inline data
  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) {
      const layerData = (layer as Record<string, unknown>).data as Record<string, unknown> | undefined;
      if (layerData && Array.isArray(layerData.values)) {
        return layerData.values as Record<string, unknown>[];
      }
    }
  }

  return null;
}
```

**Plotly data extraction:**
```typescript
function extractPlotlyData(payload: Record<string, unknown>): Record<string, unknown>[] | null {
  const figure = (payload.figure as Record<string, unknown> | undefined) ?? undefined;
  const rawTraces =
    Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(figure?.data)
        ? (figure.data as unknown[])
        : [];
  const traces = rawTraces as Record<string, unknown>[];
  if (traces.length === 0) return null;

  const rows: Record<string, unknown>[] = [];

  for (const trace of traces) {
    const name = (trace.name as string) ?? `trace`;
    const x = Array.isArray(trace.x) ? trace.x : [];
    const y = Array.isArray(trace.y) ? trace.y : [];
    const labels = Array.isArray(trace.labels) ? trace.labels : [];
    const values = Array.isArray(trace.values) ? trace.values : [];

    // Scatter/bar/line: x, y
    if (x.length > 0 || y.length > 0) {
      const len = Math.max(x.length, y.length);
      for (let i = 0; i < len; i++) {
        rows.push({
          trace: name,
          x: x[i] ?? '',
          y: y[i] ?? '',
        });
      }
    }
    // Pie: labels, values
    else if (labels.length > 0 || values.length > 0) {
      const len = Math.max(labels.length, values.length);
      for (let i = 0; i < len; i++) {
        rows.push({
          trace: name,
          label: labels[i] ?? '',
          value: values[i] ?? '',
        });
      }
    }
  }

  return rows.length > 0 ? rows : null;
}
```

**Shared CSV serializer** — use the same `escapeCell` pattern from `notebook-table.tsx`:
```typescript
function objectsToCsv(rows: Record<string, unknown>[]): string {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const header = keys.map(escapeCell).join(',');
  const body = rows.map((row) =>
    keys.map((k) => escapeCell(String(row[k] ?? ''))).join(',')
  );
  return [header, ...body].join('\r\n');
}
```

**`hasExtractableData`** — returns `true` if the spec/payload has data we can extract. Used to disable the CSV menu item when no data is available:
```typescript
export function hasExtractableData(kind: 'vegalite' | 'plotly', spec: Record<string, unknown>): boolean {
  if (kind === 'vegalite') return extractVegaData(spec) !== null;
  return extractPlotlyData(spec) !== null;
}
```

**Shared download helper:**
```typescript
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sanitizeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 80) || 'chart';
}
```

---

### File 3 (modify): `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`

Wrap chart outputs with a container ref and add the `OutputActionBar` below.

**Changes:**

1. Import `OutputActionBar` and `useRef`
2. For `vegalite` and `plotly` renders, wrap in a parent div with a ref and append the action bar

```tsx
// Before:
if (render.kind === 'vegalite') {
  return (
    <div className="w-full min-w-0">
      <VegaLiteChart spec={render.spec} title={title} />
    </div>
  );
}

// After:
if (render.kind === 'vegalite') {
  return (
    <ChartOutputWithActions kind="vegalite" spec={render.spec} title={title} mode={mode} layout={layout} />
  );
}
```

Create a `ChartOutputWithActions` helper component inside the file that holds the ref:

```tsx
function ChartOutputWithActions({
  kind,
  spec,
  title,
  mode,
  layout,
}: {
  kind: 'vegalite' | 'plotly';
  spec: Record<string, unknown>;
  title: string;
  mode: 'report' | 'notebook';
  layout: 'panel' | 'dialog';
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="w-full min-w-0">
      <div ref={containerRef}>
        {kind === 'vegalite' ? (
          <VegaLiteChart spec={spec} title={title} />
        ) : (
          <PlotlyChart payload={spec} title={title} />
        )}
      </div>
      <OutputActionBar kind={kind} containerRef={containerRef} spec={spec} title={title} />
    </div>
  );
}
```

---

### File 4 (modify): `src/components/preview-panel/preview-toolbar.tsx`

Update the `getDownloadFormats` function and the download button to support the PDF action.

**Changes to `getDownloadFormats()`:**

Add a new `action` field to the format type. The existing download action stays `'download'`; PDF export gets `'pdf'`.

```typescript
interface DownloadFormat {
  label: string;
  filename: string;
  action: 'download' | 'pdf';
}

function getDownloadFormats(target: PreviewTarget): DownloadFormat[] {
  // ... existing code ...
  switch (ext) {
    case 'ipynb':
      return [
        { label: 'Download notebook (.ipynb)', filename: name, action: 'download' },
        { label: 'Download as PDF', filename: name.replace(/\.ipynb$/, '.pdf'), action: 'pdf' },
      ];
    // ... rest unchanged, all with action: 'download' ...
  }
}
```

**Add `onNotebookPdfExport` prop to `NotebookToolbarActions` and `DownloadButton`:**

```typescript
interface PreviewToolbarProps {
  // ... existing props ...
  onNotebookPdfExport?: () => void;
}
```

**Update `DownloadButton`** to handle the `pdf` action:

```tsx
function DownloadButton({
  activeTarget,
  filePreviewOpenUrl,
  onNotebookPdfExport,
}: {
  activeTarget: PreviewTarget;
  filePreviewOpenUrl?: string;
  onNotebookPdfExport?: () => void;
}) {
  // ... existing early returns ...

  const formats = getDownloadFormats(activeTarget);
  // Now formats.length === 2 for ipynb, so the dropdown path is always taken

  return (
    <DropdownMenu>
      {/* ... existing Tooltip + DropdownMenuTrigger ... */}
      <DropdownMenuContent align="start">
        {formats.map((format) => (
          <DropdownMenuItem
            key={format.label}
            onClick={() => {
              if (format.action === 'pdf') {
                onNotebookPdfExport?.();
              } else {
                triggerDownload(filePreviewOpenUrl!, format.filename);
              }
            }}
          >
            <Download className="mr-2 size-3.5 text-muted-foreground" />
            {format.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Each `DropdownMenuItem` gets a small Download icon to the left of the label, matching the style of the privacy toggle items which have icon + label + description.

---

### File 5 (new logic in existing file): PDF Export Hook

Add a `usePdfExport()` hook that handles the print flow. This can live in a new file or be inlined in the component that manages the toolbar.

**Location:** `src/components/chat-file-preview/notebook-preview/use-pdf-export.ts`

```typescript
import { useCallback, useEffect, useRef } from 'react';

export function usePdfExport(
  currentMode: 'report' | 'notebook' | undefined,
  setMode: ((mode: 'report' | 'notebook') => void) | undefined
) {
  const isPrintingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  const exportPdf = useCallback(() => {
    if (isPrintingRef.current) return;
    isPrintingRef.current = true;

    const html = document.documentElement;
    const body = document.body;
    const previousMode = currentMode;
    const wasDark = html.classList.contains('dark');
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const restore = () => {
      body.classList.remove('chiridion-printing-report');
      if (wasDark) html.classList.add('dark');
      if (previousMode === 'notebook') setMode?.('notebook');
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.removeEventListener('afterprint', restore);
      cleanupRef.current = null;
      isPrintingRef.current = false;
    };
    cleanupRef.current = restore;

    if (currentMode === 'notebook') {
      setMode?.('report');
    }

    const waitForReportDom = async () => {
      for (let i = 0; i < 20; i += 1) {
        if (document.querySelector('.notebook-report')) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };

    void (async () => {
      try {
        await waitForReportDom();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );

        if (wasDark) html.classList.remove('dark');
        body.classList.add('chiridion-printing-report');

        await new Promise<void>((resolve) =>
          setTimeout(resolve, wasDark ? 250 : 0)
        );

        window.addEventListener('afterprint', restore, { once: true });
        fallbackTimer = setTimeout(restore, 3000);
        window.print();
      } catch {
        restore();
      }
    })();
  }, [currentMode, setMode]);

  return exportPdf;
}
```

**Threading the callback:** The `usePdfExport` hook is called in `Chat.tsx` (or wherever the toolbar props are assembled). The returned `exportPdf` function is passed down through `PreviewToolbar` → `NotebookToolbarActions` → `DownloadButton` as `onNotebookPdfExport`.

---

### File 6 (modify): `src/styles/globals.css`

Add the print-mode CSS rules.

```css
/* ==========================================
   PDF / Print Export — Notebook Report
   ========================================== */

@media print {
  /* Hide the entire page */
  body.chiridion-printing-report {
    visibility: hidden;
    overflow: visible;
  }

  /* Prevent notebook scroll container clipping in print */
  body.chiridion-printing-report [data-notebook-scroll-root="true"] {
    overflow: visible !important;
    height: auto !important;
    max-height: none !important;
  }

  /* Show only the report */
  body.chiridion-printing-report .notebook-report,
  body.chiridion-printing-report .notebook-report * {
    visibility: visible;
  }

  /* Position report at top of page, full width */
  body.chiridion-printing-report .notebook-report {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    padding: 0;
    gap: 0;
  }

  /* Hide the sidebar TOC — content gets full width */
  body.chiridion-printing-report .report-sidebar {
    display: none !important;
  }

  /* Hide chart/table download action bars */
  body.chiridion-printing-report .output-action-bar {
    display: none !important;
  }

  /* Hide the report footer (code cell count) */
  body.chiridion-printing-report .report-footer {
    display: none !important;
  }

  /* Content column takes full width */
  body.chiridion-printing-report .notebook-report > div {
    max-width: 100%;
    flex: 1;
  }

  /* Page break hints — avoid splitting charts and tables */
  body.chiridion-printing-report .space-y-8 > * {
    break-inside: avoid;
  }

  /* Ensure transparent backgrounds print correctly */
  body.chiridion-printing-report .notebook-report {
    background: white;
    color: black;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Page setup */
  @page {
    margin: 1.5cm 2cm;
  }
}
```

---

### File 7 (modify): `src/components/chat-file-preview/notebook-preview/report-mode.tsx`

Add a CSS class to the sidebar and footer for print targeting.

- Add `report-sidebar` class to `<ReportSidebar>` wrapper (or to the component's root element in `report-sidebar.tsx`)
- Add `report-footer` class to `<ReportFooter>` wrapper (or to the component's root element in `report-footer.tsx`)

Check if these classes already exist. If `ReportSidebar` renders its own root element, the class may need to go there. The print CSS targets `.report-sidebar` and `.report-footer`.

---

### File 8 (modify): `src/components/chat-file-preview/notebook-preview/report-sidebar.tsx`

Ensure the root element has the class `report-sidebar` so the print CSS can hide it. If the root already has it (check the component), no changes needed.

---

### File 9 (modify): `src/components/chat-file-preview/notebook-preview/report-footer.tsx`

Same — ensure the root element has the class `report-footer`.

---

### File 10 (modify): `src/components/Chat.tsx`

Wire up the PDF export:

1. Import `usePdfExport` from `use-pdf-export.ts`
2. Call the hook with notebook mode wiring:
   `const exportPdf = usePdfExport(notebookViewMode, isNotebookPreview ? setActiveNotebookViewMode : undefined);`
3. Pass `exportPdf` to `PreviewPanelShell` → `PreviewToolbar` as `onNotebookPdfExport`

**In `PreviewPanelShell`:**
```tsx
<PreviewToolbar
  // ... existing props ...
  onNotebookPdfExport={onNotebookPdfExport}
/>
```

The `onNotebookPdfExport` prop is only passed when the active tab is a notebook.

---

## Edge Cases & Requirements

### Truncated Tables in PDF
Tables are already truncated to 100 rows in the display (`MAX_DISPLAY_ROWS` in `notebook-table.tsx`). The caption text already shows "Showing 100 of 5,000 rows × 5 columns" when truncated. This message prints correctly in the PDF — no special handling needed. The download-CSV button below the table is hidden via the `.output-action-bar` print CSS. But the table's own caption/download row is NOT an `.output-action-bar` — it's built into `NotebookTable`. Add the `output-action-bar` class to the table's bottom row (line 228) so the download button is hidden in PDF:

```tsx
// notebook-table.tsx line 228
<div className="output-action-bar mt-1.5 flex items-center justify-between gap-4 text-xs text-muted-foreground/60">
```

Wait — this would also hide the caption text ("100 of 5,000 rows"). We want to keep the caption but hide only the download button. Two approaches:

**Approach (recommended):** Don't add the class to the whole row. Instead, hide the download button itself in print mode:

```css
@media print {
  body.chiridion-printing-report .notebook-table-download-btn {
    display: none !important;
  }
}
```

And add `notebook-table-download-btn` class to the download button in `notebook-table.tsx` (line 230–243).

This preserves the caption text ("Showing 100 of 5,000 rows × 5 columns") in the PDF while hiding the download button.

### Download Buttons Hidden in PDF
All `OutputActionBar` components have the `output-action-bar` class and are hidden by the print CSS. The table download button is separately hidden via `notebook-table-download-btn` class. The toolbar itself is outside the `.notebook-report` tree, so it's already invisible in print.

### Dark Mode to Light Mode for PDF
The `usePdfExport` hook removes the `dark` class from `<html>` before printing and restores it on `afterprint`. Both Vega-Lite and Plotly charts use `MutationObserver` on the `<html>` class list and will re-render with light theme colors automatically. However, the charts re-render asynchronously — wait for report mount + two animation frames, then apply a short delay before calling `window.print()`:

```typescript
if (wasDark) {
  html.classList.remove('dark');
}
body.classList.add('chiridion-printing-report');

// Wait for report mount/layout + chart re-render before printing
await waitForReportDom();
await new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
);
await new Promise<void>((resolve) =>
  setTimeout(resolve, wasDark ? 250 : 0)
);
window.print();
```

### Charts Still Loading
If a chart hasn't finished loading when the user clicks "Download as PDF", the loading placeholder will be visible. This is an acceptable edge case — the placeholder prints as a gray skeleton. No special handling needed.

### Notebook Mode vs Report Mode
The "Download as PDF" always exports the Report mode view, regardless of which tab (Report/Notebook) is active. If the user is in Notebook mode and clicks "Download as PDF", the print CSS targets `.notebook-report` which is the Report mode container. Ensure Report mode is always rendered (even when Notebook mode is active) or switch to Report mode before printing.

**Recommended approach:** If the active notebook view mode is `'notebook'`, temporarily switch to `'report'` before printing, then restore after `afterprint`. Update `usePdfExport` to accept `setMode` callback:

```typescript
export function usePdfExport(
  currentMode: 'report' | 'notebook' | undefined,
  setMode: ((mode: 'report' | 'notebook') => void) | undefined
) {
  const exportPdf = useCallback(() => {
    // Switch to report mode if needed
    if (currentMode === 'notebook') {
      setMode?.('report');
    }
    // Wait for .notebook-report to mount before window.print()
    // Restore mode after print finishes
  }, [currentMode, setMode]);
}
```

### Both Modes Get Action Bars
The `OutputActionBar` appears in both Report and Notebook modes. In `output-renderers.tsx`, the `mode` prop is passed through but the action bar is always rendered (the `mode` doesn't gate it). Both modes show the download dropdown beneath charts.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `notebook-preview/output-action-bar.tsx` | **Create** | Download dropdown for chart outputs |
| `notebook-preview/chart-export-utils.ts` | **Create** | SVG/PNG/CSV export functions |
| `notebook-preview/use-pdf-export.ts` | **Create** | Hook for print-based PDF export |
| `notebook-preview/output-renderers.tsx` | Modify | Wrap charts with action bars |
| `preview-panel/preview-toolbar.tsx` | Modify | Dropdown with .ipynb + PDF options |
| `Chat.tsx` | Modify | Wire `usePdfExport` to toolbar |
| `src/styles/globals.css` | Modify | Print CSS rules |
| `notebook-preview/notebook-table.tsx` | Modify | Add `notebook-table-download-btn` class to hide button in print |
| `notebook-preview/report-sidebar.tsx` | Modify | Ensure `report-sidebar` class for print CSS |
| `notebook-preview/report-footer.tsx` | Modify | Ensure `report-footer` class for print CSS |

---

## Validation Checklist

- [ ] Toolbar download button opens dropdown with two options for `.ipynb` files
- [ ] "Download notebook (.ipynb)" still downloads the raw file
- [ ] "Download as PDF" triggers `window.print()` dialog
- [ ] PDF prints in light mode even when app is in dark mode
- [ ] PDF shows report without sidebar, without output action bars, without table download buttons
- [ ] PDF preserves truncated table caption ("Showing 100 of 5,000 rows")
- [ ] PDF has proper page breaks (charts/tables don't split)
- [ ] After print dialog closes, app restores to previous state (dark mode, view mode)
- [ ] Chart action bars appear below Vega-Lite charts in both modes
- [ ] Chart action bars appear below Plotly charts in both modes
- [ ] "Download as SVG" exports a valid standalone SVG file
- [ ] "Download as PNG" exports a high-resolution PNG (2x scale)
- [ ] "Download data (CSV)" exports chart data as CSV (disabled when no data extractable)
- [ ] Table CSV download still works as before
- [ ] No visual regressions in report or notebook modes
