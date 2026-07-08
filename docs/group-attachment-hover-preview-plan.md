# Attachment Card Hover Preview on the Group New-Chat Screen — Plan

**Date:** 2026-07-08
**Surface:** `/chat?group=<group-id>` — the new-chat screen inside a chat group (`src/routes/_app.chat._index.tsx` → `Chat` → `WelcomeScreen` → `RecentlyUsedInGroup`, `src/components/welcome-screen/recently-used-in-group.tsx`). Specifically the **Attachments** row of "Recently used in this group".
**Prior art:** `docs/group-new-chat-screen-plan.md` built this screen. Its transcript cards (`transcript-card.tsx` + `transcript-hover-preview.tsx`) and connection/project tags (`MentionTargetHoverCard`) already have hover previews. Attachments (`FileCard`) are the only card type without one — this plan adds it.
**Implementer:** Codex. The UI below is fully specified — layout, exact components, classes, and copy are decided; do not redesign them. Data-fetch mechanics are specified but adjust freely if an API detail differs in code.

---

## Objective

Hovering an attachment card answers "which file was this?" without opening anything. The preview is a **recall aid, not a file viewer** — the full viewer stays in the active-chat preview panel (`ChatPreviewProvider` / `FilePreviewContent`), which does not exist on this screen and must not be introduced here.

Every hover shows the same three-part frame; only the middle varies by file type:

```text
   RECENTLY USED IN THIS GROUP
   ────────────────────────────────────────────────────────────
   ATTACHMENTS

   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ PNG  🖼  │  │ CSV  ⊞  │  │ PY   ⌨  │  │ PDF  ▤  │      ← resting cards: existing FileCard,
   │         │  │         │  │         │  │         │        88×88, completely unchanged
   │ hero-m… │  │ users-… │  │ scrape… │  │ Q2-rep… │
   │ 1.2 MB  │  │ 14 KB   │  │ 4.1 KB  │  │ 2.3 MB  │
   └─────────┘  └────┬────┘  └─────────┘  └─────────┘
                     │  hover 200 ms (portal; side="bottom" align="start"; flips up near composer)
                     ▼
        ┌────────────────────────────────────────┐
        │ users-export-may.csv        CSV · 14 KB │   ① header — full original name (wraps) + type/size
        ├────────────────────────────────────────┤
        │ email         plan     seats   mrr     │   ② preview — varies by file type (table below)
        │ ada@ex.com    pro      4       $96     │
        │ lin@ex.com    starter  1       $12     │
        │ kai@ex.com    team     11      $264    │
        │ First 8 rows                           │
        ├────────────────────────────────────────┤
        │ From “Churn dashboard” · 3 days ago    │   ③ footer — source chat + recency (all variants)
        └────────────────────────────────────────┘
```

The footer is the universal memory anchor: even when the body can't render content (pdf, xlsx, zip), "the file from *Churn dashboard*, 3 days ago" plus the full filename is usually enough.

---

## Preview recommendation by file type

Types are detected with the existing `getPreviewType(filename, contentType)` from `src/components/chat-file-preview/file-type-utils.ts` — do not invent new extension lists. "Body" is section ② above; header ① and footer ③ appear on every variant.

