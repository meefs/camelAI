# Preview Renderers Expansion Plan

## Purpose

Add preview/source support for more file types in the chat preview panel:

- HTML/HTM: render the actual page by default, with source code available.
- SVG: keep the rendered image by default, add source code.
- JSON: add a pretty-printed rendered view, with exact raw source available.
- CSV/TSV: keep the spreadsheet renderer by default, add raw source.
- Recommended adjacent additions included in this plan: `.htm` with HTML, `.tsv` with CSV, and JSONL line-by-line pretty rendering.

This plan assumes the toolbar standardization and shared source preview work have already landed:

- `src/components/preview-panel/preview-source-toggle.tsx` exists and provides the icon-only Preview/Source toggle.
- `src/components/chat-file-preview/code-preview.tsx` exports `SourcePreview`.
- Markdown source and plain text previews already route through `SourcePreview`.

## Current State

Relevant files:

- `src/components/Chat.tsx`
  - Owns per-tab view mode state.
  - Currently has `tabNotebookViewModes` and `tabMarkdownViewModes`.
  - Builds `tabRenderStates` and passes `notebookViewMode` / `markdownViewMode` into toolbar and content.
- `src/components/preview-panel/preview-toolbar.tsx`
  - Shows `PreviewSourceToggle` only for notebooks and Markdown.
  - Uses `getToolbarFileType(activeTarget)` to decide which controls to show.
- `src/components/preview-panel/preview-utils.ts`
  - Maps file extensions to toolbar file types and tab icons.
  - Already has toolbar file types for `json`, `spreadsheet`, and `svg`, but not `html`.
- `src/components/chat-file-preview/file-preview-content.tsx`
  - `image` renders via `<img>`.
  - `spreadsheet` renders via `SpreadsheetPreview`.
  - `markdown` has rendered/source branches.
  - `code` and `text` use `SourcePreview`.
  - `.html` is currently classified as `code`, so it only shows raw source.
  - `.svg` is currently classified as `image`, so it only shows the rendered image.
  - `.json` is currently classified as `code`, so it only shows raw source.
- `src/components/chat-file-preview/file-type-utils.ts`
  - `PreviewType` does not yet include `html`, `svg`, `json`, or `jsonl` as explicit preview types.
  - `getPreviewType()` returns `image` before any SVG-specific handling.
  - `getPreviewType()` returns `code` for JSON and HTML because Shiki languages exist for those extensions.
- File content routes:
  - `src/routes/api/workspaces.$id.fs.content.$.ts`
  - `src/routes/api/workspaces.$id.uploads.$.ts`
  - `src/routes/api/workspaces.$id.outputs.$.ts`
  - `.html` is already inline, but `.htm`, `.jsonl`, and `.tsv` are not consistently listed.

## Goals

1. Use the existing toolbar toggle instead of adding new UI controls.
2. Make Preview/Source a generic file preview mode for all source-toggleable file types, while leaving notebook's `report`/`notebook` internal mode intact.
3. Keep default rendered behavior per file type:
   - Markdown: rendered Markdown.
   - HTML: sandboxed rendered page.
   - SVG: rendered image.
   - JSON: pretty-printed JSON.
   - CSV/TSV: spreadsheet grid.
4. Keep source mode exact where it matters:
   - HTML source is the original text.
   - SVG source is the original XML/SVG text.
   - JSON source is the original unformatted file text.
   - CSV/TSV source is the original delimited text.
5. Avoid weakening preview security. HTML must render in a sandboxed iframe and must not be injected into the parent React DOM.
6. Add focused tests for classification, toolbar toggle visibility, renderer branches, and security-sensitive iframe attributes.

## Non-Goals

- Do not add editing to the preview panel.
- Do not replace the spreadsheet canvas renderer.
- Do not change the published app iframe behavior.
- Do not build a full browser/dev-server preview for multi-file static sites. Relative HTML assets should work when they are relative to the previewed file URL, but absolute workspace-root paths are out of scope.
- Do not add new heavy renderer dependencies unless they are already in the project.

## Target Behavior

