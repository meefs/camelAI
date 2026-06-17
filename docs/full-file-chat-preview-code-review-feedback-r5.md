# Full File Chat Preview Code Review Feedback R5

Scope: review of the new exact-byte-limit truncation bug reported during code review. The finding is valid.

## Finding

### Exact-limit initial previews are incorrectly marked as byte-truncated

Severity: Low / P3

The current byte-cap logic marks an initial preview as truncated when `bytesRead` reaches `INITIAL_TEXT_PREVIEW_BYTE_LIMIT`, before checking whether the stream is actually at EOF:

- `src/routes/api/text-preview-stream.ts:210`
- `src/routes/api/text-preview-stream.ts:218`
- `src/routes/api/text-preview-stream.ts:234`
- `src/routes/api/text-preview-stream.ts:236`

I reproduced the issue with a single stream chunk of exactly `INITIAL_TEXT_PREVIEW_BYTE_LIMIT` ASCII bytes followed by EOF:

```json
{"len":1000000,"truncated":true,"truncatedBy":"bytes","totalLines":null}
```

That file fits within the initial preview budget and should be returned as a complete preview. Marking it truncated causes the UI to show byte-truncation copy and offer an unnecessary full-load action.

## Recommended Fix

Only mark byte truncation when either:

- the current chunk actually crosses the remaining byte budget, or
- the preview has already consumed the full byte budget and a later `reader.read()` proves there is more data.

Concretely:

- Do not use `bytesRead >= INITIAL_TEXT_PREVIEW_BYTE_LIMIT` as an immediate truncation condition after decoding a chunk that exactly fits.
- Let the loop continue after an exact-limit chunk.
- If the next `reader.read()` returns `done: true`, finish normally with `truncated: false`.
- If the next `reader.read()` returns another chunk and the remaining budget is `0`, then set `truncated = true`, `truncatedBy = "bytes"`, cancel, and break.

Implementation nuance: the current code calls `chunkLooksBinary(value)` before checking the initial-mode remaining budget. If the fix reads one extra chunk to determine whether there is more data, avoid letting bytes beyond the preview budget change the result to a binary error. For initial mode, check `remainingByteBudget <= 0` before binary-sniffing the new chunk, and binary-sniff only the bytes that will actually be decoded into the preview.

Suggested flow:

```ts
if (mode === "initial") {
  const remainingByteBudget = INITIAL_TEXT_PREVIEW_BYTE_LIMIT - bytesRead;
  if (remainingByteBudget <= 0) {
    truncated = true;
    truncatedBy = "bytes";
    cancelledEarly = true;
    await reader.cancel().catch(() => {});
    break;
  }

  const chunkCrossesByteLimit = value.byteLength > remainingByteBudget;
  const chunkToDecode = chunkCrossesByteLimit
    ? value.slice(0, remainingByteBudget)
    : value;

  if (chunkLooksBinary(chunkToDecode)) {
    // existing binary error path
  }

  bytesRead += chunkToDecode.byteLength;
  text += decoder.decode(chunkToDecode, { stream: true });

  // line cap check stays here

  if (chunkCrossesByteLimit) {
    truncated = true;
    truncatedBy = "bytes";
    cancelledEarly = true;
    await reader.cancel().catch(() => {});
    break;
  }
}
```

Full-mode behavior can keep its current `bytesRead > fullByteLimit` guard because exact-limit full previews are already allowed there.

## Tests To Add

- Initial mode with one chunk of exactly `INITIAL_TEXT_PREVIEW_BYTE_LIMIT` bytes and EOF returns:
  - `truncated: false`
  - no `truncatedBy`
  - `totalLines: 1` for a one-line ASCII input
  - no stream cancellation
- Initial mode with multiple chunks whose final chunk brings `bytesRead` exactly to `INITIAL_TEXT_PREVIEW_BYTE_LIMIT`, followed by EOF, is also not truncated.
- Initial mode with one chunk at exactly the limit followed by another byte returns `truncated: true`, `truncatedBy: "bytes"`, and cancels.
- Existing oversized-chunk and line-cap tests should continue to pass.

## Summary

This is a boundary-condition bug introduced by the byte-truncation metadata fix. The initial preview should distinguish "filled the budget exactly and hit EOF" from "filled the budget and more data exists."
