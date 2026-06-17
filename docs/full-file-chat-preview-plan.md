# Full File Chat Preview Plan

## Goal

Allow users to keep the chat preview panel fast on initial load while still being able to view an entire text-like file when they explicitly need it.

Today the chat preview panel caps text-like previews at 500 lines and shows copy like:

```text
Showing first 500 of XXX lines.
```

That is a good default interaction, but it is not enough because users sometimes need to inspect the full file in the preview panel without downloading it or leaving the chat context.

## Current Behavior

The cap is implemented client-side in `src/components/chat-file-preview/file-preview-content.tsx`:

- `MAX_TEXT_LINES = 500`
- `MAX_SPREADSHEET_LINES = 500`
- `fetch(previewUrl).text()` downloads and decodes the full response
- `truncateTextLines()` then slices the already-loaded text to 500 lines

`SourcePreview` in `src/components/chat-file-preview/code-preview.tsx` then renders the truncated source and shows the truncation message.

This means the current truncation helps only part of page load:

- It reduces React DOM size.
- It reduces Markdown rendering work.
- It reduces Shiki syntax highlighting work.
- It does not reduce the initial network download.
- It does not reduce browser text decoding.
- For durable workspace files, the current app-side `WorkspaceFileAdapter.readFileStream()` path in `src/routes/api/workspaces.utils.ts` buffers through `readFile()` before returning a response, so it is not a true streaming preview path.

## Recommended UX

Use a two-stage preview with a single, consistent footer affordance.

1. On open, load a small, server-limited preview (first 500 lines) immediately. Perceived load speed matches today.
2. When the server reports the file was truncated, render the **truncation footer** at the bottom of the preview content (inline, where the "Showing first 500…" note already sits). The footer shows status text on the left and the action on the right.
3. The full file is fetched and rendered only when the user clicks **Load full file**. The 500-line preview stays on screen during the load (no blank flash); the button shows a spinner.
4. Raw file URLs continue to back download, HTML iframe preview, image, PDF, audio, video, and binary paths — unchanged.

### Footer states

Known total lines:

```text
Showing first 500 of 12,430 lines                       [ ⌄ Load full file ]
```

Unknown total (the initial stream was cancelled early, so the exact count is not known):

```text
Showing first 500 lines                                 [ ⌄ Load full file ]
```

Loading the full file (preview stays visible, button disabled):

```text
Showing first 500 of 12,430 lines                       [ ⟳ Loading… ]
```

Full-file load failed (keep the 500-line preview):

```text
Showing first 500 of 12,430 lines   Couldn't load the full file.   [ Try again ]
```

After a successful full load, `truncated` becomes false and the footer disappears; the complete file is shown.

### Why a footer bar, and why at the bottom

Today the truncation note is whisper-quiet (`text-[11px] text-muted-foreground/50`) and — importantly — it is rendered **three different ways in three places with two different styles** (see Rendering Changes). Now that it carries an action it should read as an intentional **status bar**: subtle, but discoverable and tappable. A single shared component (`PreviewTruncationFooter`) replaces all three current notices so the treatment is identical everywhere.

Keep the footer at the natural place — the bottom of the content, exactly where the user hits the truncation boundary while scrolling. This mirrors the familiar "Load more" pattern, keeps the action adjacent to its status text, and needs no scroll-container refactor. (A discoverability fallback — surfacing the action in the toolbar — is listed under Follow-Up Options, not this pass.)

Do not introduce a separate modal, route, or always-on full load. The action lives where the truncation message already is, reusing existing primitives only: `Button`, `Loader2`, and (optionally) the `ChevronsDown` Lucide icon.

## Component: `PreviewTruncationFooter`

New file: `src/components/chat-file-preview/preview-truncation-footer.tsx`.

One presentational component, used in every truncation location (source preview, markdown preview, spreadsheet source). It does no fetching — it renders status plus the action and reports clicks upward. Centralizing it removes the current style drift and guarantees identical behavior everywhere.

Props:

