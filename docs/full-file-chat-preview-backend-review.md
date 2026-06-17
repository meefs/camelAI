# Full File Chat Preview Backend Review

Scope: backend/API and server-side behavior only. UI treatment, layout, and visual affordances are intentionally left for the Design/UI review.

## Findings

### 1. Add a full-mode size guard before shipping

Severity: High

`readTextPreviewFromStream()` appends every decoded chunk into one string for `mode: "full"` and the route returns that string as JSON:

- `src/routes/api/text-preview-stream.ts:107`
- `src/routes/api/text-preview-stream.ts:123`
- `src/routes/api/workspaces.$id.file-preview.text.ts:17`

That means a user-triggered full preview of a very large workspace, VM, or R2 text file can make the Worker allocate the entire decoded file plus JSON serialization overhead. The existing raw file routes stream bytes; this new full-text route does not.

Recommendation:

- Add a `FULL_TEXT_BYTE_LIMIT` server-side guard, ideally from shared config.
- If `mode === "full"` exceeds the limit, cancel the reader and return `413` with a clear JSON error such as `{ error: "File is too large to preview in full", code: "FULL_PREVIEW_TOO_LARGE" }`.
- Keep the raw download/open URL as the escape hatch for files above the full-preview limit.
- Add tests for full mode just under and just over the limit.

If product truly requires "entire file" for arbitrarily large files, the full path should become a streaming text response or paged/ranged viewer rather than one JSON payload.

### 2. Requested initial limit change is not implemented yet

Severity: Medium

The initial preview cap is still 500 lines:

- `src/components/chat-file-preview/file-preview-urls.ts:3`

The user requested increasing the initial load to 1000 lines. This should be a one-line behavior change once the constant is moved to a better shared location:

```ts
export const PREVIEW_INITIAL_MAX_LINES = 1000;
```

Also update affected expectations in tests and docs, including:

- `tests/chat-preview-shell.test.tsx`
- `tests/preview-truncation-footer.test.tsx`
- `tests/workspace-file-preview-text-server.test.ts`
- any docs copied from the earlier 500-line plan

The existing `INITIAL_TEXT_BYTE_LIMIT = 1_000_000` can stay unless product wants to guarantee 1000 very long lines; in that case raise it deliberately and test the byte-limit behavior.

### 3. Server code imports a frontend component module

Severity: Medium

`src/routes/api/text-preview-stream.ts` imports `PREVIEW_INITIAL_MAX_LINES` from `@/components/chat-file-preview/file-preview-urls`:

- `src/routes/api/text-preview-stream.ts:1`

This currently typechecks, but it couples route/server code to a component-owned module. It makes future frontend edits to `file-preview-urls.ts` riskier because importing React/client-only code into that module later would break the server route bundle.

Recommendation:

- Move shared preview limits to a neutral module, for example `src/lib/file-preview-limits.ts`.
- Import that module from both `file-preview-urls.ts` and `text-preview-stream.ts`.
- Keep URL construction in the frontend/component area if desired, but keep server defaults out of component modules.

### 4. Add route-level backend tests

Severity: Medium

The new stream helper has useful unit coverage in `tests/workspace-file-preview-text-server.test.ts`, and that focused test passes. It does not cover `loadTextPreviewResponse()` or the route loader behavior where the riskiest backend integration lives:

- auth/access handling
- source validation
- workspace stream resolution
- VM `project` requirement
- R2 key construction for upload/output sources
- binary rejection surfaced as `415`
- missing files surfaced as `404`

Recommendation:

- Add tests around `loadTextPreviewResponse()` with mocked `getEnv`, `requireWorkspaceAccess`, `WorkspaceFilesystemClient`, `ProjectRuntimeServiceVmBridge`, and `R2_BUCKET`.
- Add at least one loader-level test for `BinaryTextPreviewError -> 415`.
- Include cases for `source=vm` without `project`, invalid `source`, missing `path`, and upload/output key construction.

### 5. Invalid `mode` values are silently treated as `initial`

Severity: Low

`normalizeMode()` currently maps anything except `"full"` to `"initial"`:

- `src/routes/api/workspace-file-preview-text.server.ts:50`
- `src/routes/api/workspace-file-preview-text.server.ts:225`

The public route contract is `mode=initial|full`, so invalid values should return `400` instead of silently doing something else.

Recommendation:

- Replace `normalizeMode()` with strict validation.
- Return `400` for unknown mode values.
- Add a route/helper test for `mode=bogus`.

## Verification Performed

Commands run:

```bash
bun run test:run -- tests/workspace-file-preview-text-server.test.ts
bun run typecheck
```

Both passed. `typecheck` only emitted existing Vite/Wrangler plugin warnings.

## Backend Summary

The architecture is directionally right: the initial text preview now uses a server-limited route instead of downloading the raw full file first. Before handoff, I would address the full-mode memory guard and move the shared line-limit constant out of `src/components`. The requested 1000-line initial load is straightforward but still pending in the current patch.

