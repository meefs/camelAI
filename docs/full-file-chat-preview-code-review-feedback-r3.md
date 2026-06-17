# Full File Chat Preview Code Review Feedback R3

Scope: review of the two bugs reported during code review. Both findings are valid and should be fixed before PR.

## Findings

### 1. Initial previews can exceed the intended byte cap

Severity: Medium

`readTextPreviewFromStream()` increments `bytesRead`, decodes the entire chunk into `text`, and only then checks `INITIAL_TEXT_PREVIEW_BYTE_LIMIT`:

- `src/routes/api/text-preview-stream.ts:128`
- `src/routes/api/text-preview-stream.ts:140`
- `src/routes/api/text-preview-stream.ts:151`

That means a single large chunk with no newline can be returned in full. I reproduced this locally with a 1.1 MB ASCII chunk and got:

```json
{"chars":1100000,"truncated":true,"max":1000000}
```

This defeats the point of the initial load cap and can still send oversized JSON payloads on first preview.

Recommended fix:

- In `mode === "initial"`, calculate the remaining byte budget before decoding/appending each chunk.
- Decode only `value.slice(0, remainingBudget)` when a chunk would cross `INITIAL_TEXT_PREVIEW_BYTE_LIMIT`.
- Mark `truncated = true`, cancel the reader, and break immediately after appending the budgeted slice.
- Keep the existing full-mode guard; it solves a different problem.
- Keep the newline cap too, but apply whichever limit is hit first.

Implementation note: slicing a UTF-8 chunk can cut through a multibyte character. Using `TextDecoder.decode(slice, { stream: true })` and not flushing after early cancellation is acceptable because it drops an incomplete trailing code point instead of emitting a replacement character.

Tests to add:

- Initial mode with one chunk larger than `INITIAL_TEXT_PREVIEW_BYTE_LIMIT` and no newline returns at most the cap for ASCII input and cancels the stream.
- Initial mode with a newline before the byte cap still truncates by line count.
- Existing multibyte split test should continue to pass.

### 2. Large full previews still render one DOM node per line

Severity: Medium

`SourcePreview` skips Shiki for large content, but it still splits the entire string and renders every line as a `<span>`:

- `src/components/chat-file-preview/code-preview.tsx:57`
- `src/components/chat-file-preview/code-preview.tsx:65`
- `src/components/chat-file-preview/code-preview.tsx:149`

Full previews allow up to 5 MB. A newline-heavy file can therefore create hundreds of thousands or millions of React elements after the user clicks "Show all lines." The current "skips Shiki" test only proves syntax highlighting is skipped; it does not guard against the DOM explosion.

Recommended fix:

- Avoid `code.split("\n")` until after deciding the content is small enough for per-line rendering.
- Count lines with a cheap newline counter for threshold decisions and line-number digit width.
- For large non-highlighted content, render a plain `<pre><code>{code}</code></pre>` text node, or use virtualization if line numbers must be preserved for huge files.
- If choosing a plain fallback, use a dedicated class so wrapping/spacing remains readable even without `.line` spans.
- Keep Copy using the original `code` string, not a capped render string.

Suggested threshold:

- Reuse `HIGHLIGHT_MAX_LINES` as the per-line DOM cap, or introduce a clearly named `LINE_SPAN_RENDER_MAX_LINES`.
- Above that cap, render plain text without per-line spans.

Tests to add:

- A newline-heavy source above the line-render cap does not call Shiki and does not render thousands of `.line` spans.
- A small source still renders per-line spans with line numbers.
- Copy still copies the complete source text in the large fallback path.

## Summary

Both findings are real. The backend issue affects the initial network payload size, and the frontend issue affects browser responsiveness after a full load. I would treat both as PR blockers for this feature.