| File type | Default view | Source view | Toggle? | Notes |
|---|---|---|---|---|
| `.html`, `.htm`, `text/html` | Sandboxed iframe | `SourcePreview` with HTML highlighting | Yes | Do not include `allow-same-origin` in the iframe sandbox. |
| `.svg`, `image/svg+xml` | Existing image preview | `SourcePreview` with HTML/XML highlighting | Yes | Rendered SVG remains an `<img>`, not inline SVG. |
| `.json`, `application/json`, `*+json` | Pretty-printed JSON | Exact raw JSON | Yes | Pretty view formats from full fetched text before display truncation. |
| `.jsonl`, `application/x-ndjson` | Pretty JSON per line | Exact raw JSONL | Yes | Parse each non-empty line independently and fall back to raw source on the first invalid line. |
| `.csv`, `.tsv`, text CSV/TSV content types | Spreadsheet grid | Raw delimited text | Yes | Source mode only for delimited text spreadsheets. |
| `.xlsx`, `.xls` | Spreadsheet grid | None | No | Binary source is not useful in the preview panel. |
| Markdown | Rendered Markdown | Markdown source | Yes | Existing behavior, but backed by generic file mode state. |
| Notebook | Report | Notebook JSON | Yes | Keep existing notebook-specific state and download behavior. |

## Design Decisions

### 1. Generalize File View Mode State

Do not add separate `tabHtmlViewModes`, `tabSvgViewModes`, `tabJsonViewModes`, etc. Replace the Markdown-specific state with one generic map for non-notebook file preview/source modes:

```ts
type FilePreviewMode = "preview" | "source";

const [tabFileViewModes, setTabFileViewModes] = useState<
  Record<string, FilePreviewMode>
>({});
```

Keep notebook state separate:

```ts
const [tabNotebookViewModes, setTabNotebookViewModes] = useState<
  Record<string, "report" | "notebook">
>({});
```

Why:

- Notebook still has special labels and PDF export behavior.
- All other renderer toggles can share `preview` / `source`.
- Future file types become a classification change plus a render branch, not another state map.

### 2. Classify Renderable Source-Toggle Types Explicitly

Update `PreviewType` in `file-type-utils.ts` to include explicit types for renderer branches:

```ts
export type PreviewType =
  | "image"
  | "pdf"
  | "notebook"
  | "markdown"
  | "html"
  | "svg"
  | "json"
  | "jsonl"
  | "code"
  | "spreadsheet"
  | "text"
  | "audio"
  | "video"
  | "other";
```

Then order `getPreviewType()` so special renderers win before broad `image` and `code` categories:

```ts
if (extension === "md") return "markdown";
if (extension === "html" || extension === "htm" || baseContentType === "text/html") return "html";
if (extension === "svg" || baseContentType === "image/svg+xml") return "svg";
if (extension === "json" || baseContentType === "application/json" || baseContentType.endsWith("+json")) return "json";
if (extension === "jsonl" || baseContentType === "application/x-ndjson") return "jsonl";
if (category === "notebook") return "notebook";
if (isSpreadsheetPreviewSupported(filename, contentType)) return "spreadsheet";
if (category === "image") return "image";
```

The exact order can be adjusted, but the important rule is: `.svg`, `.html`, and `.json` must not fall through to generic `image` or `code`.

Also add:

- `htm: "html"` to `CODE_HIGHLIGHT_MAP`.
- Keep `jsonl: "json"` if already present or add it if missing.
- Do not add `csv` to `CODE_HIGHLIGHT_MAP` unless Shiki support is already configured. `SourcePreview` can safely use the `"text"` fallback.

### 3. Use a Helper for Toggle Eligibility

Add one helper in `src/components/preview-panel/preview-utils.ts`:

```ts
export function supportsPreviewSourceToggle(target: PreviewTarget): boolean {
  if (target.kind !== "file") return false;
  const fileType = getToolbarFileType(target);
  if (
    fileType === "notebook" ||
    fileType === "markdown" ||
    fileType === "html" ||
    fileType === "svg" ||
    fileType === "json"
  ) {
    return true;
  }
  return fileType === "spreadsheet" && isDelimitedSpreadsheetTarget(target);
}
```

Add `isDelimitedSpreadsheetTarget(target)` next to it. It should return true for:

- `.csv`
- `.tsv`
- `text/csv`
- `text/tab-separated-values`
- `application/csv`
- `application/tab-separated-values`

It should return false for:

- `.xlsx`
- `.xls`
- binary Excel content types

This helper keeps toolbar behavior and content behavior in sync.

## Implementation Plan

### Step 1 - Update Type Classification

File: `src/components/chat-file-preview/file-type-utils.ts`

1. Extend `PreviewType` with `html`, `svg`, `json`, and `jsonl`.
2. Add `htm` to `CODE_EXTENSIONS` and `CODE_HIGHLIGHT_MAP`.
3. Add explicit `getPreviewType()` branches for:
   - Markdown
   - HTML/HTM
   - SVG
   - JSON
   - JSONL
   - Notebook
   - Spreadsheet
   - Image
   - Audio/video/PDF/code/text fallback
