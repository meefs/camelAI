# Source Preview Line Numbers and Markdown Raw View

## Problem

The file preview pane has two related issues:

1. Rendered Markdown should use the available preview width. A narrow `max-w-*` wrapper makes Markdown wrap early when the app preview pane is wide.
2. Raw Markdown source is currently plain `<pre>` output. It needs at least the same padding as plain text, and ideally the same IDE-like source treatment as code files: monospace text, a line-number gutter, copy affordance, and syntax highlighting when available.

There is also a performance/consistency issue in the existing code preview: line numbers appear only after async Shiki highlighting finishes. The line numbers themselves are CSS counters, so the delay is caused by waiting for highlighted HTML, not by the gutter rendering.

## Current State

Relevant files:

- `src/components/chat-file-preview/file-preview-content.tsx`
  - Renders file-type-specific previews.
  - Markdown has a rendered/source branch.
  - Plain text uses a padded `<pre>`.
  - Code files route through `CodePreview`.
- `src/components/chat-file-preview/code-preview.tsx`
  - Runs `codeToHtml(...)` in `useEffect`.
  - Shows highlighted Shiki HTML after the promise resolves.
  - Falls back to an unnumbered plain `<pre>` while Shiki is loading or unavailable.
- `src/styles/globals.css`
  - `.code-preview-lines code` and `.code-preview-lines .line::before` provide CSS counter-based line numbers.
- `src/lib/shiki-config.ts`
  - Defines supported Shiki languages, including `markdown`.
- `src/components/chat-file-preview/file-type-utils.ts`
  - Maps file extensions to Shiki languages.
  - Markdown is intentionally handled as `previewType === "markdown"`, but `.md` is not currently mapped for raw-source highlighting.
  - SVG is treated as an image preview and does not yet expose a raw/source toggle.

## Goals

- Rendered Markdown should have preview-pane padding but no max width.
- Raw Markdown should use the same source viewer as code files.
- Code, raw Markdown, raw SVG, and future raw-source views should share one reusable component.
- Line numbers should be visible immediately, before Shiki finishes loading.
- Shiki should enhance source previews with syntax color without changing layout.
- The implementation should be reusable across file types and not require duplicate raw-view styling.

## Non-Goals

- Do not replace Monaco in the Computer tab.
- Do not add editing behavior to the preview pane.
- Do not change notebook raw rendering in this pass unless it naturally shares the source-preview primitive without expanding scope.
- Do not add server-side syntax highlighting.

## Proposed Design

### 1. Remove Rendered Markdown Max Width

In `FilePreviewContent`, keep the rendered Markdown wrapper padded, but remove any centering/max-width classes such as:

```tsx
mx-auto max-w-3xl
```

Target shape:

```tsx
<div className="px-6 py-6">
  <MarkdownRenderer content={textPreview} />
</div>
```

The outer pane should control scroll behavior. The inner wrapper should only provide comfortable padding.

### 2. Convert `CodePreview` Into a Shared Source Preview

Refactor `CodePreview` into a reusable source renderer. Either:

- Rename it to `SourcePreview`, leaving a small `CodePreview` wrapper for compatibility, or
- Keep the `CodePreview` name but make it explicitly suitable for all raw text/source previews.

Preferred API:

```ts
interface SourcePreviewProps {
  code: string;
  filename: string;
  layout: "panel" | "dialog";
  truncated: boolean;
  totalLines: number;
  maxLines?: number;
  languageOverride?: string | null;
  emptyMessage?: string;
}
```

`filename` remains the default language source. `languageOverride` lets Markdown raw view force `markdown` and SVG raw view force `html` or `xml` even when the preview type is not `code`.

### 3. Render Line Numbers Synchronously

The fallback should not be a plain `<pre>`. It should render line spans immediately using React, with the same CSS class contract as Shiki output:

```tsx
<pre>
  <code>
    {lines.map((line, index) => (
      <span className="line" key={index}>
        {line || "\u00a0"}
      </span>
    ))}
  </code>
</pre>
```

This means:

- The gutter appears on first paint.
- Empty lines still occupy height.
- Shiki can still replace or enhance the source once ready.

When highlighted HTML is ready, render the Shiki HTML inside the same source-preview wrapper. The CSS counter gutter will continue to work because Shiki emits `.line` spans.

### 4. Stabilize the Gutter CSS

Move the current `.code-preview-lines` styles to a more generic class, for example `.source-preview-lines`.

Recommended behavior:

- The gutter should have a stable width based on `totalLines` or visible line count.
- The content column should not shift when Shiki replaces fallback content.
- Horizontal scrolling should include source content but keep padding comfortable.

Implementation options:

1. Set a CSS custom property from React:

```tsx
style={{ "--source-line-number-digits": String(String(totalLines).length) } as React.CSSProperties}
```

2. Use it in CSS:

```css
.source-preview-lines .line::before {
  width: calc(var(--source-line-number-digits, 2) * 0.65em);
}
```

Keep the existing muted/low-contrast gutter style unless design feedback asks for stronger contrast.

### 5. Keep Shiki Async, But Treat It As Progressive Enhancement

Do not try to make Shiki emit line numbers as the fix. That would still wait for:

- highlighter initialization,
- theme imports,
- language import,
- tokenization,
- HTML generation.

Instead:

- Render the line-numbered fallback immediately.
- Start `codeToHtml(...)` in `useEffect`.
- Swap in highlighted HTML when ready.
- On Shiki failure, keep the fallback visible.

This preserves current client-side highlighting behavior while removing the line-number delay.

### 6. Add Markdown and SVG Language Routing

