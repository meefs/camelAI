# Attachment Card Hover Preview — Round-2 Feedback

**Date:** 2026-07-08
**Applies to:** the working-tree implementation of `docs/group-attachment-hover-preview-plan.md` (files `src/components/welcome-screen/attachment-card.tsx`, `attachment-hover-preview.tsx`, wiring in `recently-used-in-group.tsx` / `welcome-screen/index.tsx` / `Chat.tsx`).
**Verdict:** the implementation matches the plan — architecture, data flow, fetch mechanics, and wiring are all right and stay as they are. Everything below is design revision from user review (R1–R5) plus one small correctness item (F1). No plan-level rework.

---

## R1 — Remove the separator borders; separate sections by background tint only

The hover currently draws `border-t` / `border-y border-border` lines between header, body, and footer. Remove all of them — the transcript hover on this same screen separates its bands with background tint alone (`bg-muted/50` assistant band, no rules), and the attachment hover should read the same way. The tinted body slot doubles as the "this area is its own region (and may scroll)" affordance.

Exact class changes in `attachment-hover-preview.tsx` (body slot tint is `bg-muted/30` everywhere — already the value used by image/text; add it where missing, delete every `border-t`/`border-y border-border`):

| Component | Current | New |
|---|---|---|
| `LoadingBody` wrapper | `space-y-2 border-t border-border px-3 py-3` | `space-y-2 bg-muted/30 px-3 py-3` |
| `ImageBody` wrapper | `relative border-y border-border bg-muted/30` | `relative bg-muted/30` |
| `TableBody` wrapper | `border-t border-border` | *(no classes)* |
| `MarkdownBody` wrapper | `max-h-[280px] overflow-y-auto border-t border-border px-3 py-2.5` | `max-h-[280px] overflow-y-auto bg-muted/30 px-3 py-2.5` |
| `TextBody` wrapper | `border-t border-border bg-muted/30` | `bg-muted/30` |
| Footer row | `flex items-center gap-1 border-t border-border px-3 py-2 …` | `flex items-center gap-1 px-3 py-2 …` |

Keep the table's **row** dividers (`border-b border-border/50`) and header-row tint (`bg-muted/50`) — those are the table's own grid, not section separators.

> This is a try-it decision and may be reverted; that's why the change is confined to these class strings — don't restructure anything around it. (If we later want to match the transcript bands exactly, the only knob is `bg-muted/30` → `bg-muted/50`.)

## R2 — Metadata variant: kill the big icon body

Confirmed against the xlsx screenshot: the icon band is dead space that tells the user nothing. The metadata hover becomes **header + footer only** — full filename, type/size, source chat, recency. That is everything we actually know about a pdf/xlsx/zip; don't decorate the absence of a preview.

```text
BEFORE                                    AFTER
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ robins_spreadsheet.xlsx      │          │ robins_spreadsheet.xlsx      │
│ XLSX                         │          │ XLSX                         │
├──────────────────────────────┤          │ ⌸ From “File Type Testing    │
│                              │          │   Results” · today           │
│              ▤               │          └──────────────────────────────┘
│                              │
├──────────────────────────────┤
│ ⌸ From “File Type Testing…”  │
└──────────────────────────────┘
```

Rewrite `MetadataBody` to render only an optional message line (used by error states and the empty-csv case), no icon, no tinted band:

```tsx
function MetadataBody({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="px-3 pb-2.5 text-xs text-muted-foreground">{message}</p>;
}
```

- Happy-path metadata (`kind === 'metadata'`, no error): body renders `null` → header sits directly above footer. That compactness is intended; it now reads like the connection/project hover cards.
- Error states (any kind) keep their visible message — `This file is no longer available.` / `No preview for this file type.` / `Preview unavailable.` — as this quiet text line. Never an empty silent card.
- The `TableBody` empty-file fallback passes `message="Empty file."` and drops its `displayName`/`contentType` args.
- Remove the now-unused `getFileIcon` / `getFileCategory` imports from `attachment-hover-preview.tsx` if nothing else uses them.

## R3 — Resting card: swap the category icon to a Plus on hover

The transcript cards flip their corner `MessageSquare` to a `Plus` on hover (`transcript-card.tsx:57-60`) to say "click = add". Attachment cards must make the same promise. `FileCard` is shared with the prompt-input attachment row (where click ≠ add), so the swap is **opt-in via a new prop**, default off:

```tsx
// src/components/file-card.tsx
interface FileCardProps {
  /* …existing… */
  /** Swap the category icon for a Plus on hover (cards that add on click). */
  showAddOnHover?: boolean;
}

// in the top zone, replacing the current icon branch:
{isError ? (
  <AlertCircle className="h-3.5 w-3.5 text-destructive" />
) : showAddOnHover ? (
  <span aria-hidden className="text-muted-foreground">
    <Icon className="h-3.5 w-3.5 group-hover/card:hidden" />
    <Plus className="hidden h-3.5 w-3.5 group-hover/card:block" />
  </span>
) : (
  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
)}
```

(`group/card` already exists on the FileCard wrapper; add the `Plus` import.) `RecentAttachmentCard` passes `showAddOnHover` on its `FileCard`; the prompt-input usages pass nothing and are pixel-identical to today.

## R4 — Image attachments: render the thumbnail on the resting card

Requested and **possible**: the prompt-input row shows image tiles from local blob URLs created at upload time; here the equivalent is the R2-backed route the hover already uses (`/api/workspaces/:id/uploads/<stored-name>`, served inline, `max-age=3600`). The source chat already rendered these exact images inline, so loading them here adds no new exposure class; there are at most 8 cards.

