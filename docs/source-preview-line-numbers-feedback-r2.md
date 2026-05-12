# Source Preview Line Numbers Feedback R2

## Findings

### P1 - Highlighted source likely renders extra blank rows between every line

`src/styles/globals.css:284-288`

The wrap follow-up sets `white-space: pre-wrap` on the Shiki `<pre>`:

```css
.source-preview-lines pre,
.code-preview-lines pre {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

That is likely the cause of the new visual issue where the raw source looks double-spaced. Shiki-generated HTML commonly includes literal newline text nodes between `.line` spans, for example:

```html
<span class="line">line 1</span>
<span class="line">line 2</span>
```

When the parent `<pre>` preserves whitespace, those separator newlines can render in addition to each block `.line`, creating an apparent blank row or extra spacing between every source line.

The fix should preserve whitespace inside each logical source line, but stop preserving whitespace between the line elements. Move whitespace preservation from `pre` to `.line` only:

```css
.source-preview-lines pre,
.code-preview-lines pre {
  min-width: 0;
  white-space: normal;
  overflow-wrap: normal;
}

.source-preview-lines .line,
.code-preview-lines .line {
  display: block;
  min-height: 1.25rem;
  padding-left: calc(var(--source-line-number-width) + var(--source-line-number-gap));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

This keeps indentation and wrapping inside each source line while collapsing Shiki's inter-line formatting whitespace.

### P2 - Add coverage or a manual check for the highlighted branch

`tests/code-preview.test.tsx` currently mocks `codeToHtml` with a never-resolving promise. That validates the immediate fallback, but it cannot catch the double-spacing issue because the highlighted branch never renders.

Add either:

- a test where mocked `codeToHtml` resolves to Shiki-like HTML containing newline text nodes between `.line` spans, or
- a required browser/manual check for a highlighted Markdown/HTML file after Shiki finishes loading.

Manual acceptance criteria:

- Before Shiki resolves, fallback source lines are tightly spaced at `leading-5`.
- After Shiki resolves, line spacing remains the same.
- Long lines wrap by default.
- Wrapped continuation rows align under the source text column, not the gutter.

## Notes

The second implementation addressed the previous no-wrap feedback structurally:

- `overflow-x-auto` and `min-w-max` were removed from the source wrapper.
- The gutter now uses padded `.line` blocks, which is the right model for wrapped logical lines.
- `pr-10` was added to reserve room for the copy button.

Targeted tests passed:

```bash
bun run test:run tests/code-preview.test.tsx tests/file-type-utils.test.ts
```