4. Add or reuse content-type normalization so the same logic works for extensionless preview targets when `contentType` is available.

Acceptance criteria:

- `getPreviewType("index.html") === "html"`.
- `getPreviewType("index.htm") === "html"`.
- `getPreviewType("index", "text/html") === "html"`.
- `getPreviewType("icon.svg") === "svg"`.
- `getPreviewType("config.json") === "json"`.
- `getPreviewType("events.jsonl") === "jsonl"`.
- `getPreviewType("data.csv") === "spreadsheet"` still holds.
- `getPreviewType("notes.txt") === "text"` still holds.

### Step 2 - Update Toolbar File Types and Toggle Eligibility

File: `src/components/preview-panel/preview-utils.ts`

1. Add `"html"` to `ToolbarFileType`.
2. Update `getToolbarFileType()` to return `"html"` for `.html`, `.htm`, and `text/html`.
3. Add `supportsPreviewSourceToggle(target)`.
4. Add `isDelimitedSpreadsheetTarget(target)`.
5. Keep `.xlsx` and `.xls` as `"spreadsheet"` but make `supportsPreviewSourceToggle()` return false for them.

File: `src/components/preview-panel/preview-toolbar.tsx`

1. Replace Markdown-only toggle props with generic file mode props:

   ```ts
   fileViewMode?: "preview" | "source";
   onFileViewModeChange?: (mode: "preview" | "source") => void;
   ```

2. Keep notebook props:

   ```ts
   notebookViewMode?: "report" | "notebook";
   onNotebookViewModeChange?: (mode: "report" | "notebook") => void;
   ```

3. Render the toggle:

   - Notebook: keep the existing `report` <-> `notebook` mapping.
   - Other supported file types: use `supportsPreviewSourceToggle(activeTarget)`.

   Shape:

   ```tsx
   {fileType === "notebook" ? (
     <PreviewSourceToggle ... />
   ) : supportsPreviewSourceToggle(activeTarget) ? (
     <PreviewSourceToggle
       target={activeTarget}
       value={fileViewMode ?? "preview"}
       onChange={(mode) => onFileViewModeChange?.(mode)}
     />
   ) : null}
   ```

Acceptance criteria:

- The same toggle appears for Markdown, HTML, SVG, JSON, CSV, and TSV.
- The toggle does not appear for `.xlsx`, `.xls`, raster images, PDFs, generic code, or plain text.
- Notebook behavior and download menu behavior remain unchanged.

### Step 3 - Replace Markdown-Specific State in Chat

File: `src/components/Chat.tsx`

1. Replace:

   ```ts
   const [tabMarkdownViewModes, setTabMarkdownViewModes] = useState<
     Record<string, "rendered" | "source">
   >({});
   ```

   with:

   ```ts
   const [tabFileViewModes, setTabFileViewModes] = useState<
     Record<string, "preview" | "source">
   >({});
   ```

2. Replace `markdownViewMode` with `fileViewMode`:

   ```ts
   const fileViewMode = activeTabId
     ? (tabFileViewModes[activeTabId] ?? "preview")
     : "preview";
   ```

3. Add a setter similar to the current Markdown setter:

   ```ts
   const setActiveFileViewMode = useCallback((mode: "preview" | "source") => {
     if (!activeTabId) return;
     setTabFileViewModes((prev) => ({ ...prev, [activeTabId]: mode }));
   }, [activeTabId]);
   ```

4. Update `TabRenderState`:

   - Remove `markdownViewMode` and `isMarkdownPreview`.
   - Add `fileViewMode: "preview" | "source"`.
   - Add `supportsFileViewToggle: boolean` if useful for avoiding repeated helper calls.

5. In `tabRenderStates`, compute:

   ```ts
   fileViewMode: tabFileViewModes[tabId] ?? "preview"
   ```

6. Pass generic mode props to `PreviewToolbar`:

   ```tsx
   fileViewMode={fileViewMode}
   onFileViewModeChange={setActiveFileViewMode}
   ```

7. Pass generic mode to `FilePreviewContent`:

   ```tsx
   fileViewMode={state.fileViewMode}
   ```

8. Remove old Markdown-specific prop plumbing:

   - `markdownViewMode`
   - `onMarkdownViewModeChange`
   - `isMarkdownPreview`
   - `tabMarkdownViewModes`

Acceptance criteria:

- Markdown still defaults to rendered view.
- Switching Markdown to source still works.
- The new file types use the same per-tab mode map.
- Switching tabs preserves each tab's selected view mode.

### Step 4 - Update `FilePreviewContent` Props

File: `src/components/chat-file-preview/file-preview-content.tsx`

1. Replace `markdownViewMode?: "rendered" | "source"` with:

   ```ts
   fileViewMode?: "preview" | "source";
   ```

2. Update the memo comparison to compare `fileViewMode`.
3. Compute a local mode:

   ```ts
   const currentFileViewMode = fileViewMode ?? "preview";
   ```

4. Update Markdown branch:

   ```tsx
   currentFileViewMode === "preview" ? renderedMarkdown : markdownSource
   ```

5. Add `previewType` values to `shouldFetchText`:

   ```ts
   previewType === "html" ||
   previewType === "svg" ||
   previewType === "json" ||
   previewType === "jsonl"
   ```

   Keep `spreadsheet` because CSV/TSV source mode uses the fetched text.

### Step 5 - Add HTML Renderer

File: `src/components/chat-file-preview/file-preview-content.tsx`

Add a local `HtmlPreview` component, or move it to a separate file if the component gets too large.

Recommended shape:

```tsx
function HtmlPreview({
  src,
  title,
  layout,
}: {
  src: string;
  title: string;
  layout: PreviewLayout;
}) {
  return (
    <div className={cn("relative min-h-[240px]", layout === "panel" ? "h-full p-3" : "h-[60vh]")}>
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
        referrerPolicy="no-referrer"
        className="h-full w-full rounded-md border bg-white"
      />
    </div>
  );
}
```

Security requirements:

- Do not include `allow-same-origin`.
- Do not include `allow-top-navigation`.
- Do not render HTML with `dangerouslySetInnerHTML` in the parent document.
- Keep the iframe sandboxed even for workspace files authored by the agent.

Render branch:

```tsx
{previewType === "html" && (
  currentFileViewMode === "preview" ? (
    <HtmlPreview src={previewUrl} title={filename} layout={layout} />
  ) : (
    <SourcePreview
      code={textPreview}
      filename={filename}
      layout={layout}
      truncated={lineInfo.truncated}
      totalLines={lineInfo.totalLines}
      maxLines={MAX_TEXT_LINES}
      languageOverride="html"
    />
  )
)}
```

If source text is still loading and the user is in source mode, show the existing loading state. In preview mode, the iframe can load directly from `previewUrl`; still show the existing error state if the fetch fails, because that usually means the file route is not available.

### Step 6 - Add SVG Source Mode

File: `src/components/chat-file-preview/file-preview-content.tsx`

1. Change SVG classification so it lands in `previewType === "svg"`, not generic `image`.
2. In preview mode, reuse `ImagePreview`:

   ```tsx
   <ImagePreview src={previewUrl} alt={filename} layout={layout} />
   ```

3. In source mode, use:

   ```tsx
   <SourcePreview
     code={textPreview}
     filename={filename}
     layout={layout}
     truncated={lineInfo.truncated}
     totalLines={lineInfo.totalLines}
     maxLines={MAX_TEXT_LINES}
     languageOverride="html"
   />
   ```

4. Keep rendered SVG as `<img>`, not inline SVG, so scripts or event handlers inside the SVG are not promoted into the parent DOM.

Acceptance criteria:

- `.svg` still visually renders by default.
- Source mode shows the raw SVG markup with line numbers and copy affordance.
- Raster images do not get a source toggle.

### Step 7 - Add JSON Pretty Renderer

File: `src/components/chat-file-preview/file-preview-content.tsx`

Add JSON formatting helpers near `truncateTextLines()`:

```ts
type FormattedTextResult =
  | { ok: true; text: string; truncated: boolean; totalLines: number }
  | { ok: false; message: string };

function formatJsonPreview(raw: string): FormattedTextResult {
  try {
    const formatted = JSON.stringify(JSON.parse(raw), null, 2);
    return { ok: true, ...truncateTextLines(formatted ?? "null", MAX_TEXT_LINES) };
  } catch (error) {
    return { ok: false, message: "Invalid JSON." };
  }
}
```

Important: Format from the full `bodyText` returned by `response.text()`, not from `textPreview`, because `textPreview` may already be line-truncated and therefore invalid JSON.

State approach:

```ts
const [formattedTextPreview, setFormattedTextPreview] = useState("");
const [formattedLineInfo, setFormattedLineInfo] = useState({
  truncated: false,
  totalLines: 0,
});
const [formattedTextError, setFormattedTextError] = useState<string | null>(null);
```

