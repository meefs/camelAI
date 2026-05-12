# Source Preview Line Numbers Feedback R3

## Findings

### P2 - `.txt` and other plain text previews still bypass `SourcePreview`

`src/components/chat-file-preview/file-preview-content.tsx:337-365`

The source preview work is now applied to code files and Markdown source mode, but the plain text branch still renders the old raw `<pre>`:

```tsx
{previewType === 'text' && (
  <pre className={cn('w-full min-w-0 overflow-auto text-xs', ...)}>
    {textPreview || 'No preview content available.'}
  </pre>
)}
```

That means `.txt` files still do not get line numbers, the shared copy affordance, or the new wrapping/gutter behavior.

Route the `previewType === "text"` ready state through `SourcePreview` as well:

```tsx
{textStatus === 'ready' && (
  <SourcePreview
    code={textPreview}
    filename={filename}
    layout={layout}
    truncated={lineInfo.truncated}
    totalLines={lineInfo.totalLines}
    maxLines={MAX_TEXT_LINES}
  />
)}
```

Do not add `txt: "text"` to `CODE_HIGHLIGHT_MAP` just to force `.txt` into `previewType === "code"`. That would change file-type classification and break the current expectation that `getPreviewType("notes.txt")` remains `"text"`. The cleaner change is to keep the text preview type and share the source renderer at the component level.

This will also improve other plain text previews such as `.log` and extensionless `text/plain` files, while CSV/TSV/XLSX still remain on the spreadsheet path.

Suggested test updates:

- Keep `getPreviewType("notes.txt") === "text"`.
- Add a component-level assertion, if practical, that the text preview branch renders `.source-preview-lines`.
- At minimum, add a `SourcePreview` test with `filename="notes.txt"` and no `languageOverride` to confirm the null language path uses the `"text"` highlighter fallback without breaking the line-numbered fallback.

## Notes

The R2 feedback appears addressed:

- The parent Shiki `<pre>` now uses `white-space: normal`, while `.line` owns `white-space: pre-wrap`.
- The highlighted-branch test now resolves Shiki-like HTML with newline text nodes between `.line` spans.
- The source gutter model uses padded block `.line` elements, which is the right structure for wrapped continuation rows.

I did not find any additional blocking issues in this pass.

Verification run:

```bash
bun run test:run tests/code-preview.test.tsx tests/file-type-utils.test.ts
bun run typecheck
```
