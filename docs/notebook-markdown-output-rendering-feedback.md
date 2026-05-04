# Notebook Markdown Output Rendering Feedback

## Review Summary

The core `display(Markdown(...))` fix looks correct. The renderer now introduces a `markdown` output kind, reads `text/markdown` before falling back to `text/plain`, renders it through `MarkdownRenderer`, includes it in report export, and adds focused regression coverage.

Focused tests passed:

```bash
bun run test:run -- tests/notebook-preview-utils.test.ts tests/notebook-report-export-model.test.ts tests/markdown-renderer.test.ts
```

Result: 3 test files passed, 29 tests passed.

## Findings

### 1. Inline HTML inside markdown outputs is still not supported

Severity: Medium

The user validation notebook confirms the remaining gap:

```text
/Users/illiana/Downloads/display_markdown_renderer_test.ipynb
```

Cell 8 contains `text/markdown` like:

```markdown
## HTML-ish Markdown

Markdown should usually allow simple inline HTML too.

<mark>Highlighted text via inline HTML</mark>

<sub>subscript-ish text</sub> and <sup>superscript-ish text</sup>
```

The new markdown output branch correctly sends this through `MarkdownRenderer`:

- `src/components/chat-file-preview/notebook-preview/output-renderers.tsx:174`
- `src/components/chat-file-preview/notebook-preview/output-renderers.tsx:182`

But `MarkdownRenderer` currently configures `react-markdown` with only `remarkGfm`:

- `src/components/markdown-renderer.tsx:444`
- `src/components/markdown-renderer.tsx:445`

By default, `react-markdown` does not parse raw HTML into real React elements. That means `<mark>`, `<sub>`, and `<sup>` remain unstyled markdown text instead of becoming semantic HTML elements.

Recommended fix:

1. Add sanitized raw HTML support, preferably as an opt-in prop on `MarkdownRenderer`:

   ```ts
   interface MarkdownRendererProps {
     content: string;
     className?: string;
     isStreaming?: boolean;
     variant?: 'default' | 'user';
     allowInlineHtml?: boolean;
     ...
   }
   ```

2. Use `rehype-raw` and `rehype-sanitize` together. Do not enable `rehypeRaw` without sanitization, since this renderer is reused across chat messages, file previews, notebook previews, and tool output.

3. Keep `allowInlineHtml` off by default for chat surfaces. Turn it on for notebook markdown surfaces:

   - `src/components/chat-file-preview/notebook-preview/output-renderers.tsx` markdown output branch
   - `src/components/chat-file-preview/notebook-preview/notebook-markdown-cell.tsx`
   - `src/components/chat-file-preview/notebook-preview/report-markdown-cell.tsx`

4. Allow and render at least these simple inline tags:

   - `mark`
   - `sub`
   - `sup`
   - optionally `br`

5. Add `components` entries for these tags if needed, especially `mark`, so the highlight works reliably in both light and dark themes. Example styling:

   ```tsx
   mark: ({ children }) => (
     <mark className="rounded bg-yellow-200/70 px-0.5 text-inherit dark:bg-yellow-300/30">
       {wrap(children, 'mark')}
     </mark>
   )
   ```

6. Add tests in `tests/markdown-renderer.test.ts`:

   - With `allowInlineHtml`, `<mark>highlight</mark>` renders as a `MARK` element.
   - With `allowInlineHtml`, `<sub>2</sub>` and `<sup>3</sup>` render as `SUB` and `SUP`.
   - Without `allowInlineHtml`, raw HTML remains disabled for existing chat-style markdown behavior.
   - With `allowInlineHtml`, unsafe tags/attributes are sanitized, for example no `<script>` element and no event-handler attributes.

If PDF export is expected to match this behavior, note that `src/components/chat-file-preview/notebook-preview/pdf-markdown.tsx:412` currently renders markdown HTML nodes as an "Inline HTML content is not included in PDF export" fallback. The immediate browser-preview bug can be fixed first, but export parity should be explicit.

### 2. Empty `text/markdown` keys are classified as visual output

Severity: Low

`getMarkdownOutput()` correctly ignores empty markdown values:

- `src/components/chat-file-preview/notebook-preview/utils.ts:926`
- `src/components/chat-file-preview/notebook-preview/utils.ts:932`

But `hasVisualOutput()` checks only for key presence:

- `src/components/chat-file-preview/notebook-preview/utils.ts:1052`

That means an output with an empty `text/markdown` key could force a setup-looking code cell into Report mode even though `getOutputRender()` will not render it as markdown. If that same output also has a useless `text/plain` fallback, Report mode could still expose fallback noise.

Recommended fix:

```ts
return (
  hasVegaMime ||
  hasPlotlyMime ||
  'image/png' in data ||
  'image/jpeg' in data ||
  'image/svg+xml' in data ||
  getMarkdownOutput(output) !== null ||
  'text/html' in data
);
```

Add or adjust the `hasVisualOutput` test to prove empty `text/markdown` does not count as visual output.

## What Looks Good

- MIME precedence is correct for the reported bug: charts/tables/HTML/images still win, markdown wins before plain text, and plain text remains the fallback.
- The regression tests use the real fixture shape from the supplied notebook: `text/markdown` plus the useless `<IPython.core.display.Markdown object>` fallback.
- Report export now preserves markdown display outputs as markdown blocks, so PDF export can reuse the existing markdown export path.

## Suggested Follow-Up Test Command

After implementing the inline HTML follow-up:

```bash
bun run test:run -- tests/markdown-renderer.test.ts tests/notebook-preview-utils.test.ts tests/notebook-report-export-model.test.ts
bun run typecheck
```
