# Notebook Report PDF Export Plan

Status: Proposed  
Date: March 6, 2026

This plan supersedes the removed print-based idea documented in `docs/notebook-export-downloads.md`.

The implementation should restore report-level notebook PDF export as a custom client-side pipeline. Do not revive `window.print()` or print-CSS as the primary path.

## Goal

Add a notebook-only download submenu in the preview panel so users can choose:

1. Download notebook (`.ipynb`)
2. Download report as PDF (`.pdf`)

The PDF must export the Report mode presentation, not Notebook mode. It should always render in light theme, preserve sharp/selectable text, control pagination explicitly, rasterize charts cleanly, remove interactive chrome, and keep report-mode table truncation behavior.

## Recommendation

Use `@react-pdf/renderer` as the PDF engine, driven from a shared report export model built from notebook JSON, plus offscreen light-theme chart rasterization for Vega-Lite and Plotly.

Ship chat preview support only for v1. Do not include the standalone renderer in `sandbox/create-worker/renderer/` in the first implementation.

### Why this is the best fit

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| `jsPDF + html2canvas` full-page screenshot | Fastest to hack together | Blurry text, non-selectable text, iframe/chart edge cases, poor pagination | Reject |
| `jsPDF` manual layout | Sharp text, full control | Reimplements layout/pagination/tables at a very low level | Reject |
| `@react-pdf/renderer` + shared export model | Sharp/selectable text, explicit pagination, React-friendly composition, browser blob generation | Requires a PDF-specific component tree | Recommend |

### Important architectural call

Do not literally walk the rendered Report mode DOM as the source of truth.

Instead:

1. Build a semantic export model from the notebook JSON using the same report classification and output parsing utilities the UI already uses.
2. Render the PDF from that model.
3. Generate chart images offscreen in light theme from the source Vega/Plotly specs.

This avoids three hard problems in the current DOM-based idea:

- current charts follow the live page theme, so dark mode would leak into the PDF
- `NotebookHtmlOutput` uses `iframe srcDoc`, which is fragile to scrape reliably
- DOM scraping tends to drift from the real report rules over time

## Scope

### In scope

- Notebook preview toolbar download submenu in chat preview
- Report-mode PDF export from the current notebook file
- Light-theme export regardless of current app theme
- Markdown narrative, report header/footer, charts, parsed tables, text outputs, image outputs, and error outputs
- Existing report truncation rules for large tables
- Explicit export loading/error states
- File name conversion from `name.ipynb` to `name.pdf`

### Out of scope for v1

- Exporting Notebook mode with code cells and execution gutters
- Reusing browser print flow
- Server-side or sandbox-side PDF generation
- Exact fidelity for arbitrary `html`/iframe outputs that do not parse into chart/table/image/text blocks
- Per-output PDF export

For generic `html` outputs that remain after `getOutputRender()` parsing, v1 should render a clear fallback callout in the PDF instead of trying to screenshot arbitrary iframe content.

## UX

### Preview toolbar

For notebook previews only, replace the current icon-only download control with a small bordered dropdown trigger styled like the app privacy toggle in `Chat.tsx`.

Recommended trigger shape:

- `Download` label
- `Download` icon
- chevron
- bordered small button, not ghost icon-only

Menu items:

1. `Download notebook (.ipynb)`
2. `Download report as PDF`

Behavior:

- If the notebook is still loading, disable `Download report as PDF`
- If export is running, disable the menu item and show pending state on the trigger
- If the user is currently in Notebook mode, the PDF item still exports Report mode
- Label the PDF item explicitly as report export so this is unambiguous

Recommended item labels:

- `Download notebook (.ipynb)`
- `Download report as PDF`

### Export feedback

Use a visible pending state because PDF generation can take a few seconds.

Recommended behavior:

- trigger button shows spinner + `Exporting…` while active
- show toast on failure
- no toast on success unless needed for debugging

## PDF content rules

### Included

