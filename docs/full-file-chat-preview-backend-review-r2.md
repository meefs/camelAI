# Full File Chat Preview Backend Review R2

Scope: backend/API and server-side behavior only. UI, copy, layout, and visual polish are intentionally left out for the Design/UI agent.

## Summary

No blocking backend findings in the current patch.

The previously requested backend items are now addressed:

- Initial preview limit moved to `PREVIEW_INITIAL_MAX_LINES = 1000` in `src/lib/file-preview-limits.ts`.
- Server defaults now come from `src/lib/file-preview-limits.ts`, not a component module.
- `mode` is validated strictly and invalid values return `400`.
- Full-file JSON preview is guarded by `FULL_TEXT_PREVIEW_BYTE_LIMIT`.
- Oversized full previews map to `413` with `code: "FULL_PREVIEW_TOO_LARGE"`.
- Route/helper tests now cover workspace, VM, upload/output R2 key construction, invalid input, binary files, missing files, and oversized full previews.

## Verification

Commands run:

```bash
bun run test:run -- tests/workspace-file-preview-text-server.test.ts
bun run typecheck
```

Results:

- `tests/workspace-file-preview-text-server.test.ts`: 15 passed.
- `bun run typecheck`: passed. It emitted existing Vite/Wrangler config warnings only.

## Non-Blocking Backend Suggestions

### 1. Consider failing oversized full previews before reading when size is known

Severity: Low

`readTextPreviewFromStream()` enforces the full-preview limit while reading:

- `src/routes/api/text-preview-stream.ts:128`
- `src/routes/api/text-preview-stream.ts:129`

That is correct and prevents the full file from being accumulated, but the route often knows `size` before reading:

- workspace stream result size
- VM `content-length`
- R2 object size

For known sizes above `FULL_TEXT_PREVIEW_BYTE_LIMIT`, the route could reject before opening/reading the body. This would reduce wasted read work for obviously oversized files.

Suggested shape:

```ts
if (mode === 'full' && stream.size && stream.size > FULL_TEXT_PREVIEW_BYTE_LIMIT) {
  await stream.stream.cancel().catch(() => {});
  throw new FullTextPreviewTooLargeError();
}
```

Keep the current streaming guard even if this preflight is added, because some sources may not report a trustworthy size.

### 2. Add one auth propagation test if this route becomes security-sensitive

Severity: Low

The route uses `requireWorkspaceAccess()` in `resolvePreviewStream()`, so the implementation follows the existing auth pattern:

- `src/routes/api/workspace-file-preview-text.server.ts:134`

The current tests mock successful access and exercise source behavior well. If this endpoint is touched again, add one small test where `requireWorkspaceAccessMock` rejects with a `Response` and assert the loader preserves that status. This is not required before shipping given the shared helper is already used consistently elsewhere.

### 3. Clean up stale planning docs before final commit

Severity: Low

There are older draft review/plan docs in the working tree that still mention the previous 500-line limit and earlier backend concerns that are now fixed. That does not affect runtime behavior, but it can confuse future agents reviewing `/docs`.

Before merging, either update or remove superseded draft notes so the durable docs do not contradict the implemented `1000` line default.

## Backend Conclusion

From the backend side, the implementation is ready to proceed after the owning agent decides whether to take the optional preflight-size optimization. The current guard still enforces the limit correctly, and the route-level coverage is now meaningfully stronger than the previous revision.

---

# UI Review (R2)

Scope: UI/UX, layout, and visual affordances. Backend/API findings are above and are not repeated.

## Prior-round items: all landed correctly

I re-audited the previous UI feedback and confirm it was implemented:

- **UI-1 (footer redesign):** `preview-truncation-footer.tsx` is now bottom-left, a low-key underlined **"Show all lines"** text link (no border/fill), with the trailing period and a keyboard focus ring. ✓
- **UI-2 (tests):** label and trailing-period assertions updated in `tests/preview-truncation-footer.test.tsx` and `tests/code-preview.test.tsx`. ✓
- **UI-4 (markdown nested scroll):** markdown preview mode is now a flex column (`file-preview-content.tsx:899–921`) so the footer is reachable. ✓
- **UI-6 (1000-line bump):** the footer auto-renders "Showing first 1,000 lines" from `PREVIEW_INITIAL_MAX_LINES = 1000` in `src/lib/file-preview-limits.ts`; no footer change was needed. ✓

All UI tests pass:

```bash
bun run test:run -- tests/code-preview.test.tsx tests/preview-truncation-footer.test.tsx tests/file-preview-popover.test.tsx tests/chat-preview-shell.test.tsx
# Test Files  4 passed (4)   Tests  32 passed (32)
```

## UI-R2-1. The new "too large" (413) response is shown as a generic, retryable error

Severity: Medium

This round added a real `413` path on the server (`workspaces.$id.file-preview.text.ts:32–36`) returning `{ error, code: "FULL_PREVIEW_TOO_LARGE" }` for full previews over `FULL_TEXT_PREVIEW_BYTE_LIMIT` (5 MB). The client does not distinguish it. `handleLoadFull` treats every non-OK response the same way (`file-preview-content.tsx:494–495, 530–532`):

```ts
if (!response.ok) {
  throw new Error('Failed to load full preview');
}
...
} catch (error) {
  ...
  setFullLoadStatus('error');
}
```

