# Notebook Markdown Output Rendering Plan

## Goal

Fix Python notebook outputs produced by `display(Markdown(...))` so camelAI no longer shows object repr strings such as:

```text
<IPython.core.display.Markdown object>
<IPython.core.display.Markdown object>
```

When a notebook output includes `text/markdown`, render that markdown using the same markdown renderer and styling used by native notebook markdown cells.

## Current Diagnosis

The reported explanation is confirmed by the supplied example notebook:

```text
/Users/illiana/Downloads/investor-update-apr-2026-troubleshoot-display-markdown.ipynb
```

The notebook has 25 cells. Eight code cells contain `display(Markdown(...))` outputs with this MIME shape:

```json
{
  "text/markdown": ["...actual markdown content..."],
  "text/plain": ["<IPython.core.display.Markdown object>"]
}
```

Affected code cells in the supplied fixture:

| Cell index | Execution count | Output shape |
|---:|---:|---|
| 7 | 6 | Markdown table for MRR metrics |
| 12 | 10 | Markdown table for retention KPIs |
| 13 | 11 | `### Week-1 Retention by Signup Cohort` plus markdown table |
| 14 | 12 | Markdown table for engagement metrics |
| 17 | 14 | Markdown table for legacy metrics |
| 19 | 15 | Markdown table plus blockquote |
| 21 | 16 | `### MRR Waterfall — April 2026` plus markdown table |
| 23 | 18 | `### Top 10 Customers by ARR` plus markdown table |

For all eight of these outputs, `text/plain` is exactly the object repr fallback:

```text
<IPython.core.display.Markdown object>
```

The current renderer picks that fallback because:

- `src/components/chat-file-preview/notebook-preview/utils.ts` chooses output render types in `getOutputRender`.
- The current render order is Vega/Plotly, table, HTML, image, then text.
- `getOutputText()` currently reads `data["text/plain"]` before any other display MIME.
- There is no `text/markdown` render type.
- `src/components/chat-file-preview/notebook-preview/output-renderers.tsx` renders text outputs in a `<pre>`, so any `text/plain` fallback from IPython is shown literally.

For `IPython.display.Markdown`, the useful value is in `data["text/markdown"]`. The `text/plain` value is only a fallback representation and should not win when richer markdown MIME exists.

## Desired Behavior

1. If an output has non-empty `text/markdown`, camelAI renders it as markdown, not as plain text.
2. The rendered output uses `MarkdownRenderer`, matching native notebook markdown cells as closely as possible.
3. Existing richer output handling stays intact:
   - Vega/Plotly direct MIME and extracted HTML charts still render as charts.
   - HTML tables still become native tables when supported.
   - Generic HTML and images still render before plain text fallback.
4. Report mode and Notebook mode both support markdown outputs.
5. Notebook PDF export includes markdown outputs as rendered markdown blocks.
6. Report-mode cell visibility treats markdown-only code outputs as meaningful visible output.

## Implementation Steps

### 1. Add a markdown output render type

File: `src/components/chat-file-preview/notebook-preview/types.ts`

Add a new variant to `NotebookOutputRender`:

```ts
| { kind: 'markdown'; markdown: string }
```

Use `markdown`, not `text`, so call sites cannot accidentally treat this as preformatted plain output.

### 2. Teach the MIME selector about `text/markdown`

File: `src/components/chat-file-preview/notebook-preview/utils.ts`

Add a helper near `getOutputText()`:

```ts
function getMarkdownOutput(output: NotebookOutput): string | null {
  const data = output.data ?? {};
  if (typeof data['text/markdown'] === 'undefined') return null;

  const markdown = toText(data['text/markdown']).trim();
  return markdown ? markdown : null;
}
```

Then update `getOutputRender()` to return markdown before the plain text fallback:

```ts
const markdownOutput = getMarkdownOutput(output);
if (markdownOutput) {
  return { kind: 'markdown', markdown: markdownOutput };
}

const textOutput = getOutputText(output);
```

Recommended precedence:

1. Vega/Plotly
2. Native table from HTML
3. Generic HTML
4. Image
5. Markdown
6. Plain text

This preserves existing chart/table/HTML behavior while preventing `text/plain` from winning over `text/markdown`.

Do not broadly parse `text/plain` as markdown. That would make normal stdout unexpectedly render markdown syntax.

### 3. Count markdown outputs as visual/meaningful output

File: `src/components/chat-file-preview/notebook-preview/utils.ts`

Update `hasVisualOutput()` so markdown-only outputs make a code cell visible in report mode:

```ts
'text/markdown' in data ||
```

Place this alongside the current image and `text/html` checks.

This matters because `classifyCell()` returns `show` early for visual outputs. Without this, a setup-looking code cell that emits user-facing markdown could still be hidden from Report mode.

### 4. Render markdown outputs with `MarkdownRenderer`

File: `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`

Import `MarkdownRenderer`:

```ts
import { MarkdownRenderer } from '@/components/markdown-renderer';
```

Add a branch before `render.kind === 'text'`:

```tsx
if (render.kind === 'markdown') {
  return (
    <div
      className={cn(
        'notebook-output-markdown min-w-0',
        mode === 'notebook' && 'rounded-md bg-background p-4'
      )}
    >
      <MarkdownRenderer content={render.markdown} />
    </div>
  );
}
```

The exact wrapper classes can be adjusted, but keep these principles:

- Use `MarkdownRenderer`, not `<pre>`.
- Do not add a "Markdown" label to code-cell outputs.
- In Report mode, avoid boxing the markdown output in the text-output inset well. It should read like report prose.
- In Notebook mode, use enough padding/background to distinguish it from code stdout while still visually matching native markdown cells.

### 5. Include markdown outputs in report export/PDF

File: `src/components/chat-file-preview/notebook-preview/report-export-model.ts`

`NotebookReportExportBlock` already has:

```ts
| { id: string; kind: 'markdown'; markdown: string }
```

Update the `switch (render.kind)` in `buildNotebookReportExportModel()`:

```ts
case 'markdown':
  blocks.push({
    id,
    kind: 'markdown',
    markdown: render.markdown,
  });
  return;
```

This should make PDF export work without changing `pdf-document.tsx`, because markdown blocks already route to `PdfMarkdown`.

### 6. Add focused tests

File: `tests/notebook-preview-utils.test.ts`

Add a test proving markdown MIME wins over useless plain fallback:

```ts
it('renders text/markdown before text/plain fallbacks', () => {
  const output: NotebookOutput = {
    output_type: 'display_data',
    data: {
      'text/markdown': '## Summary\n\n**Ready**',
      'text/plain': '<IPython.core.display.Markdown object>',
    },
  };

  const render = getOutputRender(output);

  expect(render.kind).toBe('markdown');
  if (render.kind !== 'markdown') {
    throw new Error(`Expected markdown output, got ${render.kind}`);
  }
  expect(render.markdown).toBe('## Summary\n\n**Ready**');
});
```

Add a second test for array-valued markdown, because notebook MIME values may be split into string arrays:

```ts
data: {
  'text/markdown': ['# A\n', 'Body'],
  'text/plain': '<IPython.core.display.Markdown object>',
}
```

Expected markdown: `# A\nBody`.

File: `tests/notebook-report-export-model.test.ts`

Add a regression test showing a code cell with markdown output appears in the report export model:

```ts
it('keeps markdown display outputs as markdown report blocks', () => {
  const notebook: NotebookFile = {
    cells: [
      {
        cell_type: 'code',
        source: 'from IPython.display import Markdown, display\ndisplay(Markdown("## Result"))',
        outputs: [
          {
            output_type: 'display_data',
            data: {
              'text/markdown': '## Result',
              'text/plain': '<IPython.core.display.Markdown object>',
            },
          },
        ],
      },
    ],
  };

  const model = buildNotebookReportExportModel(notebook);

  expect(model.blocks).toEqual([
    expect.objectContaining({
      kind: 'markdown',
      markdown: '## Result',
    }),
  ]);
});
```

Optional component test:

- Render `OutputRenderer` with `text/markdown` plus `text/plain`.
- Assert the markdown heading text appears as a heading and the object repr is absent.

Only add this if the existing test setup can render `OutputRenderer` cleanly without heavy chart/runtime mocking.

### 7. Manual verification fixture

Use the supplied notebook:

```text
/Users/illiana/Downloads/investor-update-apr-2026-troubleshoot-display-markdown.ipynb
```

It contains eight `display(Markdown(...))` cells and should reproduce the bug before the fix.

For a smaller synthetic fixture, use a code cell like:

```python
from IPython.display import Markdown, display

display(Markdown("## Status\n\n**All checks passed.**"))
display(Markdown("- item one\n- item two"))
```

Open it in the camelAI notebook preview.

Verify:

- No `<IPython.core.display.Markdown object>` text appears.
- Report mode renders headings, paragraphs, bold text, and lists like native report markdown.
- Notebook mode renders the markdown output below the code cell with markdown styling, not monospace preformatted text.
- PDF export includes the rendered markdown output.

The unit tests do not need the full notebook file. Use the observed MIME bundle shape from the supplied notebook as the minimal regression fixture.

## Acceptance Criteria

- `display(Markdown(...))` outputs render from `text/markdown`.
- `text/plain` object repr fallback is not visible when `text/markdown` exists.
- Native markdown cells and Python markdown display outputs both use `MarkdownRenderer`.
- Existing chart, table, HTML, image, stream, and error output tests still pass.
- Report export/PDF output includes markdown display outputs.

## Suggested Test Commands

```bash
bun run test:run -- tests/notebook-preview-utils.test.ts tests/notebook-report-export-model.test.ts
bun run typecheck
```
