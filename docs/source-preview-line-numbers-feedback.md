# Source Preview Line Numbers Feedback

## Findings

### P1 - Source previews still disable word wrap

`src/components/chat-file-preview/code-preview.tsx:111-120`

Both highlighted and fallback branches still use:

```tsx
overflow-x-auto
[&_pre]:min-w-max
```

That preserves the old horizontal-scroll behavior. Shiki also emits a `<pre>`, so unless the wrapper explicitly overrides `white-space`, long Markdown/source lines will continue to run off screen.

Requested behavior: source previews should wrap by default. Remove the `min-w-max` source-preview styling and replace the horizontal-scroll default with wrapping styles.

Recommended direction:

```css
.source-preview-lines {
  overflow-x: hidden;
}

.source-preview-lines pre {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

Also consider reserving right padding for the copy button, e.g. `pr-10`, so wrapped top lines do not sit underneath the absolute-positioned copy control.

### P1 - The current gutter model will not align wrapped lines correctly

`src/styles/globals.css:274-297`

The current line-number CSS assumes one visual row per source line:

```css
.source-preview-lines code {
  display: flex;
  flex-direction: column;
}

.source-preview-lines .line::before {
  display: inline-block;
  margin-right: 1rem;
}
```

Once wrapping is enabled, continuation rows need to start under the source text, not under the line-number gutter. Avoid a flex/grid approach unless the line content is wrapped in a dedicated content span; Shiki emits token spans directly inside `.line`, so CSS has to work with that structure.

Recommended CSS shape:

```css
.source-preview-lines {
  --source-line-number-gap: 1rem;
  --source-line-number-width: max(
    1.25rem,
    calc(var(--source-line-number-digits, 2) * 0.65em)
  );
}

.source-preview-lines code {
  counter-reset: line;
  display: block;
}

.source-preview-lines .line {
  display: block;
  min-height: 1.25rem;
  padding-left: calc(var(--source-line-number-width) + var(--source-line-number-gap));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.source-preview-lines .line::before {
  content: counter(line);
  counter-increment: line;
  display: inline-block;
  width: var(--source-line-number-width);
  margin-left: calc(-1 * (var(--source-line-number-width) + var(--source-line-number-gap)));
  margin-right: var(--source-line-number-gap);
  text-align: right;
  color: var(--color-muted-foreground);
  opacity: 0.3;
  user-select: none;
}
```

This keeps one line number per source line while letting the source text wrap inside the padded content column.

### P2 - Add a regression check or manual verification for wrapping

`tests/code-preview.test.tsx` verifies that line-numbered fallback content renders before Shiki resolves, which is good. It does not cover the new wrapping requirement.

JSDOM will not prove visual wrapping, so the useful coverage is either:

- a unit-level guard that `SourcePreview` no longer applies `min-w-max` / horizontal-scroll-only classes, plus
- a manual or browser check with a Markdown file containing a long paragraph, a long URL, and an indented/code-like line.

Manual acceptance criteria:

- Raw Markdown wraps without horizontal scrolling in the preview pane.
- Each source line has exactly one line number.
- Wrapped continuation rows align under the source text, not under the gutter.
- The fallback and highlighted Shiki states use the same gutter width and line height, so the layout does not jump when highlighting finishes.

## Notes

The implementation otherwise follows the planned shape:

- `SourcePreview` now renders a line-numbered fallback before Shiki resolves.
- Raw Markdown routes through `SourcePreview`.
- Rendered Markdown no longer has the narrow max-width wrapper.
- `.md` now maps to Shiki `markdown` while `getPreviewType("README.md")` still returns `"markdown"`.

Targeted tests passed:

```bash
bun run test:run tests/code-preview.test.tsx tests/file-type-utils.test.ts
```