In `RecentAttachmentCard`, when `kind === 'image'` and `imageUrl` is set and the thumb hasn't errored, render an `ImageTile` instead of `FileCard` (same 88×88 footprint, mirroring the prompt-input tile at `attachment-list.tsx:136-153`, but with a Plus affordance instead of a remove X):

```text
   ┌─────────┐     ┌─────────┐
   │ PNG  🖼 │     │▒▒▒▒▒▒(+)│   ← the image itself, object-cover;
   │ hero-m… │ →   │▒ IMAGE ▒│     Plus chip fades in top-right on hover
   │ 1.2 MB  │     │▒▒▒▒▒▒▒▒▒│
   └─────────┘     └─────────┘
     (before)        (after)
```

```tsx
function ImageTile({ imageUrl, displayName, onClick, onError }: {
  imageUrl: string;
  displayName: string;
  onClick: () => void;
  onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Add ${displayName} to chat`}
      className="group/thumb relative h-[88px] w-[88px] cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/30 transition-all duration-200 ease-out hover:border-ring hover:shadow-md"
    >
      {!loaded ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <img
        src={imageUrl}
        alt=""
        className={cn(
          'h-full w-full object-cover transition-opacity duration-150',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
      <span
        aria-hidden
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100"
      >
        <Plus className="h-3 w-3 text-foreground" />
      </span>
    </button>
  );
}
```

Wiring rules:

- Parent holds `const [thumbFailed, setThumbFailed] = useState(false)`; `onError={() => setThumbFailed(true)}` falls back to the `FileCard` branch (icon card with `showAddOnHover`) — a 404'd upload must not leave a broken tile.
- The tile stays inside the same `HoverCardTrigger asChild` → `<div className="w-fit">` wrapper; the hover preview (larger `object-contain` image + name + source + recency) **stays** — the 88 px `object-cover` crop makes the hover still worth opening.
- `alt=""` because the button's `aria-label` already names it (no double announcement).
- The thumbnails load on section render (not on hover) — that is the point of the request; the browser cache and 88 px rendering keep it cheap.

## R5 — Text preview: wrap instead of clipping

Verified against a JSON test file: long lines currently clip at the right edge (`whitespace-pre overflow-x-hidden`) with no way to see the rest. Decision: **wrap, don't horizontally scroll** — two-axis scrolling inside a transient hover is hostile, and wrapped text keeps every fetched character visible for recall. In `TextBody`:

- `<pre>` classes: replace `overflow-x-hidden whitespace-pre` with `whitespace-pre-wrap break-words` (keep `max-h-[280px] overflow-y-auto`, mono sizing, padding).
- **Add a client render cap.** The initial-mode endpoint caps by *lines and bytes*, and `INITIAL_TEXT_PREVIEW_BYTE_LIMIT` is 1 MB (`src/lib/file-preview-limits.ts:3`) — a minified single-line JSON can legally return ~1 MB of text, which must not be dumped into a wrapped `<pre>`. Cap what the hover renders:

```tsx
const HOVER_TEXT_RENDER_MAX_CHARS = 4_000;
const shownText = text.slice(0, HOVER_TEXT_RENDER_MAX_CHARS);
const clipped = truncated || text.length > HOVER_TEXT_RENDER_MAX_CHARS;
```

- Footnote copy generalizes (it can now be truncated by lines, bytes, or the char cap): replace `First 24 lines` with **`Preview truncated`**, shown when `clipped`.

Markdown and table bodies are unaffected (markdown already wraps; table cells keep `truncate` — a grid is the one place per-cell clipping is correct).

---

## F1 — Table footnote fires on exactly-8-row files

`TableBody` shows "First 8 rows" whenever `shape.body.length === 8`, including a csv with exactly 8 data rows where nothing was clipped. Expose the available row count from `shapeDelimitedPreview` and gate on actual clipping:

```ts
export interface DelimitedPreviewShape {
  header: string[];
  body: string[][];
  totalRows: number;   // data rows available in the fetched text (safeRows.length - 1, min 0)
  totalCols: number;
  cols: number;
}

const showFootnote = truncated || shape.totalRows > shape.body.length || clippedColumns > 0;
```

---

## Tests to update alongside (same files, agent-actionable)

- `tests/attachment-hover-preview.test.tsx`:
  - Text-body assertion `First 24 lines` → `Preview truncated`; add a case where a single line longer than 4,000 chars renders at most 4,000 chars plus the footnote.
  - Table: add an exactly-8-data-rows / no-truncation case asserting **no** footnote (F1).
  - Metadata: assert the happy path renders no element between header and footer (no icon); error case unchanged in spirit (message line still present).
  - `shapeDelimitedPreview`: assert the new `totalRows`.
- Add to the same file (or `tests/attachment-card.test.tsx`): `RecentAttachmentCard` with a `.png` card + `workspaceId` renders a button `Add <name> to chat` with an `img` whose `src` contains `/uploads/`; after firing the img `error` event it falls back to the `FileCard` rendering.
- Run: `bun run test:run -- tests/attachment-hover-preview.test.tsx tests/recently-used-in-group.test.tsx`, then `bun run typecheck`.

## Unchanged on purpose

Fetch-once-per-mount, endpoint choices, `maxLines` values (12/24 — the char cap is a render cap, not a fetch change), kind mapping, HoverCard delays/positioning, header layout, footer content, error copy, and all wiring. `FileCard`'s only change is the additive `showAddOnHover` prop (R3).