Result: clicking **Show all lines** on a >5 MB text file shows "Couldn't load the full file. **Try again**", and every retry deterministically 413s again — a dead end, with no pointer to the working remedy (Download, which exists in the toolbar and the popover header). This is the one user-facing gap I'd fix before shipping, because the 413 path is brand new and currently lands the user in a futile loop.

Recommendation — make the oversized case distinct and non-retryable, and point to download:

1. Detect it in `handleLoadFull`:

   ```ts
   if (!response.ok) {
     const tooLarge = response.status === 413; // optionally confirm via body.code === 'FULL_PREVIEW_TOO_LARGE'
     throw Object.assign(new Error('Failed to load full preview'), { tooLarge });
   }
   ...
   } catch (error) {
     if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
     setFullLoadStatus((error as { tooLarge?: boolean })?.tooLarge ? 'unavailable' : 'error');
   }
   ```

2. Extend the footer `status` union to `'idle' | 'loading' | 'error' | 'unavailable'` and render a distinct, **non-retryable** branch — no "Try again":

   ```tsx
   ) : status === 'unavailable' ? (
     <span className="inline-flex items-center gap-1.5">
       <span className="text-muted-foreground">Too large to show in full.</span>
       {downloadUrl ? (
         <a href={downloadUrl} download className={linkClasses}>Download</a>
       ) : null}
     </span>
   ) : status === 'error' ? (
     // existing Try again branch
   ```

   Pass `downloadUrl={previewUrl}` (the raw file URL `FilePreviewContent` already has) into the footer so the link is real. If you'd rather not add a prop, a text-only pointer ("Too large to show in full — use Download above.") is an acceptable minimal version since the toolbar/popover already expose Download.

3. The same generic-error conflation also applies to a full-load `415` (binary detected on full read). It is far rarer, but if cheap, fold it into the same non-retryable "unavailable" treatment.

## UI-R2-2. Footer placement is now inconsistent: markdown preview pins it, everything else scrolls it

Severity: Low–Medium

The UI-4 fix made the markdown-preview footer a pinned `shrink-0` row at the bottom of the pane (always visible). Every other text-like preview renders the footer **inline at the end of the scrolled content** (it lives inside `SourcePreview`, so the user scrolls to the bottom of the code to reach "Show all lines"): text, code, JSON, HTML/SVG/CSV source, and the spreadsheet-preview hint. So markdown is the only type where the action is always on screen.

Both behaviors are functional; the issue is consistency and discoverability. Pick one:

- **Inline everywhere (simplest, recommended):** keep the footer inline and revert markdown preview to a single scroll container — let the markdown body flow inside the existing outer `h-full overflow-auto` (drop the inner nested scroll) with the footer inline after it. This both fixes the original UI-4 reachability problem *and* matches every other type. The footer then consistently "appears at the truncation boundary."
- **Pinned everywhere (more discoverable, larger change):** lift the footer out of `SourcePreview` and render it as a pinned `shrink-0` sibling under a `flex flex-col` / `flex-1 min-h-0 overflow-auto` body for each text-like branch. Heavier refactor touching several render paths.

If neither is taken now, note it as a deliberate, known difference so it isn't read as a bug later.

## UI-R2-3. Spreadsheet-preview footer keeps `mt-2`

Severity: Low

The spreadsheet-preview footer still passes `className="mt-2"` (`file-preview-content.tsx:879`), but the footer already has its own `border-t`. That produces a small gap above the divider line that the markdown footer (which dropped `mt-2`) does not have. Remove `mt-2` for visual consistency across footers.

## UI-R2-4. Add a client test for the oversized path (after UI-R2-1)

Severity: Low

Once UI-R2-1 lands, add a `tests/code-preview.test.tsx` case: full-load fetch resolves `{ ok: false, status: 413 }`, then assert the footer shows the non-retryable "Too large…" copy (and a Download affordance) and that no "Try again" button is present. This locks the new branch and prevents regressions back into the futile-retry behavior.

## UI-R2-5. Minor: duplicated highlight thresholds

Severity: Low (cleanup, optional)

`code-preview.tsx` defines local `HIGHLIGHT_MAX_LINES = 5_000` and `HIGHLIGHT_MAX_CHARS = 1_000_000`, which coincide with `MAX_TEXT_PREVIEW_LINES` and `INITIAL_TEXT_PREVIEW_BYTE_LIMIT` in `src/lib/file-preview-limits.ts`. They are conceptually distinct (client highlight cap vs. server line/byte caps), so sharing isn't required — but the matching magic numbers can drift. Either import shared constants or add a one-line comment noting they are intentionally independent.

## UI Verification Performed

```bash
bun run test:run -- tests/code-preview.test.tsx tests/preview-truncation-footer.test.tsx tests/file-preview-popover.test.tsx tests/chat-preview-shell.test.tsx
# 32 passed
```

## UI Summary (R2)

The prior UI feedback is fully implemented and the surface is in good shape. The only finding worth fixing before merge is **UI-R2-1**: the new 413 "too large" response currently surfaces as a generic, infinitely-retryable error with no route to Download — give it a distinct, non-retryable message that points to download. **UI-R2-2** (footer pin/inline consistency) and **UI-R2-3** (`mt-2`) are quick polish; **UI-R2-4/5** are follow-ups.