```ts
interface PreviewTruncationFooterProps {
  shownLines: number;            // lines currently shown (equals maxLines when truncated)
  totalLines: number | null;     // null when the exact total is unknown
  canLoadFull: boolean;          // false → render status text only (graceful fallback)
  status: 'idle' | 'loading' | 'error';
  onLoadFull: () => void;
  sizeBytes?: number;            // optional; when known, shown on the button as a heads-up
  className?: string;
}
```

Markup (Tailwind, matching the existing toolbar density — the toolbar uses `border-b border-border px-3 py-1.5`, so this footer mirrors it with `border-t`):

```tsx
'use client';

import { ChevronsDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/tool-activity-tool-utils';
import { cn } from '@/lib/utils';

export function PreviewTruncationFooter({
  shownLines,
  totalLines,
  canLoadFull,
  status,
  onLoadFull,
  sizeBytes,
  className,
}: PreviewTruncationFooterProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-3 gap-y-1',
        'border-t border-border/60 bg-muted/30 px-3 py-2',
        className,
      )}
    >
      <p className="text-[11px] text-muted-foreground">
        {totalLines != null
          ? `Showing first ${shownLines.toLocaleString()} of ${totalLines.toLocaleString()} lines`
          : `Showing first ${shownLines.toLocaleString()} lines`}
      </p>

      {canLoadFull ? (
        <div className="flex items-center gap-2">
          {status === 'error' ? (
            <span className="text-[11px] text-destructive" aria-live="polite">
              Couldn&apos;t load the full file.
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadFull}
            disabled={status === 'loading'}
          >
            {status === 'loading' ? (
              <>
                <Loader2 className="animate-spin" />
                Loading…
              </>
            ) : status === 'error' ? (
              'Try again'
            ) : (
              <>
                <ChevronsDown />
                Load full file
                {sizeBytes != null ? ` · ${formatBytes(sizeBytes)}` : ''}
              </>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
```

Design notes:

- Use the existing `Button` primitive (`@/components/ui/button`). `variant="outline"` + `size="sm"` (h-6, text-xs) is present-but-light and matches the toolbar's notebook "Download" treatment. Icons inherit their size from the size variant, so no explicit size class is needed on `Loader2`/`ChevronsDown`.
- `formatBytes` already exists in `src/lib/tool-activity-tool-utils.ts` (`1.5 KB` / `2.3 MB` formatting) — reuse it. Showing size sets expectations before a large load and directly answers the user's "I understand why we truncate" concern; keep it optional (only when the server returns `size`).
- When `canLoadFull` is `false` (no full URL available — see Graceful Degradation), render only the status `<p>`. This reproduces today's read-only notice everywhere with one consistent style.
- Error text uses the repo's `text-destructive` token with `aria-live="polite"` so assistive tech announces failures. The real `<Button>` provides keyboard focus and the focus ring for free.
- No `Tooltip` is needed (the label is self-explanatory); drop the earlier plan's `Tooltip` mention to avoid an unused import.

## API Plan

Add a dedicated text-preview API route instead of overloading the raw file-serving URLs.

Route:

```text
GET /api/workspaces/:id/file-preview/text
```

Register it in `src/routes.ts` near the existing workspace file routes.

Query params:

```text
source=workspace|vm|upload|output
path=/path/to/file
project=<vm project name, only for source=vm>
maxLines=500
mode=initial|full
```

Response shape:

```ts
interface TextPreviewResponse {
  text: string;
  truncated: boolean;
  totalLines: number | null;
  maxLines: number;
  contentType?: string;
  size?: number;
}
```

Behavior:

- `mode=initial`: read only until `maxLines + 1` lines or a sane byte ceiling, then cancel the stream. Do not block first paint on an exact total line count.
- `mode=full`: return the complete text and exact line count.
- If the initial stream finishes naturally, return exact `totalLines`.
- If the initial stream is cancelled early, return `totalLines: null`.
- Reject binary-looking content with a clear JSON error and let the existing raw preview/download paths continue handling binary formats.

## Server Implementation

Create a small server helper, for example:

```text
src/routes/api/workspace-file-preview-text.server.ts
```