| File type (extensions) | `getPreviewType` | Hover body (variant) | What the user sees | Why this and not more |
|---|---|---|---|---|
| Raster images — png, jpg, jpeg, gif, webp, bmp, ico, avif | `image` | **`image`** | The image itself, larger (up to 320×240, `object-contain`) | The obvious case; the raw upload URL is already served inline from R2 |
| SVG | `svg` | **`image`** | Rendered SVG via `<img>` | Browsers render SVG in `img`; source text would be useless for recall |
| CSV / TSV | `spreadsheet` (delimited) | **`table`** | Mini table: header row + first ≤8 data rows, ≤6 columns, "First N rows" note | A real grid triggers recall ("the one with the email column") far better than raw commas; parser already exists |
| XLSX / XLS | `spreadsheet` (binary) | **`metadata`** | Big spreadsheet icon | Binary parse needs the lazy `xlsx` module — too heavy for a hover; name + source chat carries recall |
| Markdown — md | `markdown` | **`markdown`** | Rendered markdown, first 24 lines, scrollable | `MarkdownRenderer` is already on this screen (transcript hover); headings/lists are the memory hook |
| Code — py, ts, tsx, js, jsx, rs, go, java, c, cpp, h, hpp, css, sh, sql, yaml, toml, xml, … | `code` | **`text`** | First 24 lines, monospace, plain (no syntax highlighting) | Shape of the code is enough to recognize it; Shiki highlighting is async + heavy for a 200 ms hover |
| Plain text — txt, log | `text` | **`text`** | First 24 lines, monospace | Same |
| JSON / JSONL | `json` / `jsonl` | **`text`** | First 24 lines, raw (no pretty-print) | Keys are visible either way; pretty-print needs the full document |
| HTML | `html` | **`text`** | First 24 lines of source | Never render user HTML in a hover (the dialog viewer uses a sandboxed iframe; a hover must not); `<title>`/tags are recognizable |
| PDF | `pdf` | **`metadata`** | Big file-text icon | First-page render needs pdf.js; an iframe PDF viewer inside a hover card is heavy and steals scroll |
| Notebook — ipynb | `notebook` | **`metadata`** | Big code-file icon | Raw content is JSON noise; the notebook renderer is a full subsystem |
| Audio — mp3, wav, ogg, flac, m4a, aac | `audio` | **`metadata`** | Big audio icon | No playback controls in a hover (pointer leaves → card closes mid-play) |
| Video — mp4, webm, mov, mkv, avi | `video` | **`metadata`** | Big video icon | Same; poster-frame extraction isn't worth the weight |
| Everything else — zip, heic/tiff (non-renderable images), binaries, unknown | `other` (or non-renderable `image`) | **`metadata`** | Big generic file icon | Nothing render-able; header + footer still answer "which file" |

So there are exactly **five body variants**: `image`, `table`, `markdown`, `text`, `metadata`. `metadata` is also the fallback for every failure (fetch error, binary 415, missing workspace id), so no file type can dead-end.

---

## What already exists (read before writing code)

- **The card**: `FileCard` (`src/components/file-card.tsx`) — 88×88 square, extension badge, category icon, truncated name, size. Rendered per attachment in `recently-used-in-group.tsx` (`attachmentCards.map(...)`). It stays visually unchanged; this plan only wraps it.
- **The data**: `GroupNewChatAttachmentCard` (`src/types.ts:100`) already carries everything the hover needs — `path` (`uploads/<stored-name>` mount path), `filename` (stored name, i.e. `path` without the `uploads/` prefix), `originalName`, `sourceThreadId`, `sourceTitle`, `lastUsedAt`, optional `contentType`/`size`. **No type or loader changes.** Note the extractor (`src/lib/group-new-chat-recent-items.ts`) does not populate `contentType`/`size` today — every render decision must tolerate them being `undefined` (extension-based detection already covers this).
- **Raw file bytes (images)**: `GET /api/workspaces/:id/uploads/<stored-name>` (`src/routes/api/workspaces.$id.uploads.$.ts`) — R2-backed, serves inline with correct content type and `Cache-Control: private, max-age=3600`. **Works without any live sandbox or active chat.** Exactly how in-chat `FilePreviewChip`s load images (`message-bubble.tsx:811`).
- **Text snippets**: `GET /api/workspaces/:id/file-preview/text?source=upload&path=<stored-name>&mode=initial&maxLines=N` — also pure R2 (`workspace-file-preview-text.server.ts`, `source === 'upload'` branch), returns `{ text, truncated, truncatedBy, totalLines, maxLines, contentType, size }`. Returns **415** for binary content, **404** if the object is gone. URL builder already exists: `buildTextPreviewUrls` in `src/components/chat-file-preview/file-preview-urls.ts`.
- **Hover mechanics**: `HoverCard`/`HoverCardTrigger`/`HoverCardContent` (`src/components/ui/hover-card.tsx`, Radix, portals + collision-flip built in). Both existing hovers on this screen use `openDelay={200} closeDelay={100}`, `side="bottom" align="start" collisionPadding={12}` — copy them.
- **CSV parsing**: `parseDelimitedRows(text, delimiter)` → `string[][]` and `getSpreadsheetDelimiter(filename, contentType)` in `src/components/chat-file-preview/spreadsheet/parse-delimited.ts` — dependency-light.
- **Helpers to reuse**: `formatFileSize` (exported from `file-card.tsx`), `getFileCategory`/`getFileIcon`/`getPreviewType`/`isImageFile`/`isBinarySpreadsheet` (`file-type-utils.ts`), `MarkdownRenderer` (`src/components/markdown-renderer.tsx`), `Skeleton` (`ui/skeleton.tsx`), `formatRelative` (currently private in `src/components/at-mention-menu/mention-target-hover-preview.tsx` — export it, §Wiring).