---

# UI Review

Scope: UI/UX, layout, component structure, and visual affordances. Backend/API findings are above and are not repeated here.

## Overall

The UI implementation faithfully follows the plan and is in good shape. The two-stage flow, the shared `PreviewTruncationFooter`, the `file-preview-urls.ts` URL builder, and the full-load state machine (loading / error / reset-on-refresh / abort) are all implemented as designed. Crucially, **both** consumers of `FilePreviewContent` are wired — the panel (via `use-chat-preview-render-state.ts` → `TabRenderState`) and the dialog (`FilePreviewPopover`, fed by `file-link.tsx` and `file-preview-chip.tsx`) — so the modal does not silently truncate. Graceful degradation is preserved (no text URLs → old raw-fetch path).

All UI tests pass:

```bash
bun run test:run -- tests/code-preview.test.tsx tests/preview-truncation-footer.test.tsx tests/file-preview-popover.test.tsx tests/chat-preview-shell.test.tsx
# Test Files  4 passed (4)   Tests  32 passed (32)
```

The findings below are the requested redesign plus polish; none are architectural.

## UI-1. [Requested] Move the action bottom-left and make it a low-key underlined text link

Severity: High (explicit product request)

Current footer (`src/components/chat-file-preview/preview-truncation-footer.tsx`): `justify-between` with the status text on the **left** and a bordered `Button variant="outline"` labelled **"Load full file"** (with a `ChevronsDown` icon) on the **right**.

Requested instead: a single, lower-key sentence aligned to the **bottom-left** —

```text
Showing first 500 lines. Show all lines
```

— where **"Show all lines"** is an underlined text button (no border, no fill), and the label changes from "Load full file" to "Show all lines".

Replace the component body with the following. It keeps `<button>` semantics (so the existing `getByRole('button', …)` queries and `aria-live` still work), left-aligns everything, drops the chevron and the bordered button, and folds in two small fixes noted separately below (punctuation before the spreadsheet `hint`, and a keyboard focus ring):

```tsx
'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/tool-activity-tool-utils';

export interface PreviewTruncationFooterProps {
  shownLines: number;
  totalLines: number | null;
  canLoadFull: boolean;
  status: 'idle' | 'loading' | 'error';
  onLoadFull: () => void;
  sizeBytes?: number;
  className?: string;
  hint?: string;
}

// Low-key underlined text link: muted by default, brightens on hover/focus.
const linkClasses =
  'cursor-pointer rounded-sm underline underline-offset-2 transition-colors hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ' +
  'disabled:cursor-default disabled:no-underline';

export function PreviewTruncationFooter({
  shownLines,
  totalLines,
  canLoadFull,
  status,
  onLoadFull,
  sizeBytes,
  className,
  hint,
}: PreviewTruncationFooterProps) {
  const statusText =
    totalLines != null
      ? `Showing first ${shownLines.toLocaleString()} of ${totalLines.toLocaleString()} lines`
      : `Showing first ${shownLines.toLocaleString()} lines`;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-1',
        'border-t border-border/60 px-3 py-2',
        'text-[11px] text-muted-foreground',
        className
      )}
    >
      <span>
        {statusText}.{hint ? ` ${hint}` : ''}
      </span>

      {canLoadFull ? (
        status === 'loading' ? (
          <button
            type="button"
            disabled
            className={cn(linkClasses, 'inline-flex items-center gap-1')}
          >
            <Loader2 className="size-3 animate-spin" />
            Loading all lines…
          </button>
        ) : status === 'error' ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-destructive" aria-live="polite">
              Couldn&apos;t load the full file.
            </span>
            <button type="button" onClick={onLoadFull} className={linkClasses}>
              Try again
            </button>
          </span>
        ) : (
          <button type="button" onClick={onLoadFull} className={linkClasses}>
            Show all lines{sizeBytes != null ? ` (${formatBytes(sizeBytes)})` : ''}
          </button>
        )
      ) : null}
    </div>
  );
}
```

Notes on the choices:

- **Bottom-left** is achieved by dropping `justify-between`; the status and the link now flow as one sentence (`gap-x-1.5`), wrapping the link to a second left-aligned line only on very narrow widths.
- **Lower-key**: the bordered `Button` becomes an inline underlined link in the same `text-[11px] text-muted-foreground` as the status; hover/focus brightens to `text-foreground`. I also dropped the `bg-muted/30` bar fill and kept only the `border-t` hairline so the footer recedes. If you want even more separation back, re-add `bg-muted/30` to the container — but the hairline alone reads as intended given the request.
- The **size** (`Show all lines (2.3 MB)`) is retained as a useful pre-load heads-up; if it feels noisy in the link, move it into the status sentence instead (`…lines · 2.3 MB.`). Optional.
- Remove the now-unused `Button` and `ChevronsDown` imports.