- Report header title/subtitle/metadata
- All cells that Report mode classifies as `show`
- Markdown prose
- Charts rendered as PNG images
- Tables using the same truncated inline-report representation
- Plain text outputs as preformatted blocks
- Images
- Error outputs as styled error callouts
- Report footer

### Excluded

- Sidebar table of contents
- Expand buttons
- Download buttons
- Fullscreen affordances
- Notebook-mode code cells
- Any app/page chrome outside the report content

### Table behavior

PDF tables should match report mode, not fullscreen `TableViewer`.

Rules:

- use the same row cap as inline report mode: first 100 rows
- use the same cell truncation rule as inline report mode
- repeat the table header on each PDF page if the table spans multiple pages
- add a muted note under truncated tables

Recommended note text:

`Showing first 100 rows of 1,234 total rows.`

This is separate from the table caption so the PDF is self-explanatory without any download affordance nearby.

### Theme behavior

Always export light mode.

Rules:

- do not mutate the live app theme
- do not temporarily flip the document root from dark to light
- charts must be rendered offscreen with a forced light-theme config
- PDF styles should use a dedicated light palette, independent from CSS variables on the live page

### Failure behavior

The export should be resilient at the block level.

Rules:

- one failed chart must not fail the entire PDF export
- one failed image fetch must not fail the entire PDF export
- unsupported generic `html` outputs may render as a labeled fallback block in v1
- only fail the whole export for top-level failures such as PDF renderer import failure, notebook model build failure, or overall export timeout

Recommended fallback copy:

- chart failure: `Chart could not be rendered for PDF export.`
- generic html fallback: `This interactive HTML output is not included in PDF export.`

Log per-block failures to the console for debugging.

### Timeout and cancellation behavior

PDF export depends on async chart rendering and asset loading, so define time limits explicitly.

Recommended v1 behavior:

- overall export timeout: 30 seconds
- per-chart render timeout: 5 seconds
- per-image fetch timeout: 5 seconds
- no user-facing cancellation control in v1

If the overall timeout is hit, abort the export flow and show a toast. If an individual chart or image times out, continue with a fallback placeholder block.

### Memory behavior

Large notebooks can spike browser memory during export.

Rules:

- render chart/image assets sequentially, not in parallel
- clean up offscreen DOM nodes immediately after each asset render
- revoke object URLs eagerly after the PDF blob is downloaded
- avoid keeping both raw chart payloads and rasterized blobs in multiple derived arrays when one structure will do
- prefer streaming-style orchestration in code, even if the PDF library still materializes the final blob at the end

## Implementation design

### 1. Build a shared report export model

Create a new module that converts `NotebookFile` into a PDF-friendly report representation.

Recommended new file:

- `src/components/chat-file-preview/notebook-preview/report-export-model.ts`

Responsibilities:

- reuse `getNotebookCells()`, `classifyCells()`, `extractHeader()`, `extractTocEntries()`, and `getOutputRender()`
- move `removeHeaderContentFromTitleCell()` out of `report-mode.tsx` into a shared helper
- emit a stable ordered block list
- keep one source of truth for report inclusion/exclusion logic

Suggested model shape:

```ts
interface NotebookReportExportModel {
  header: NotebookHeader;
  codeCellCount: number;
  languageVersion?: string;
  blocks: NotebookReportExportBlock[];
}

type NotebookReportExportBlock =
  | { id: string; kind: 'markdown'; markdown: string }
  | { id: string; kind: 'chart'; chartKind: 'vegalite' | 'plotly'; spec: Record<string, unknown>; title: string }
  | { id: string; kind: 'table'; table: ParsedTable; display: TableDisplayModel; title: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; src: string; title: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'html'; html: string; title: string };
```

### 2. Extract shared table display logic

Today `NotebookTable` computes its own truncation/caption rules inline. That logic needs to be shared with PDF export so the table preview and PDF do not drift.

Recommended new file:

- `src/components/chat-file-preview/notebook-preview/table-display.ts`

Suggested responsibilities:

- compute `displayRows`
- compute `displayedCount`
- compute `captionText`
- compute `truncationNote`
- expose constants like `MAX_DISPLAY_ROWS` and `REPORT_MAX_CELL_CHARS`