---

## Component architecture

Mirror the transcript pair exactly — one wrapper component owning hover + fetch state, one pure presentational preview:

```text
RecentlyUsedInGroup (recently-used-in-group.tsx)          + new prop: workspaceId
  └─ RecentAttachmentCard            (NEW  welcome-screen/attachment-card.tsx)
       ├─ HoverCard openDelay=200 closeDelay=100 onOpenChange→lazy fetch
       │    ├─ HoverCardTrigger asChild → <div className="w-fit"> → FileCard (existing, untouched)
       │    └─ HoverCardContent side=bottom align=start w-80 p-0 overflow-hidden
       │         └─ AttachmentHoverPreview   (NEW  welcome-screen/attachment-hover-preview.tsx)
       └─ state: AttachmentPreviewState (idle | loading | ready | error), fetched once per mount
```

### New file 1 — `src/components/welcome-screen/attachment-hover-preview.tsx` (presentational)

Exports:

```ts
export type AttachmentHoverKind = 'image' | 'table' | 'markdown' | 'text' | 'metadata';

export type AttachmentPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'error'; message: string };

export function getAttachmentHoverKind(filename: string, contentType?: string): AttachmentHoverKind;
export function AttachmentHoverPreview(props: {
  card: GroupNewChatAttachmentCard;
  kind: AttachmentHoverKind;        // already resolved to 'metadata' when workspaceId is null
  imageUrl: string | null;          // raw uploads URL; null when workspaceId is null
  state: AttachmentPreviewState;    // only meaningful for table/markdown/text
}): ReactElement;
```

Kind mapping — a thin shim over the existing detectors, no new extension lists:

```ts
export function getAttachmentHoverKind(filename: string, contentType?: string): AttachmentHoverKind {
  const previewType = getPreviewType(filename, contentType);
  switch (previewType) {
    case 'image':
    case 'svg':
      return isImageFile(filename, contentType) ? 'image' : 'metadata'; // heic/tiff → metadata
    case 'spreadsheet':
      return isBinarySpreadsheet(filename, contentType) ? 'metadata' : 'table';
    case 'markdown':
      return 'markdown';
    case 'code':
    case 'text':
    case 'json':
    case 'jsonl':
    case 'html':
      return 'text';
    default: // 'pdf' | 'notebook' | 'audio' | 'video' | 'other'
      return 'metadata';
  }
}
```

### New file 2 — `src/components/welcome-screen/attachment-card.tsx` (wrapper)