Responsibilities:

- Authenticate workspace access once with the existing workspace auth helpers.
- Resolve the requested source into a `ReadableStream<Uint8Array>`.
- Decode UTF-8 incrementally with `TextDecoder` in streaming mode.
- Count lines without loading the entire file in `mode=initial`.
- Preserve CRLF behavior and avoid dropping multibyte characters split across chunks.
- Cancel the reader when the preview limit is reached.

Source handling:

- `workspace`: use `WorkspaceFilesystemClient.readFileStream()` directly. Avoid `WorkspaceFileAdapter.readFileStream()` because it currently buffers through `readFile()`.
- `vm`: use `ProjectRuntimeServiceVmBridge.readFileStream()`.
- `upload`: resolve the workspace-scoped R2 key for `user-uploads/...` and stream `R2_BUCKET.get(key).body`.
- `output`: resolve the workspace-scoped R2 key for `user-outputs/...` and stream `R2_BUCKET.get(key).body`.

R2 supports range reads, but this first implementation can rely on stream cancellation. Range optimization can be added later if measurements show R2 egress or latency needs it.

Keep these existing raw routes unchanged:

- `src/routes/api/workspaces.$id.fs.content.$.ts`
- `src/routes/api/workspaces.$id.projects.$project.fs.content.$.ts`
- `src/routes/api/workspaces.$id.uploads.$.ts`
- `src/routes/api/workspaces.$id.outputs.$.ts`

Those routes are still needed for downloads, media, PDFs, images, and HTML iframe preview.

## Client State Plan

### Shared URL builder (avoid duplicating route logic)

The raw file route is currently built privately by `buildFilePreviewRoute()` inside `use-chat-preview-render-state.ts`. The text-preview URLs need the same `source` / `path` / `project` / `workspaceId` inputs, and they are needed by **more than one caller** (the panel render-state hook *and* the popover callers — see next section). Extract a small shared module so the logic exists once:

New file: `src/components/chat-file-preview/file-preview-urls.ts`

```ts
export const PREVIEW_INITIAL_MAX_LINES = 500; // single source of truth (replaces the local
                                              // MAX_TEXT_LINES / MAX_SPREADSHEET_LINES constants
                                              // and the server's default maxLines)

export interface FilePreviewUrlDescriptor {
  workspaceId: string;
  source: 'workspace' | 'vm' | 'upload' | 'output';
  path: string;
  project?: string;
}

// Mirrors today's buildFilePreviewRoute(): /fs/content/…, /projects/<p>/fs/content/…, /uploads/…, /outputs/…
export function buildRawFilePreviewRoute(d: FilePreviewUrlDescriptor): string;

// Returns the two text-preview endpoints for the same file.
export function buildTextPreviewUrls(
  d: FilePreviewUrlDescriptor,
  opts?: { refreshKey?: number; maxLines?: number },
): { initialUrl: string; fullUrl: string };
```

`buildTextPreviewUrls` produces:

```text
initialUrl: /api/workspaces/<id>/file-preview/text?source=…&path=…[&project=…]&mode=initial&maxLines=500&v=<refreshKey>
fullUrl:    /api/workspaces/<id>/file-preview/text?source=…&path=…[&project=…]&mode=full
```

Use `PREVIEW_INITIAL_MAX_LINES` for the default `maxLines` so the client display, the URL param, and the server default cannot drift. Have `use-chat-preview-render-state.ts` reuse `buildRawFilePreviewRoute` for its existing `filePreviewUrl` / `filePreviewOpenUrl` too (delete the local copy).

### Panel surface

Update `src/components/chat-preview/use-chat-preview-render-state.ts`. Keep the raw URL fields (`filePreviewUrl`, `filePreviewOpenUrl`) and add:

```ts
fileTextPreviewUrl      // buildTextPreviewUrls(...).initialUrl, with the tab's refresh key
fileFullTextPreviewUrl  // buildTextPreviewUrls(...).fullUrl
```