Reset these alongside the existing text state when `previewUrl` or `previewType` changes.

In the fetch success path, fill the same formatted preview state for both JSON and JSONL:

```ts
if (previewType === "json" || previewType === "jsonl") {
  const formatted =
    previewType === "json"
      ? formatJsonPreview(bodyText)
      : formatJsonLinesPreview(bodyText);
  if (formatted.ok) {
    setFormattedTextPreview(formatted.text);
    setFormattedLineInfo({
      truncated: formatted.truncated,
      totalLines: formatted.totalLines,
    });
    setFormattedTextError(null);
  } else {
    setFormattedTextPreview("");
    setFormattedLineInfo({ truncated: false, totalLines: 0 });
    setFormattedTextError(formatted.message);
  }
}
```

Render branch:

- Preview mode:
  - If formatting succeeded, render `SourcePreview` with `formattedTextPreview` and `languageOverride="json"`.
  - If formatting failed, show a small error message and still render raw source below it, or show the message and rely on source mode. Prefer rendering raw source below the message so the pane is never a dead end.
- Source mode:
  - Render original `textPreview` with `SourcePreview` and `languageOverride="json"` for both JSON and JSONL.

Recommended invalid JSON copy:

```tsx
<p className="p-3 text-sm text-muted-foreground">
  Invalid JSON. Showing raw source.
</p>
```

JSONL handling:

- Add `formatJsonLinesPreview(raw)`.
- Parse each non-empty line independently.
- Pretty-print each parsed line with blank-line separators.
- If any line fails, report `Invalid JSONL on line N. Showing raw source.`
- Use raw source mode for the exact original JSONL.

Acceptance criteria:

- Minified JSON becomes multi-line pretty JSON in preview mode.
- JSONL becomes separated pretty-printed JSON values in preview mode.
- Source mode preserves the exact original raw text.
- Invalid JSON does not crash the preview.
- Invalid JSONL identifies the first invalid line and falls back gracefully.
- Large JSON uses the existing `MAX_TEXT_LINES` truncation message based on formatted line count.

### Step 8 - Add CSV/TSV Raw Source Mode

File: `src/components/chat-file-preview/file-preview-content.tsx`

The existing `spreadsheet` branch already fetches text for CSV/TSV and an `ArrayBuffer` for binary spreadsheets.

Update the branch:

```tsx
{previewType === "spreadsheet" && (
  currentFileViewMode === "source" && !binarySpreadsheet ? (
    <SourcePreview
      code={textPreview}
      filename={filename}
      layout={layout}
      truncated={lineInfo.truncated}
      totalLines={lineInfo.totalLines}
      maxLines={MAX_SPREADSHEET_LINES}
    />
  ) : (
    existingSpreadsheetPreview
  )
)}
```

Notes:

- Do not show the toggle for binary spreadsheet targets. The toolbar helper should prevent it.
- Keep the existing spreadsheet truncation behavior for rendered CSV/TSV.
- Remove the extra spreadsheet truncation paragraph in source mode if `SourcePreview` already renders its own truncation message.

Acceptance criteria:

- `.csv` and `.tsv` default to the spreadsheet grid.
- Source mode shows the original delimited text with line numbers.
- `.xlsx` and `.xls` still show only the spreadsheet renderer.

### Step 9 - Update MIME Maps

Files:

- `src/routes/api/workspaces.$id.fs.content.$.ts`
- `src/routes/api/workspaces.$id.uploads.$.ts`
- `src/routes/api/workspaces.$id.outputs.$.ts`

Add or verify:

```ts
".htm": "text/html; charset=utf-8"
".jsonl": "application/x-ndjson; charset=utf-8"
".tsv": "text/tab-separated-values; charset=utf-8"
```

For upload/output routes that do not currently include charset suffixes, match local style but make sure the base MIME type is present and inline:

- `text/html`
- `application/x-ndjson`
- `text/tab-separated-values`

Add these base types to inline allowlists where needed.

Why:

- HTML iframe rendering depends on inline `text/html`.
- Content-type based classification works better for extensionless files.
- CSV/TSV/JSONL download and preview behavior becomes less dependent on fallback octet-stream behavior.

### Step 10 - Tests

Update or add focused tests.

File: `tests/file-type-utils.test.ts`