```tsx
export function RecentAttachmentCard({
  card,
  workspaceId,
  onSelect,
}: {
  card: GroupNewChatAttachmentCard;
  workspaceId: string | null;
  onSelect: (card: GroupNewChatAttachmentCard) => void;
}) {
  const displayName = card.originalName || card.filename;
  const kind = workspaceId
    ? getAttachmentHoverKind(displayName, card.contentType)
    : 'metadata';                                     // no workspace → nothing fetchable
  const [state, setState] = useState<AttachmentPreviewState>({ status: 'idle' });
  const fetchStartedRef = useRef(false);

  // card.filename is the stored name under uploads/ (mountPath minus the "uploads/" prefix) —
  // the same value message-bubble.tsx uses for its upload preview URLs.
  const imageUrl =
    workspaceId && kind === 'image'
      ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(card.filename)}`
      : null;

  const handleOpenChange = (open: boolean) => {
    if (!open || fetchStartedRef.current || !workspaceId) return;
    if (kind !== 'table' && kind !== 'markdown' && kind !== 'text') return;
    fetchStartedRef.current = true;
    setState({ status: 'loading' });
    const { initialUrl } = buildTextPreviewUrls(
      { workspaceId, source: 'upload', path: card.filename },
      { maxLines: kind === 'table' ? 12 : 24 },
    );
    fetch(initialUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw Object.assign(new Error('preview failed'), { status: response.status });
        }
        const data = (await response.json()) as { text: string; truncated: boolean };
        setState({ status: 'ready', text: data.text, truncated: data.truncated });
      })
      .catch((error) => {
        const status = (error as { status?: number })?.status;
        setState({
          status: 'error',
          message:
            status === 404 || status === 410
              ? 'This file is no longer available.'
              : status === 415
                ? 'No preview for this file type.'
                : 'Preview unavailable.',
        });
      });
  };

  return (
    <HoverCard openDelay={200} closeDelay={100} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <div className="w-fit">
          <FileCard
            filename={displayName}
            fileSize={card.size}
            contentType={card.contentType}
            onClick={() => onSelect(card)}
          />
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        collisionPadding={12}
        className="w-80 overflow-hidden p-0"
      >
        <AttachmentHoverPreview card={card} kind={kind} imageUrl={imageUrl} state={state} />
      </HoverCardContent>
    </HoverCard>
  );
}
```

Implementation notes, all deliberate:

- **The `<div className="w-fit">` trigger wrapper is required.** `FileCard` does not spread rest props onto its root, so `HoverCardTrigger asChild` cannot attach Radix's pointer/focus handlers to it directly. A plain div wrapper receives them; focus events from the inner button bubble to it, so keyboard focus still opens the preview. Do not modify `FileCard` and do not let the default (non-`asChild`) trigger render — it produces an `<a>` wrapping a `<button>`, which is invalid HTML.
- **Fetch once per card mount** (`fetchStartedRef`), on first open, matching the transcript pattern. Cards unmount when the attachment is added to the composer (the `attachedPaths` filter in `RecentlyUsedInGroup`) — no cross-mount cache needed. Images need no explicit fetch: the `<img>` loads on first open and the route's `max-age=3600` makes re-opens instant.
- **Errors are shown, not swallowed** (`state: 'error'` renders a visible message inside the metadata frame — see variant spec). Never render an empty body on failure.

### Render-site change — `recently-used-in-group.tsx`

Add `workspaceId: string | null` to `RecentlyUsedInGroupProps` and replace the direct `FileCard` in the attachments row:

```tsx
{attachmentCards.map((card) => (
  <RecentAttachmentCard
    key={card.path}
    card={card}
    workspaceId={workspaceId}
    onSelect={onAttachmentSelect}
  />
))}
```

---

## Hover content spec (exact)

The `HoverCardContent` shell is `w-80 overflow-hidden p-0` (320 px, matching the transcript preview). Inside, `AttachmentHoverPreview` renders header → body → footer.

### ① Header — every variant

```tsx
<div className="space-y-0.5 px-3 py-2.5">
  <p className="break-words text-sm font-medium leading-snug text-foreground">{displayName}</p>
  <p className="text-xs text-muted-foreground">
    {ext}{card.size != null ? ` · ${formatFileSize(card.size)}` : ''}
  </p>
</div>
```

- `displayName = card.originalName || card.filename`; `ext = getFileExtension(displayName).toUpperCase() || 'FILE'` — same derivations `FileCard` uses, so badge and header always agree.
- `break-words`, **no truncation** — showing the full name is half the point of the hover (the card truncates it). Long unbroken names wrap; that is fine.
- Size line only when `card.size` is known (it usually isn't on this screen — see Current State).

### ② Body variants

**`image`**

```text
├────────────────────────────────┤
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │   border-y border-border, bg-muted/30
│ ▒▒▒▒▒▒▒▒  (the image)  ▒▒▒▒▒▒ │   img: max-h-60 w-full object-contain
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │
├────────────────────────────────┤
```

```tsx
<div className="relative border-y border-border bg-muted/30">
  {!loaded && !failed && <Skeleton className="h-40 w-full rounded-none" />}
  {failed ? (
    <p className="px-3 py-6 text-center text-xs text-muted-foreground">Couldn’t load image.</p>
  ) : (
    <img
      src={imageUrl}
      alt={displayName}
      className={cn('max-h-60 w-full object-contain', !loaded && 'absolute h-0 opacity-0')}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  )}