The initial URL carries the same `tabFilePreviewKeys[tabId]` refresh key already used for `filePreviewUrl`, so toolbar **Refresh** re-runs the initial fetch (and resets any loaded full view) for free. Add both fields to every branch of `TabRenderState` (set to `""` for `app` / `runtime_artifact` tabs, matching the existing empty-string pattern) in `chat-preview-shell.tsx`, and pass them into `FilePreviewContent`.

### Graceful degradation (keeps existing callers and tests working)

`FilePreviewContent`'s new text-URL props are **optional**:

- When `fileTextPreviewUrl` is provided → fetch the JSON text-preview route and enable the two-stage flow.
- When it is absent → fall back to today's behavior exactly (fetch the raw `previewUrl` as text, client-truncate via the existing `truncateTextLines`, render the footer with `canLoadFull={false}` so only the status text shows).

This means: no flag-day, every current consumer keeps working, and the existing `tests/code-preview.test.tsx` cases (which pass only `previewUrl`) stay green. New behavior is purely additive.

## Wiring Both Preview Surfaces (Panel + Popover)

`FilePreviewContent` has **two** consumers, not one. The original plan only covered the panel. Both must be wired or the feature will be visibly inconsistent (the panel would offer "Load full file" while the modal silently truncates).

1. **Panel** — `chat-preview-shell.tsx`, via `TabRenderState` from `use-chat-preview-render-state.ts`. Covered above. This is the primary surface and the one named in the request ("the chat preview panel"); treat it as P0.

2. **Dialog / popover** — `src/components/chat-file-preview/file-preview-popover.tsx` (`FilePreviewPopover`), used by `file-preview-chip.tsx` and `src/components/tool-call/file-link.tsx` whenever the inline chat panel is not available. Today it receives only a flat `previewUrl`. Extend it to also accept and forward the text URLs:

   ```ts
   export interface FilePreviewPopoverProps {
     open: boolean;
     onOpenChange: (open: boolean) => void;
     filename: string;
     previewUrl: string;
     contentType?: string;
     textPreviewUrl?: string;      // NEW (optional)
     fullTextPreviewUrl?: string;  // NEW (optional)
   }
   ```

   The popover already remounts `FilePreviewContent` on `previewUrl`/`refreshVersion` change; thread `textPreviewUrl`/`fullTextPreviewUrl` straight through (and fold `refreshVersion` into the key as today).

   The callers already hold structured file info, so they can build the URLs with `buildTextPreviewUrls`:
   - `file-link.tsx` — both popover branches already compute `workspaceId` + `source`/`type` + path; build the text URLs there and pass them in.
   - `file-preview-chip.tsx` — when it has a `previewTarget`, derive the descriptor from it; when it only has a flat `previewUrl` (no target), omit the props and let `FilePreviewContent` fall back to raw (graceful degradation).

If popover wiring must be split out to keep the first PR small, ship the panel first and fast-follow the popover — but keep the optional props and the graceful fallback in `FilePreviewContent` from day one so the modal never breaks.

## FilePreviewContent Changes

Update `src/components/chat-file-preview/file-preview-content.tsx` so text-like file types use `fileTextPreviewUrl` for the initial fetch and `fileFullTextPreviewUrl` for the user-triggered full fetch.

Use the text-preview route for:

- plain text
- code
- markdown
- JSON
- JSONL
- HTML source mode
- SVG source mode
- delimited spreadsheets (CSV / TSV) — the fetch is shared by both table and source mode; only source mode exposes `Load full file` (see Spreadsheet Details)

Keep using the raw `previewUrl` for:

- HTML iframe preview mode
- SVG image preview mode
- raster images
- PDFs
- audio
- video
- binary spreadsheets (xlsx/xls — parsed from the full ArrayBuffer, never text)
- notebooks for now

### Parsing the response

The initial fetch now hits the JSON text-preview route, so replace `response.text()` + `truncateTextLines()` with `response.json()` and trust the server's fields:

```ts
const data: TextPreviewResponse = await response.json();
setTextPreview(data.text);
setLineInfo({ truncated: data.truncated, totalLines: data.totalLines, maxLines: data.maxLines, sizeBytes: data.size });
```