Update `src/components/chat-file-preview/file-type-utils.ts`:

- Add `md: "markdown"` to `CODE_HIGHLIGHT_MAP`.
- Add `svg: "html"` or `svg: "xml"` depending on which available Shiki grammar looks better in practice.

Because `.md` still needs rendered/source preview behavior, keep `getPreviewType(...).extension === "md" => "markdown"` before the generic code branch.

SVG is currently categorized as an image. To support rendered/raw SVG:

- Keep SVG renderable as an image for the default rendered view.
- Add a source toggle for SVG in the toolbar/view-mode state.
- When source mode is active, fetch the SVG text and route it through `SourcePreview`.

Prefer implementing SVG source mode as a separate follow-up if the current task needs to stay focused on Markdown and shared source-view infrastructure.

## Implementation Plan

### Step 1 - Create the Shared Source Preview

File: `src/components/chat-file-preview/code-preview.tsx`

Recommended minimal path:

1. Rename the exported implementation to `SourcePreview`.
2. Keep `export function CodePreview(...)` as a wrapper around `SourcePreview` if many call sites depend on the name.
3. Add synchronous `lines` derivation with `useMemo`.
4. Replace the current unnumbered fallback with the line-span fallback.
5. Keep the copy button unchanged.
6. Keep truncation messaging unchanged.

Acceptance criteria:

- A code file shows line numbers immediately.
- Syntax colors may appear later, but line height/gutter/content alignment does not jump.
- If Shiki fails, line numbers remain visible.

### Step 2 - Generalize the CSS

File: `src/styles/globals.css`

1. Rename `.code-preview-lines` to `.source-preview-lines`.
2. Optionally keep `.code-preview-lines` as an alias during migration:

```css
.source-preview-lines code,
.code-preview-lines code {
  counter-reset: line;
  display: flex;
  flex-direction: column;
}
```

3. Add stable gutter width using a CSS custom property.

Acceptance criteria:

- Existing code previews keep their gutter.
- Fallback and highlighted states use the same gutter spacing.

### Step 3 - Route Raw Markdown Through Source Preview

File: `src/components/chat-file-preview/file-preview-content.tsx`

In the `previewType === "markdown"` source branch, replace the raw `<pre>` with:

```tsx
<SourcePreview
  code={textPreview}
  filename={filename}
  layout={layout}
  truncated={lineInfo.truncated}
  totalLines={lineInfo.totalLines}
  maxLines={MAX_TEXT_LINES}
  languageOverride="markdown"
/>
```

Do not duplicate truncation text outside `SourcePreview` if `SourcePreview` already renders it.

Acceptance criteria:

- Rendered Markdown still uses full width with padding.
- Raw Markdown has padding, line numbers, copy button, and Markdown highlighting.
- Markdown source mode no longer has text flush against the pane edge.

### Step 4 - Add Markdown Shiki Mapping

File: `src/components/chat-file-preview/file-type-utils.ts`

Add:

```ts
md: "markdown",
```

This is mainly for consistency and for any direct source preview call that relies on filename-based language detection.

Acceptance criteria:

- `getShikiLanguage("README.md")` returns `"markdown"`.
- `getPreviewType("README.md")` still returns `"markdown"`, not `"code"`.

### Step 5 - Optional SVG Source Mode

Files likely involved:

- `src/components/chat-file-preview/file-type-utils.ts`
- `src/components/chat-file-preview/file-preview-content.tsx`
- `src/components/preview-panel/preview-toolbar.tsx`
- `src/components/Chat.tsx` if per-tab SVG view mode state is owned there
- `src/components/preview-panel/preview-source-toggle.tsx`

Implementation outline:

1. Add `svg: "html"` or `svg: "xml"` to `CODE_HIGHLIGHT_MAP`.
2. Treat SVG as a preview type that supports rendered/source mode.
3. Rendered mode continues to use the existing image preview.
4. Source mode fetches the SVG text and renders `SourcePreview` with `languageOverride`.
5. Reuse the same preview-source toggle used by Markdown.

Acceptance criteria:

- Opening an `.svg` file defaults to rendered image mode.
- Toggling to source shows line-numbered highlighted SVG.
- The source view uses the same gutter/padding/copy affordance as code and Markdown.

## Testing

Run the smallest useful set after implementation:

```bash
bun run typecheck
```

Add or update focused tests if existing coverage is available for file type detection:

- `getShikiLanguage("README.md") === "markdown"`
- `getPreviewType("README.md") === "markdown"`
- `getShikiLanguage("icon.svg")` returns the chosen SVG language once SVG source mode is added.

Manual checks:

1. Open a wide preview pane with a Markdown file in rendered mode. Confirm text uses the available width and only pane padding constrains it.
2. Toggle Markdown to source. Confirm padding, line numbers, copy button, and highlighting.
3. Open an HTML/TS/JS file. Confirm line numbers are visible immediately on first paint, before highlighting finishes.
4. Test dark mode if practical, because Shiki colors are theme-variable driven.
5. If SVG source mode is included, verify rendered/source toggle behavior for `.svg`.

## Review Notes

Watch for these likely mistakes during review:

- Rendering line numbers only in the highlighted Shiki branch. That would preserve the current delay.
- Duplicating truncation messages in both `FilePreviewContent` and `SourcePreview`.
- Accidentally changing Markdown preview type from `"markdown"` to `"code"`.
- Adding raw SVG support by treating SVG only as code, which would remove the rendered image default.
- Introducing layout shift between fallback and highlighted states because the two branches use different padding, line height, or gutter width.