</div>
```

Local `loaded`/`failed` state lives inside this variant (reset via `key={imageUrl}` if needed). Skeleton keeps the card from collapsing to zero height while bytes stream. `bg-muted/30` gives transparent PNGs/SVGs a readable ground in both themes.

**`table`** (csv/tsv, `state.status === 'ready'`)

```text
├────────────────────────────────┤
│ email        plan    seats mrr │   header row: bg-muted/50 font-medium
│ ada@ex.com   pro     4     $96 │   rows: border-b border-border/50
│ lin@ex.com   starter 1     $12 │   cells: truncate (table-fixed)
│ …                              │
│ First 8 rows · 2 more columns  │   footnote, only when clipped
├────────────────────────────────┤
```

Shaping (pure function `shapeDelimitedPreview(text, truncated, displayName, contentType)` exported for tests):

```ts
const rows = parseDelimitedRows(text, getSpreadsheetDelimiter(displayName, contentType));
const safeRows = truncated ? rows.slice(0, -1) : rows; // last fetched row may be cut mid-quote
const header = safeRows[0] ?? [];
const body = safeRows.slice(1, 9);                     // ≤ 8 data rows
const totalCols = Math.max(header.length, ...body.map((r) => r.length), 0);
const cols = Math.min(totalCols, 6);                   // ≤ 6 columns
```

Import `parseDelimitedRows`/`getSpreadsheetDelimiter` **directly from `@/components/chat-file-preview/spreadsheet/parse-delimited`** — never from the `spreadsheet` barrel (`index.ts` re-exports `parse-excel`, which statically imports the heavy `xlsx` package; the barrel would drag it into the main chunk that today only loads it lazily).

Rendering: `<table className="w-full table-fixed border-t border-border text-[11px] tabular-nums">`; header cells `bg-muted/50 px-2 py-1 text-left font-medium text-muted-foreground truncate`; body cells `border-b border-border/50 px-2 py-1 truncate text-foreground` (`table-fixed` makes `truncate` work with equal column widths). Footnote when `truncated || body.length === 8 || totalCols > cols`: `px-3 py-1.5 text-[10px] text-muted-foreground` reading `First {body.length} rows` plus `` · {totalCols - cols} more columns`` when columns were clipped. If `safeRows` ends up empty (empty file), fall through to the `metadata` body with the note "Empty file."

**`markdown`** (`state.status === 'ready'`)

```tsx
<div className="max-h-[280px] overflow-y-auto border-t border-border px-3 py-2.5">
  <MarkdownRenderer content={state.text} variant="default" className="text-sm" />
</div>
```

Same renderer + sizing the transcript hover already uses on this screen. Radix keeps the card open while the pointer is over it, so scrolling works.

**`text`** (code / txt / log / json / jsonl / html source, `state.status === 'ready'`)

```tsx
<pre className="max-h-[280px] overflow-y-auto overflow-x-hidden whitespace-pre border-t border-border bg-muted/30 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground">
  {state.text || 'Empty file.'}
</pre>
```

Plain text, **no Shiki** — the async highlighter + grammar load is not worth it for a glance, and the dialog viewer already covers "read it properly". Long lines clip at the right edge (`overflow-x-hidden`) — horizontal scrolling inside a hover is hostile, and clipped lines still identify the file. When `state.truncated`, append the same footnote style as the table: `First 24 lines`.

**`metadata`** (pdf, xlsx/xls, ipynb, audio, video, other, non-renderable images; also the body for `error` states and `workspaceId === null`)

```text
├────────────────────────────────┤
│                                │
│              ▤                 │   getFileIcon(getFileCategory(displayName, contentType))
│                                │   size-8, text-muted-foreground, strokeWidth 1.5
│    This file is no longer      │   ← error line, only in error state
│         available.             │
├────────────────────────────────┤
```

```tsx
<div className="flex flex-col items-center gap-2 border-y border-border bg-muted/30 px-4 py-5">
  <Icon className="size-8 text-muted-foreground" strokeWidth={1.5} aria-hidden />
  {state.status === 'error' ? (
    <p className="text-center text-xs text-muted-foreground">{state.message}</p>
  ) : null}
