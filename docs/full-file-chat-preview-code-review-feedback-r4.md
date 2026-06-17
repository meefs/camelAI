# Full File Chat Preview Code Review Feedback R4

Scope: review of the two new low-severity bugs reported during code review. Both findings are valid.

## Findings

### 1. Byte-truncated previews are reported as line-truncated

Severity: Low

The previous byte-cap fix now slices oversized initial chunks before decoding past `INITIAL_TEXT_PREVIEW_BYTE_LIMIT`, but the API response still only exposes line-oriented metadata:

- `src/routes/api/text-preview-stream.ts:143`
- `src/routes/api/text-preview-stream.ts:165`
- `src/routes/api/text-preview-stream.ts:181`
- `src/routes/api/text-preview-stream.ts:185`
- `src/components/chat-file-preview/preview-truncation-footer.tsx:38`

When initial mode stops because of the byte cap, `totalLines` is `null` and `maxLines` is still `1000`, so the footer renders `Showing first 1,000 lines.` A file with one very long line over 1 MB will actually show a partial first line, making that message incorrect.

Recommended fix:

- Track why initial preview truncation happened in `readTextPreviewFromStream()`.
- Extend `TextPreviewResponse` with one of these shapes:
  - `truncatedBy?: "lines" | "bytes"`
  - or `shownLines` plus `truncatedBy`
- Set `truncatedBy = "lines"` when the newline cap wins.
- Set `truncatedBy = "bytes"` when `INITIAL_TEXT_PREVIEW_BYTE_LIMIT` wins.
- Thread that field through `FilePreviewContent` / `PreviewLineInfo` into `PreviewTruncationFooter`.
- For byte truncation, render byte-oriented copy, for example `Showing first 1 MB of this file.` Avoid saying `1,000 lines` when the displayed preview may contain only a partial line.

Tests to add:

- `readTextPreviewFromStream()` returns `truncatedBy: "bytes"` for a single long line over `INITIAL_TEXT_PREVIEW_BYTE_LIMIT`.
- `readTextPreviewFromStream()` returns `truncatedBy: "lines"` when `maxLines` is reached first.
- `PreviewTruncationFooter` renders byte-oriented text for byte truncation.
- Existing line-truncation footer tests should continue to assert the `1,000 lines` copy.

### 2. Escaping workspace and VM paths return 500 instead of 400

Severity: Low

`normalizeWorkspacePath()` throws when a path escapes the workspace root. The new text preview route calls it directly for workspace and VM sources:

- `src/routes/api/workspace-file-preview-text.server.ts:140`
- `src/routes/api/workspace-file-preview-text.server.ts:173`

Those errors are not converted to a `Response`, so the route loader falls through to the generic `500` branch:

- `src/routes/api/workspaces.$id.file-preview.text.ts:25`
- `src/routes/api/workspaces.$id.file-preview.text.ts:38`
- `src/routes/api/workspaces.$id.file-preview.text.ts:39`

That means a request such as `source=workspace&path=/../etc/passwd` is correctly blocked, but it is reported as `Failed to serve text file preview` instead of a client input error. R2 already has explicit invalid-path handling, so workspace and VM should match that behavior.

Recommended fix:

- Add a small helper in `workspace-file-preview-text.server.ts`, for example:

```ts
function normalizePreviewWorkspacePath(rawPath: string): string {
  try {
    return normalizeWorkspacePath(rawPath);
  } catch {
    throw Response.json({ error: "Invalid file path" }, { status: 400 });
  }
}
```

- Use that helper for both workspace and VM source paths before reading.
- Keep valid internal normalization working, e.g. `/app/../notes.txt` should still resolve within the workspace if `normalizeWorkspacePath()` currently allows it.
- Do not weaken the existing R2 `validateR2Path()` behavior.

Tests to add:

- `source=workspace&path=/../etc/passwd` returns `400` with `{ error: "Invalid file path" }` and does not call `readFileStream`.
- `source=vm&project=app&path=/../etc/passwd` returns `400` and does not call the VM bridge.
- A valid normalized path containing an internal `..` segment, such as `/app/../notes.txt`, still works if that behavior is expected for workspace/VM paths.

## Summary

Both issues are low severity but worth fixing before merge. The first is user-facing copy accuracy for byte-capped previews; the second avoids noisy 500s for invalid path input and keeps the new endpoint aligned with its R2 validation path.