- `getPreviewType("index.html") === "html"`.
- `getPreviewType("index.htm") === "html"`.
- `getPreviewType("index", "text/html") === "html"`.
- `getPreviewType("icon.svg") === "svg"`.
- `getPreviewType("icon", "image/svg+xml") === "svg"`.
- `getPreviewType("config.json") === "json"`.
- `getPreviewType("events.jsonl") === "jsonl"`.
- Existing expectations for Markdown, text, CSV, and XLSX still pass.

File: `tests/preview-utils.test.ts`

- `getToolbarFileType("index.html") === "html"`.
- `supportsPreviewSourceToggle()` is true for:
  - Markdown
  - HTML
  - SVG
  - JSON
  - CSV
  - TSV
- `supportsPreviewSourceToggle()` is false for:
  - XLSX
  - PNG
  - PDF
  - generic code like `.py`
  - plain text `.txt`

File: `tests/preview-toolbar-notebook-download.test.tsx` or a new toolbar test file

- Existing notebook tests still pass.
- HTML/SVG/JSON/CSV file targets render the Preview/Source toggle.
- Clicking the toggle calls `onFileViewModeChange("source")`.
- XLSX does not render the toggle.

File: `tests/code-preview.test.tsx` or a new `file-preview-renderers.test.tsx`

Mock `fetch` and render `FilePreviewContent` for each new branch:

- HTML preview mode renders an iframe with:
  - `sandbox` present
  - no `allow-same-origin`
  - `src` equal to `previewUrl`
- HTML source mode renders `.source-preview-lines`.
- SVG preview mode renders an image.
- SVG source mode renders `.source-preview-lines`.
- JSON preview mode pretty-prints minified JSON.
- JSON source mode preserves minified JSON.
- Invalid JSON falls back gracefully.
- CSV preview mode still renders spreadsheet UI or lazy fallback.
- CSV source mode renders `.source-preview-lines`.

Existing tests to keep passing:

```bash
bun run test:run tests/code-preview.test.tsx tests/file-type-utils.test.ts tests/preview-utils.test.ts tests/preview-toolbar-notebook-download.test.tsx
```

Also run:

```bash
bun run typecheck
```

If spreadsheet tests are touched or the CSV rendered branch changes materially, run:

```bash
bun run test:run tests/spreadsheet-preview-render.test.tsx tests/spreadsheet-preview.test.ts
```

## Implementation Order

1. Add explicit preview type classification and tests.
2. Add toolbar file type/toggle eligibility helper and tests.
3. Generalize Chat state from Markdown-only to generic file view mode.
4. Update `PreviewToolbar` to use generic file view mode props.
5. Update `FilePreviewContent` prop from `markdownViewMode` to `fileViewMode`.
6. Add HTML and SVG branches first because they are mostly routing existing renderers.
7. Add JSON formatted state and renderer.
8. Add CSV/TSV source mode.
9. Update MIME maps.
10. Run focused tests and typecheck.

## Edge Cases and Pitfalls

- Do not parse truncated JSON. Use full `bodyText` for formatting, then truncate the formatted output for display.
- Do not offer source mode for binary spreadsheets.
- Do not let `.svg` fall through to `image` before the SVG-specific branch.
- Do not let `.html` fall through to `code` before the HTML-specific branch.
- Do not use `allow-same-origin` on the HTML iframe. With `allow-scripts` plus `allow-same-origin`, sandboxing same-origin content becomes much weaker.
- Do not remove notebook-specific state unless also updating PDF export behavior. Keeping notebook separate is lower risk.
- Watch for duplicate truncation messages. `SourcePreview` already renders one when `truncated` is true.
- The dialog/popover preview currently has no toolbar. It can keep showing default preview mode for new renderers. Adding a dialog toggle is a separate UI task.

## Acceptance Checklist

- [ ] HTML files render as pages by default in the chat preview panel.
- [ ] HTML source mode shows the exact file source.
- [ ] HTML iframe is sandboxed without `allow-same-origin`.
- [ ] SVG files still render as images by default.
- [ ] SVG source mode shows raw SVG markup.
- [ ] JSON files show pretty-printed JSON by default.
- [ ] JSON source mode preserves the raw original text.
- [ ] Invalid JSON has a graceful fallback.
- [ ] CSV and TSV files still show the spreadsheet grid by default.
- [ ] CSV and TSV source mode shows raw delimited text.
- [ ] XLSX and XLS do not show a source toggle.
- [ ] Markdown and notebook toggles still work.
- [ ] Per-tab view mode is preserved when switching tabs.
- [ ] Focused tests and `bun run typecheck` pass.