</div>
```

No extra text in the happy path — the header (full name, type) and footer (source, recency) already say everything we know about a pdf/zip. Do not fake content.

**Loading** (`state.status === 'idle' | 'loading'` for table/markdown/text) — skeleton lines in the body slot, mirroring the transcript hover's `LoadingPreview`:

```tsx
<div className="space-y-2 border-t border-border px-3 py-3">
  <Skeleton className="h-3 w-3/4" />
  <Skeleton className="h-3 w-full" />
  <Skeleton className="h-3 w-2/3" />
</div>
```

### ③ Footer — every variant

```tsx
<div className="flex items-center gap-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
  <MessageSquare className="size-3 shrink-0" aria-hidden />
  <span className="truncate">
    {card.sourceTitle ? <>From “{card.sourceTitle}”</> : 'Used'} · {formatRelative(card.lastUsedAt)}
  </span>
</div>
```

- `formatRelative` is the helper already rendering "today / yesterday / N days ago" in the connection/project hovers **on this same screen** — reuse it for identical wording (see Wiring for the export).
- Single line, `truncate` — the source title can be long; the relative time must stay visible, hence title first inside one truncating span with the time appended (accept that an extremely long title can push the time out; do not add a second line).

### Interaction rules

- `openDelay={200} closeDelay={100}`, `side="bottom"`, `align="start"`, `collisionPadding={12}` — identical to `TranscriptCard` and `MentionTargetHoverCard` so the three hovers on this screen feel like one system. Radix flips to top automatically when the composer is close below.
- Click behavior is untouched: clicking attaches the file (existing `onAttachmentSelect`), the card leaves the section (existing `attachedPaths` filter), and the hover disappears with it.
- Keyboard: focusing the card button opens the preview (Radix opens on focus; the focus event bubbles to the trigger div). The preview is supplementary — Radix `HoverCard` content is not exposed to screen readers by design, which matches the other card hovers here; the card button's existing `aria-label` (the filename) remains the accessible name. The `<img>` gets `alt={displayName}`; icons are `aria-hidden`.
- Touch devices: Radix `HoverCard` ignores touch — tap simply attaches, same as the transcript cards. No work needed.
- **No actions inside the hover** — no download, no "open full preview", no buttons. Content only, like the transcript hover.
- **No Radix `ScrollArea`** anywhere in the content — use plain `max-h-* overflow-y-auto` divs. `ScrollArea`'s viewport renders `display: table`, which breaks `truncate`/`line-clamp` (documented in `docs/chat-group-hover-state-feedback-r2.md`; the transcript hover avoids it for the same reason).

---

## Wiring (complete edit list)

| # | File | Change | Class |
|---|---|---|---|
| 1 | `src/components/welcome-screen/attachment-hover-preview.tsx` | **New** — `AttachmentHoverPreview`, `getAttachmentHoverKind`, `shapeDelimitedPreview`, `AttachmentPreviewState` | required |
| 2 | `src/components/welcome-screen/attachment-card.tsx` | **New** — `RecentAttachmentCard` (HoverCard wrapper + lazy fetch, spec above) | required |
| 3 | `src/components/welcome-screen/recently-used-in-group.tsx` | Add `workspaceId: string \| null` prop; render `RecentAttachmentCard` instead of bare `FileCard` in the attachments row | required |
| 4 | `src/components/welcome-screen/index.tsx` | Add `workspaceId: string \| null` to `WelcomeScreenProps`; pass through to `RecentlyUsedInGroup` | required |
| 5 | `src/components/Chat.tsx` (~line 4286, `<WelcomeScreen …>`) | Pass `workspaceId={resolvedWorkspaceId ?? null}` (already in scope, line ~621) | required |
| 6 | `src/components/chat-file-preview/file-preview-urls.ts` | Add `export` to the existing private `encodePathSegments` | required (1 word) |
| 7 | `src/components/at-mention-menu/mention-target-hover-preview.tsx` | Add `export` to the existing private `formatRelative` | required (1 word) |

Explicitly **not** changed: `FileCard` (`file-card.tsx`), `AttachmentList`, `FilePreviewChip`, `FilePreviewContent`, the preview panel, any type in `src/types.ts`, any loader, any API route, anything in `workers/`. This feature is frontend-only; both endpoints it calls already exist and are R2-backed (no live sandbox involved). `message-bubble.tsx` keeps its private `encodePathSegments` copy — leave it (no refactor pass).

Edge cases already handled by the design:

- `workspaceId` is null (defensive; group cards only load when a workspace exists) → `kind` forced to `metadata`, no network calls, hover still shows name + source + time.
- `contentType`/`size` undefined (the normal case here) → extension-based detection, size line omitted; the raw-URL route serves the correct stored content type regardless.
- Upload deleted from R2 → image variant shows "Couldn’t load image."; text variants show "This file is no longer available." — visible failure, per the error-handling culture.
- Misnamed file (e.g. `.csv` that's actually binary) → text route answers 415 → "No preview for this file type." in the metadata frame.

---

## Tests (agent-actionable)

New file `tests/attachment-hover-preview.test.tsx` (jsdom, alongside `tests/transcript-hover-preview.test.tsx`, same style):

- `getAttachmentHoverKind`: `photo.png`→`image`, `logo.svg`→`image`, `pic.heic`→`metadata`, `data.csv`→`table`, `data.xlsx`→`metadata`, `README.md`→`markdown`, `main.py`→`text`, `page.html`→`text`, `events.jsonl`→`text`, `report.pdf`→`metadata`, `run.ipynb`→`metadata`, `demo.mp4`→`metadata`, `bundle.zip`→`metadata`; contentType-only detection (`filename: 'blob'`, `contentType: 'text/csv'`)→`table`.
- `shapeDelimitedPreview`: caps at 8 data rows / 6 columns; drops the last row when `truncated`; empty text → empty shape.
- `AttachmentHoverPreview` render states: ready `text` shows mono content + "First 24 lines" footnote when truncated; ready `table` renders header + rows; `metadata` for a pdf shows the icon and no fabricated content; `error` state shows the message; footer shows `From “<sourceTitle>”` and the card's relative time in all variants; header shows the full original name.

Run: `bun run test:run -- tests/attachment-hover-preview.test.tsx`, then `bun run typecheck`. Manual pass: `bun run dev`, open a group with prior file uploads via `/chat?group=<id>`, hover a png / csv / py / pdf card; confirm flip-up near the composer, skeleton→content on first open, and that clicking still attaches.

---

## Decisions locked for v1

1. Five body variants only (`image`, `table`, `markdown`, `text`, `metadata`); `metadata` is the universal fallback — no per-type bespoke bodies beyond the table above.
2. Recall over fidelity: 24 lines / 8 rows / 6 columns / 240 px image height. No "show more", no scroll-to-load — the full viewer remains an active-chat feature.
3. No syntax highlighting, no `xlsx` parsing, no pdf.js, no media playback inside the hover.
4. Header + footer on every variant; footer always names the source chat and recency from fields already on `GroupNewChatAttachmentCard`.
5. Neutral theme tokens only (`foreground`/`muted-foreground`/`border`/`card`/`muted`), matching the screen's design principles — no hard-coded colors.

## Out of scope

- Thumbnails on the resting 88×88 card (it stays icon-based; only the hover previews content).
- Hover previews for attachments already added to the composer (`AttachmentList` in the prompt input) and for in-chat `FilePreviewChip`s — different surfaces, unchanged.
- Any change to the active-chat preview panel, upload pipeline, `GroupNewChatAttachmentCard` shape, or server routes.
- PDF page rendering, audio/video playback, notebook cell rendering in hovers — revisit only if the metadata variant proves insufficient in use.