`lineInfo` becomes `{ truncated: boolean; totalLines: number | null; maxLines: number; sizeBytes?: number }` (note `totalLines` is now nullable). The raw-fallback branch (no `fileTextPreviewUrl`) keeps using `truncateTextLines`, which always yields a numeric `totalLines` and `canLoadFull = false`.

### Full-load state machine

- Add `fullLoadStatus: 'idle' | 'loading' | 'error'` and a `loadedFull: boolean` flag.
- `canLoadFull = Boolean(fileFullTextPreviewUrl) && lineInfo.truncated && !loadedFull`.
- **Reset** `fullLoadStatus → 'idle'`, `loadedFull → false` whenever the initial fetch effect re-runs (i.e. on change of `fileTextPreviewUrl`/`previewUrl`, `filename`, `contentType`, or `fileViewMode`). Tie the reset to the same `useEffect` that already refetches, so Refresh and tab switches naturally return to the 500-line view.
- `handleLoadFull()`:
  1. set `fullLoadStatus = 'loading'` (preview stays mounted — do **not** clear `textPreview`);
  2. `fetch(fileFullTextPreviewUrl)`, parse JSON;
  3. on success: `setTextPreview(data.text)`, `setLineInfo({ truncated: false, totalLines: data.totalLines, maxLines })`, `loadedFull = true`, `fullLoadStatus = 'idle'`. With `truncated:false` the footer unmounts and the full file renders (re-running JSON pretty-print / markdown render against the full text);
  4. on error: keep the existing `textPreview`, set `fullLoadStatus = 'error'`. Use a dedicated `AbortController` so an in-flight full load is cancelled if the user navigates away.
- Pass `onLoadFull={handleLoadFull}`, `loadFullStatus={fullLoadStatus}`, `canLoadFull`, and `sizeBytes` down to the renderers (see Rendering Changes).

## Rendering Changes

The "Showing first 500…" notice exists in **three** spots today, with **two** different styles — unify all of them on `PreviewTruncationFooter`:

1. `SourcePreview` in `code-preview.tsx` (`px-3 pb-3 text-[11px] text-muted-foreground/50`) — covers text, code, JSON/HTML/SVG/CSV/markdown **source** mode.
2. Markdown **preview** mode in `file-preview-content.tsx` (`mt-2 px-3 text-xs text-muted-foreground`).
3. Spreadsheet **preview** mode in `file-preview-content.tsx` (`mt-2 px-4 text-xs text-muted-foreground`).

### `SourcePreview` (`code-preview.tsx`)

- Change `totalLines` to `number | null` (the server may not know it). In the `lineNumberDigits` calc, fall back to `fallbackLines.length` when `totalLines` is null: `Math.max(totalLines ?? 0, fallbackLines.length, 1)`.
- Add optional props and forward them to the footer:

  ```ts
  onLoadFull?: () => void;
  loadFullStatus?: 'idle' | 'loading' | 'error';
  canLoadFull?: boolean;
  sizeBytes?: number;
  ```

- Replace the inline `{truncated && <p>…</p>}` block (lines ~136–140) with:

  ```tsx
  {truncated ? (
    <PreviewTruncationFooter
      shownLines={maxLines}
      totalLines={totalLines}
      canLoadFull={Boolean(canLoadFull && onLoadFull)}
      status={loadFullStatus ?? 'idle'}
      onLoadFull={() => onLoadFull?.()}
      sizeBytes={sizeBytes}
    />
  ) : null}
  ```

  Keep the footer **inside** `SourcePreview`'s root so it stays at the end of the source content in both `panel` and `dialog` layouts (source wraps — no horizontal scroll — so the bar spans full width). `CodePreview` forwards the new props unchanged (it already spreads through to `SourcePreview`).

### Markdown & spreadsheet preview modes (`file-preview-content.tsx`)

Replace the two ad-hoc `<p>` notices with `PreviewTruncationFooter` in the exact spot each notice sits today (for markdown, immediately after the markdown body; for spreadsheet preview, after the table), passing the same `onLoadFull` / `loadFullStatus` / `canLoadFull` / `sizeBytes` that `FilePreviewContent` already holds. No layout restructure is needed — this is a one-for-one swap of the `<p>` for the shared footer.