## UI-2. Test assertions to update for UI-1 (required follow-on)

Severity: Medium (tests fail without this)

Two edits are needed after UI-1:

**a) Renamed action.** "Load full file" is asserted in six places — swap each `/Load full file/` → `/Show all lines/`. The `/Loading/` and `Try again` assertions are unaffected (the redesign keeps those words and keeps them as buttons).

- `tests/preview-truncation-footer.test.tsx:20`
- `tests/code-preview.test.tsx:204, 222, 259, 260, 603`

The first footer test passes `sizeBytes={2048}`, so the accessible name becomes `Show all lines (2.0 KB)` — a `/Show all lines/` regex still matches.

**b) Trailing period on the status text.** UI-1 renders `{statusText}.`, so the status string now ends in a period. These exact-match `getByText(...)` calls (no period) will break — either append the period or make them non-exact (`{ exact: false }` / a regex):

- `tests/preview-truncation-footer.test.tsx:19` — `'Showing first 500 of 12,430 lines'`
- `tests/preview-truncation-footer.test.tsx:35` — `'Showing first 500 lines'`
- `tests/code-preview.test.tsx:201` — `'Showing first 2 lines'`

(The unrelated `notebook-table-display` truncation note is a different component and is not affected.)

## UI-3. Spreadsheet preview footer is missing a separator before the hint

Severity: Low (fixed by UI-1)

In spreadsheet preview mode (`file-preview-content.tsx:872`) the footer renders the `hint` glued to the status with no punctuation: `Showing first 500 of N lines Switch to source or download for all rows.`. The UI-1 markup adds the period (`{statusText}.{hint ? \` ${hint}\` : ''}`), producing `… lines. Switch to source or download for all rows.`. No change needed beyond adopting UI-1.

## UI-4. Markdown preview-mode footer sits behind a nested scroll

Severity: Low (polish)

In markdown **preview** mode the body is `h-full overflow-auto` nested inside another `h-full overflow-auto`, with the footer as a sibling after it (`file-preview-content.tsx:885–918`). Because the inner body is `h-full`, the interactive footer lands just past the fold and is only revealed via scroll-chaining at the very bottom — a slightly disconnected feel now that it carries the "Show all lines" action (it was a non-interactive `<p>` before, so this is pre-existing, not a regression).

Cleaner: make the ready+preview branch a flex column so the body scrolls and the footer stays pinned at the bottom of the pane:

```tsx
<div className={cn('flex min-h-0 flex-col', layout === 'panel' ? 'h-full' : 'max-h-[60vh]')}>
  <div className="min-h-0 flex-1 overflow-auto">
    <div className="px-6 py-6">
      <MarkdownRenderer content={textPreview} />
    </div>
  </div>
  {lineInfo.truncated && (
    <PreviewTruncationFooter
      shownLines={lineInfo.maxLines}
      totalLines={lineInfo.totalLines}
      canLoadFull={canLoadFull}
      status={fullLoadStatus}
      onLoadFull={handleLoadFull}
      sizeBytes={lineInfo.sizeBytes}
    />
  )}
</div>
```

(The outer wrapper's `overflow-auto` at line 886 becomes redundant for this branch; drop `mt-2` from the footer since the `border-t` already separates it.) Source mode and the dialog layout are unaffected — those use a single scroll container and are fine. Not blocking.

## UI-5. Minor: confirm keyboard focus on the inline link

Severity: Low (accessibility)

The bordered `Button` provided a focus ring for free; an inline `<button>` does not. The UI-1 `linkClasses` add `focus-visible:ring-2 focus-visible:ring-ring/40` to preserve keyboard discoverability — keep that when applying UI-1. (The surrounding inline `file-link` buttons omit this; adding it here is the small upgrade.)

## UI-6. Note: the 1000-line bump needs no UI change

Informational. The footer derives its number from the server response (`shownLines={lineInfo.maxLines}`, formatted with `toLocaleString()`), so raising `PREVIEW_INITIAL_MAX_LINES` to 1000 will render "Showing first 1,000 lines" automatically. Only the constant (and the test expectations that hard-code 500) need to change — no footer edits.

## UI Verification Performed

```bash
bun run test:run -- tests/code-preview.test.tsx tests/preview-truncation-footer.test.tsx tests/file-preview-popover.test.tsx tests/chat-preview-shell.test.tsx
```

Result before changes: 32 passed. After applying UI-1, re-run with the UI-2 label swaps; expect the same green.

## UI Summary

Solid, plan-faithful implementation with full panel + popover coverage and passing tests. The one product-required change is UI-1: relocate the action to the bottom-left and demote it from a bordered button to a low-key underlined "Show all lines" text link (with the small test updates in UI-2 — label rename plus the trailing-period match). UI-3/UI-5 are folded into the UI-1 snippet; UI-4 (markdown nested-scroll) is optional polish.