Then reuse this helper from:

- `notebook-table.tsx`
- PDF table renderer
- export model builder

### 3. Refactor chart runtime helpers so PDF export can render charts offscreen

Current chart components already know how to:

- load Plotly/Vega libraries
- build themed light/dark chart configs
- render to DOM
- export PNG/SVG from rendered DOM

Those capabilities are split across component files and partially tied to live UI rendering. Refactor them into reusable helpers.

Recommended new/shared files:

- `src/components/chat-file-preview/notebook-preview/chart-runtime.ts`
- keep `chart-export-utils.ts`, but make it consume shared runtime helpers

Move or expose:

- `ensurePlotlyLoaded()`
- `ensureVegaLibrariesLoaded()`
- `buildThemedPlotlyFigure()`
- `buildThemedSpec()`

Add new offscreen helpers:

```ts
async function renderPlotlyPngForPdf(payload: Record<string, unknown>): Promise<PdfImageAsset>
async function renderVegaLitePngForPdf(spec: Record<string, unknown>): Promise<PdfImageAsset>
```

Implementation rules:

- render into a detached or visually hidden DOM node appended to `document.body`
- always use light theme
- render at a predictable export width
- clean up the offscreen node after capture
- use existing PNG export logic where possible instead of duplicating serialization code

This is preferable to capturing the live chart DOM because the live chart may be dark-themed.

### 4. Add the PDF renderer

Recommended new files:

- `src/components/chat-file-preview/notebook-preview/pdf-document.tsx`
- `src/components/chat-file-preview/notebook-preview/pdf-markdown.tsx`
- `src/components/chat-file-preview/notebook-preview/pdf-table.tsx`
- `src/components/chat-file-preview/notebook-preview/pdf-export.ts`

#### `pdf-document.tsx`

Build the actual `@react-pdf/renderer` document.

Requirements:

- page size: `LETTER`
- explicit margins
- no sticky/sidebar layout
- title in serif display face
- body in sans
- metadata/footer in mono or muted sans
- figures and tables should avoid splitting mid-block when reasonable

Recommended high-level structure:

```tsx
<Document title={pdfTitle}>
  <Page size="LETTER" style={styles.page}>
    <NotebookPdfHeader />
    <NotebookPdfBody blocks={model.blocks} />
    <NotebookPdfFooter />
  </Page>
</Document>
```

Use React PDF page wrapping rather than manual page slicing for prose blocks. For tables, slice rows manually into page-sized chunks so headers repeat cleanly.

#### `pdf-markdown.tsx`

This is one of the hardest parts of the feature and should be treated as a first-class implementation area, not a small adapter.

Do not use `react-markdown` for PDF rendering. It is optimized for DOM/HTML component mapping and becomes awkward for inline text composition with React PDF primitives.

Instead:

1. Parse markdown to MDAST using `unified`, `remark-parse`, and `remark-gfm`
2. Walk the AST with a custom MDAST-to-ReactPDF renderer
3. Emit nested `<Text>`, `<View>`, and `<Link>` structures directly

Suggested public API:

```ts
function renderMarkdownToPdfNodes(markdown: string): React.ReactNode[]
```

Support at minimum:

- paragraphs
- `h2` / `h3`
- strong / emphasis
- unordered and ordered lists
- blockquotes
- inline code
- fenced code blocks as monospace blocks
- links
- markdown tables by converting MDAST table nodes into the shared PDF table renderer or a dedicated markdown-table PDF helper

Implementation notes:

- inline formatting must be expressed as nested `<Text>` nodes, not pseudo-HTML spans
- nested lists need explicit indentation and marker/number layout
- code blocks require registered monospace font support
- this work is substantial enough to deserve dedicated tests and should be budgeted accordingly

#### `pdf-table.tsx`

Render fixed-height rows using the same truncated values as inline report mode.

Rules:

- fixed row height for predictable pagination
- no cell wrap in v1
- truncate cells the same way report mode does
- repeat headers on each page chunk
- render caption + truncation note under the final chunk