### Result

Every truncated text-like preview — source mode, markdown preview, CSV source — shows the identical footer and the identical "Load full file" action. While loading, the button shows the spinner and is disabled; on failure the 500-line preview stays put with an inline "Couldn't load the full file." + "Try again"; on success the footer disappears and the full file renders.

## Large Full File Safety

Full-file viewing should not mean full syntax highlighting for arbitrarily large files.

Add a highlighting threshold inside `SourcePreview`, for example:

```ts
const HIGHLIGHT_MAX_LINES = 5_000;
const HIGHLIGHT_MAX_CHARS = 1_000_000;
```

If the full loaded content exceeds either threshold:

- skip Shiki
- render the plain fallback line-numbered source
- keep copy support
- keep wrapping behavior

This gives users access to the full file without making the preview panel freeze on very large source files.

UI heads-up: when the server returns `size`, show it on the button (`Load full file · 2.3 MB`) so the user can decide before triggering a heavy render. This is the lightweight way to honor the user's "I understand why we truncate" intent — it keeps the fast default while making the cost of the full view visible. (Full-source virtualization for very large files stays in Follow-Up Options; the Shiki bypass above is enough to keep this pass responsive.)

## JSON And Markdown Details

JSON and JSONL preview mode currently pretty-print after reading the full raw file. With an initial truncated response, do not try to pretty-print partial JSON.

Recommended behavior:

- Initial truncated JSON/JSONL: show raw source with `Load full file`.
- Full JSON/JSONL: pretty-print as today.
- Invalid full JSON/JSONL: preserve the existing fallback message and raw source behavior.

Markdown preview mode can render the first 500 lines initially, then full Markdown after click. If full Markdown is extremely large, consider falling back to full source rendering in a follow-up, but do not block this feature on that refinement.

## Spreadsheet Details

For CSV/TSV:

- **Source mode** gets the full treatment: it renders through `SourcePreview`, so it picks up the `PreviewTruncationFooter` with a working `Load full file` (`canLoadFull = true`). This already guarantees full viewing of the file.
- **Table preview mode** keeps its current row cap for performance. Render `PreviewTruncationFooter` there too (replacing the ad-hoc `<p>`), but with `canLoadFull = false` so it shows only the status text — no button. Re-word it slightly to point at the alternative, e.g. add a trailing hint "Switch to source or download for all rows." Loading the full table would mean parsing the entire CSV into the grid; defer that to the follow-up below.
- Follow-up: if adding full table preview, only parse the full CSV/TSV under a safe row/byte threshold, then flip `canLoadFull = true` for the table.

For binary spreadsheets:

- Do not change behavior in this plan.
- Existing spreadsheet parsing is already a separate path and should not be routed through the text-preview endpoint.

## Design System & Components

Reuse existing primitives only — do not introduce new component dependencies. When building, activate the `shadcn-components` skill per `AGENTS.md`, but everything below already exists in-repo:

| Need | Use | Location |
| --- | --- | --- |
| Action button | `Button` `variant="outline"` `size="sm"` | `@/components/ui/button` |
| Spinner | `Loader2 className="animate-spin"` | `lucide-react` (repo's standard spinner) |
| "Expand/more" icon | `ChevronsDown` (optional) | `lucide-react` |
| Byte formatting | `formatBytes` | `@/lib/tool-activity-tool-utils` |
| Class composition | `cn` | `@/lib/utils` |

Tokens / classes (match the surrounding preview chrome):

- Footer container mirrors the toolbar (`border-b border-border px-3 py-1.5`) with `border-t border-border/60 bg-muted/30 px-3 py-2`.
- Status text: `text-[11px] text-muted-foreground`. Error text: `text-[11px] text-destructive`.
- `flex flex-wrap items-center justify-between gap-x-3 gap-y-1` so the status wraps above the button on narrow/mobile widths (the panel is full-width under `MobileViewSwitcher`).
- Do **not** hardcode hex colors; use `muted`, `muted-foreground`, `border`, `destructive` tokens (consistent with light/dark theming used across the preview panel).

What this intentionally avoids: no `Dialog`/modal, no new route, no `Collapsible` (the full view is a fetch-and-replace, not a show/hide of pre-rendered DOM), no `Tooltip` on the footer button (label is self-explanatory).

## Testing Plan

### Component tests — `tests/code-preview.test.tsx`

Important: existing cases pass only `previewUrl` and mock `fetch().text()`. Those exercise the **graceful-fallback** path and must stay green — do not change them. Add **new** cases that pass `fileTextPreviewUrl`/`fileFullTextPreviewUrl` and mock `fetch().json()` returning `TextPreviewResponse`:

- Initial fetch hits the `file-preview/text?...&mode=initial` URL (not the raw URL) when text URLs are provided.
- Truncated response renders `PreviewTruncationFooter` with a `Load full file` button.
- Non-truncated response renders no footer.
- Clicking `Load full file` fetches the `mode=full` URL; while pending the button is disabled and shows the spinner (`Loading…`).
- On success, full text replaces initial text and the footer is removed.
- On failure, the 500-line preview stays visible and `Couldn't load the full file.` + `Try again` appear; clicking `Try again` refetches.
- `totalLines: null` renders `Showing first 500 lines` (no "of X").
- `canLoadFull={false}` (no full URL) renders status text only — no button (fallback parity).
- JSON/JSONL: a truncated initial response is shown as raw source (no partial pretty-print); the full response pretty-prints.
- Shiki is skipped when full content exceeds `HIGHLIGHT_MAX_LINES`/`HIGHLIGHT_MAX_CHARS`.
- Reset: changing `fileTextPreviewUrl` (e.g. Refresh) after a full load returns to the truncated 500-line view.

### Shared-footer tests

A focused render test for `PreviewTruncationFooter` covering each `status` and the `totalLines` null/number and `canLoadFull` true/false branches (cheap, and locks the unified copy/markup).

### Server helper tests

Add route/helper tests for the text-preview server helper:

- 499 lines returns `truncated: false`.
- 500 lines returns `truncated: false`.
- 501 lines returns `truncated: true`.
- CRLF input counts lines correctly.
- A file without trailing newline counts correctly.
- Multibyte characters split across chunks decode correctly.
- Initial mode cancels after enough content.
- Full mode returns all content.
- Missing file returns 404.
- Unauthorized workspace access returns the existing auth error shape.

### Don't forget

- `tests/file-preview-popover.test.tsx` — add a case that the popover forwards `textPreviewUrl`/`fullTextPreviewUrl` into `FilePreviewContent` (and still renders when they are omitted).

Run:

```bash
bun run typecheck
bun run test:run -- tests/code-preview.test.tsx tests/spreadsheet-preview-render.test.tsx tests/file-preview-popover.test.tsx
```

If the route helper has worker-specific bindings or Cloudflare stream behavior, also add the focused worker test command that matches the new test file.

## Non-Goals

- Do not remove the initial 500-line cap.
- Do not load full files automatically.
- Do not route binary media through the text-preview endpoint.
- Do not replace the existing raw file download URLs.
- Do not introduce a virtualized full-file editor in this pass.
- Do not pin the footer outside the scroll container — keep it inline at the end of content; no scroll-layout refactor this pass.
- Do not add full-table loading for spreadsheet preview mode (source mode + download already cover "see everything").

## Follow-Up Options

After the basic two-stage path ships, consider:

- Add a measured R2 range-read optimization for initial previews.
- Add exact total line counts as a background metadata request (turns "Showing first 500 lines" into "…of N lines" without a full load).
- Add virtualization for very large full-source files.
- Add full table preview for CSV/TSV under a safe row/byte threshold (flip `canLoadFull = true` for the table).
- Add a `Show first / Show full` toggle in the preview toolbar if usage shows the footer action is not discoverable enough (would require lifting truncation state up to the toolbar, like `onNotebookStateChange` does today).