#### `pdf-export.ts`

Orchestrate the export:

1. lazily import `@react-pdf/renderer`
2. build export model
3. generate chart assets
4. normalize image assets
5. render PDF blob
6. trigger browser download

Suggested public API:

```ts
async function exportNotebookReportAsPdf(options: {
  notebook: NotebookFile;
  filename: string;
}): Promise<void>
```

Keep this API UI-agnostic so both the chat preview panel and the standalone notebook renderer can call it.

Implementation rules:

- lazily import `@react-pdf/renderer` inside this module with `await import('@react-pdf/renderer')`
- do not import the PDF stack from any eagerly loaded UI module
- register fonts lazily here, not at module scope
- verify after implementation that the PDF stack does not land in the main preview bundle

Bundle-size note:

- `@react-pdf/renderer` is large enough that bundle discipline matters
- after implementation, verify code splitting with the existing build output and/or bundle analysis tooling before shipping

### 5. Font handling

Do not rely on the live Google Fonts stylesheet at export time.

Bundle local font assets for the PDF renderer.

Recommended approach:

- add local font files under `public/fonts/`
- register a sans face matching the app body font (`Figtree`)
- register a serif face matching the report title (`Source Serif 4`)
- use built-in monospace fallback if bundling the mono font is not worth it

Optimize for asset size:

- do not ship variable fonts for PDF export unless measurement proves they are worth it
- bundle only the weights actually used in the PDF
- recommended initial set:
  - `Figtree Regular`
  - `Figtree Bold`
  - `Source Serif 4 Regular`
- serve them as static assets so they are CDN-cacheable rather than embedded into JS
- register them lazily inside `pdf-export.ts`

If local font packaging is delayed, use built-in PDF fonts temporarily, but that should be treated as a quality compromise, not the intended end state.

### 6. Parent/child state plumbing for the preview panel

`PreviewToolbar` is a sibling of `FilePreviewContent`, while the notebook JSON currently loads inside `FilePreviewContent`. The parent needs access to the parsed notebook so the toolbar can trigger PDF export.

Recommended approach:

1. Add a callback prop to `FilePreviewContent` for notebook load state.
2. Store notebook state per preview tab in `Chat.tsx`.
3. Feed the active tab's notebook state into `PreviewToolbar`.

Suggested callback:

```ts
onNotebookStateChange?: (state: {
  notebook: NotebookFile | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
}) => void
```

Because preview tabs stay mounted while hidden, store this by `tabId`, not as one global active value.

Important implementation detail:

- `FilePreviewContent` currently does `fetch()` + `response.text()` + `JSON.parse()` for notebooks
- fire the callback only after parsing succeeds so the parent receives the full `NotebookFile`
- also report loading/error transitions so the toolbar can disable PDF export appropriately

### 7. Update the toolbar download model

The current `DownloadButton` assumes every menu item is a direct file download from `filePreviewOpenUrl`.

That is no longer enough for PDF export.

Refactor the download option type to support both direct downloads and custom actions.

Suggested shape:

```ts
type DownloadOption =
  | { id: string; kind: 'direct'; label: string; filename: string; url: string }
  | { id: string; kind: 'action'; label: string; disabled?: boolean; pending?: boolean; onSelect: () => void };
```

Notebook options should become:

- direct raw `.ipynb`
- action-based PDF export

This refactor belongs in:

- `src/components/preview-panel/preview-toolbar.tsx`

### 8. Standalone renderer follow-up

There is a second notebook toolbar implementation in:

- `sandbox/create-worker/renderer/main.tsx`

Do not include it in v1. Treat this as a follow-up once chat preview export ships and stabilizes.

## File-level worklist

### Existing files to change

- `src/components/preview-panel/preview-toolbar.tsx`
- `src/components/Chat.tsx`
- `src/components/chat-file-preview/file-preview-content.tsx`
- `src/components/chat-file-preview/notebook-preview/report-mode.tsx`
- `src/components/chat-file-preview/notebook-preview/notebook-table.tsx`
- `src/components/chat-file-preview/notebook-preview/plotly-chart.tsx`
- `src/components/chat-file-preview/notebook-preview/vega-lite-chart.tsx`
- `src/components/chat-file-preview/notebook-preview/chart-export-utils.ts`
- `src/components/chat-file-preview/notebook-preview/utils.ts`
- `src/components/chat-file-preview/notebook-preview/types.ts`

### New files to add

- `src/components/chat-file-preview/notebook-preview/report-export-model.ts`
- `src/components/chat-file-preview/notebook-preview/table-display.ts`
- `src/components/chat-file-preview/notebook-preview/chart-runtime.ts`
- `src/components/chat-file-preview/notebook-preview/pdf-document.tsx`
- `src/components/chat-file-preview/notebook-preview/pdf-markdown.tsx`
- `src/components/chat-file-preview/notebook-preview/pdf-table.tsx`
- `src/components/chat-file-preview/notebook-preview/pdf-export.ts`

### Dependencies to add

- `@react-pdf/renderer`
- `unified`
- `remark-parse`

`remark-gfm` is already in the repo and can be reused.

### Docs to update after implementation

- `AGENTS.md`
- `docs/notebook-export-downloads.md`

`AGENTS.md` currently states that report-level PDF export is not supported. That must be updated when the feature ships.

## Suggested implementation order

1. Add shared helpers for report export modeling and table display rules.
2. Refactor chart runtime/theme helpers so charts can be rendered offscreen in light mode.
3. Build the React PDF document and PDF-specific markdown/table renderers.
4. Add the export orchestrator and browser download helper.
5. Lift notebook state from `FilePreviewContent` into `Chat.tsx`.
6. Refactor notebook download UI in `PreviewToolbar`.
7. Update docs.
8. Treat standalone renderer parity as follow-up work after the v1 PR lands.

## Testing

### Automated tests

Add unit tests for:

- report export model hides setup cells the same way Report mode does
- title/subtitle stripping matches current report behavior
- table display model produces the same truncation/caption rules as `NotebookTable`
- notebook toolbar exposes both notebook and PDF download actions
- PDF export action is disabled while notebook is loading
- chart export helpers force light theme inputs
- chart export continues with fallback placeholders when a chart render fails or times out
- overall export timeout produces a user-visible failure path without partial broken downloads
- markdown AST visitor handles inline emphasis/code/links and nested lists correctly

Recommended new tests:

- `tests/notebook-report-export-model.test.ts`
- `tests/notebook-table-display.test.ts`
- `tests/preview-toolbar-notebook-download.test.tsx`
- `tests/pdf-markdown.test.tsx`
- `tests/pdf-export.test.ts`

Do not try to snapshot raw PDF bytes in unit tests. Test the export model and the orchestration seams instead.

### Manual QA

Verify these scenarios:

1. Light app theme, Report mode, notebook with markdown + charts + tables
2. Dark app theme, Report mode, exported PDF still renders light charts and light page styling
3. Notebook mode selected, exported PDF still matches Report mode
4. Plotly chart notebook
5. Vega-Lite chart notebook
6. Notebook with a table over 100 rows
7. Notebook with multiple long sections to force several PDF pages
8. Notebook with error output
9. Notebook with image output
10. Notebook with a malformed or unsupported chart spec still exports with a placeholder block
11. Very chart-heavy notebook does not freeze the tab or leave obvious offscreen DOM behind after export
12. Switch preview tabs and confirm the correct notebook exports

## Acceptance criteria

- Notebook preview download control is a submenu, not a single direct download
- Raw `.ipynb` download still works
- PDF export always uses report-mode content
- PDF is light-themed even when the app is dark
- Text is selectable in the PDF
- Charts are embedded as images and do not get clipped between pages
- Tables use report-style truncation and include a truncation note
- Interactive download/expand controls are absent from the PDF
- No `window.print()` flow is used

## Decisions for v1

- Support chat preview only
- Do not add standalone renderer support in the same PR
- Generic `html` outputs may render as labeled fallback blocks in the PDF
