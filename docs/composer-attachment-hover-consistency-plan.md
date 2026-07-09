# Composer Attachment Hover Consistency — Plan

## Goal

Make attachments in the text input field (the composer strip rendered by
`src/components/attachment-list.tsx`) feel identical to the attachment cards on the
group new-chat screen (`src/components/welcome-screen/attachment-card.tsx`):

1. **Rich hover preview.** Hovering a composer attachment opens the same HoverCard
   preview the group screen has (filename + type/size header, image/table/markdown/text
   body, source-chat footer when known).
2. **Same hover action language.** The group screen signals its action by swapping the
   category icon to a Plus in place ("hover reveals the action, in the icon slot").
   The composer's action is *remove*, so its cards swap the icon to an **X** in the same
   slot with the same geometry — replacing today's tiny dark X floating half-outside the
   card corner.
3. **Unify at the component level.** The hover preview, fetch-on-open logic, and image
   tile currently live only in `welcome-screen/`. Extract them into shared components so
   both surfaces render through one code path and cannot drift again.

The one-sentence design rule, applied everywhere:

> **Rest state shows identity (category icon). Hover shows the available action
> (Plus = add, X = remove) in the same slot with the same geometry, and every completed
> attachment gets the same rich hover preview.**

## Audit: why the two surfaces differ today

`AttachmentList` predates the group new-chat work. PR #970 ("Add group attachment hover
previews") built new primitives — `RecentAttachmentCard`, `AttachmentHoverPreview`, a
local `ImageTile` — on top of the shared `FileCard`, but the composer strip was never
revisited. The result is three near-duplicate implementations of the same visuals:

| Aspect | Group new-chat screen | Composer (input field) |
| --- | --- | --- |
| Hover preview | `HoverCard` with header/body/footer (`attachment-hover-preview.tsx`) | None |
| Hover action | Icon slot swaps to Plus (`file-card.tsx:88-92`); image tiles show a glass Plus badge inside the corner (`attachment-card.tsx:55-60`) | 16px dark X floating at `-right-1 -top-1`, duplicated 3× (`file-card.tsx:133-145`, `attachment-list.tsx:98-110`, `attachment-list.tsx:144-152`) |
| Image tiles | `ImageTile` component with load skeleton, server URL | Inline bespoke JSX (`attachment-list.tsx:134-154`), blob URL only, no skeleton |
| Images added *from* the group screen | 88×88 thumbnail | Fall back to a generic `FileCard` — `handleRecentAttachmentSelect` (`Chat.tsx:3279`) sets no `previewUrl`, and the composer only renders thumbnails from `previewUrl` |
| Transcript cards | `TranscriptCard` with hover preview + Plus swap | Bespoke 184×88 card, floating X, no preview |
| Card hover chrome | `hover:border-ring hover:shadow-md` | Same — already consistent |

Data compatibility is already in place, which is why unification is cheap:

- Composer `Attachment.path` is `uploads/<storedFilename>` (`Chat.tsx:3148-3160`,
  guarded by `isUserUploadMountPath`). The group card's `card.filename` is exactly the
  `<storedFilename>` part, used for `/api/workspaces/:id/uploads/<filename>` and
  `buildTextPreviewUrls({ source: 'upload', path: filename })`. So the composer can feed
  the same preview endpoints by stripping the `uploads/` prefix.
- Transcript attachments are uploaded as real `.md` files (`Chat.tsx:3193+`), so the
  generic markdown preview renders them with no transcript-specific code.
- `resolvedWorkspaceId` is available at every `PromptInput` call site; it just isn't
  threaded down to `AttachmentList` yet.

## Target UX

### Composer file tile (non-image)

```
        REST                          HOVER  (border-ring + shadow-md, as today)
  ┌─────────────┐                ┌─────────────┐
  │ CSV      ⛁  │                │ CSV      ✕  │   ← category icon fades out,
  │             │                │             │     X button fades in — same slot,
  │ revenue.csv │                │ revenue.csv │     same 14px glyph size
  │ 14.2 KB     │                │ 14.2 KB     │
  └─────────────┘                └─────────────┘
```

### Hover preview (opens after 200 ms, ABOVE the tile — `side="top"`)

```
   ┌─ HoverCardContent  w-80 p-0 overflow-hidden ──┐
   │ revenue.csv                                   │ ← text-sm font-medium
   │ CSV · 14.2 KB                                 │ ← text-xs text-muted-foreground
   │ ┌───────────┬──────────┬───────┐              │
   │ │ email     │ plan     │ mrr   │              │ ← same table/markdown/text/image
   │ │ a@x.com   │ pro      │ 49    │              │   bodies as the group screen
   │ │ b@y.com   │ starter  │ 9     │              │   (max 8 rows × 6 cols)
   │ └───────────┴──────────┴───────┘              │
   │ First 8 rows · 2 more columns                 │ ← 10px footnote
   │ 💬 From “Churn analysis”                       │ ← footer, only when the file came
   └───────────────────────────────────────────────┘   from another chat
                     ▲
  ┌─────────────┐    │
  │ CSV      ✕  │────┘
  └─────────────┘
```

The composer preview opens `side="top"` because the input sits at the bottom of the
viewport in an active chat; the group screen keeps `side="bottom"`.

### Composer image tile

```
        REST                          HOVER
  ┌─────────────┐                ┌─────────────┐
  │             │                │         (✕) │   ← 20px glass circle, top-right
  │    photo    │                │    photo    │     INSIDE the tile — identical
  │             │                │             │     geometry to the group screen's
  └─────────────┘                └─────────────┘     (+) badge, glyph swapped to X
```

Hovering also opens the preview with the full image (`max-h-60 object-contain` body).

### Composer transcript tile

```
        REST                                HOVER
  ┌───────────────────────┐          ┌───────────────────────┐
  │ CHAT              💬  │          │ CHAT              ✕   │  ← MessageSquare → X,
  │ Planning chat         │          │ Planning chat         │    same slot swap
  │ Plan the rollout      │          │ Plan the rollout      │
  └───────────────────────┘          └───────────────────────┘
                                     + markdown hover preview of the transcript file;
                                       header shows “Planning chat” / “MD · 1.0 KB”,
                                       footer “From “Planning chat””
```

The composer transcript tile keeps its 88px-tall, 184px-wide shape (it must sit in a
row with 88×88 file tiles). Do **not** restyle it to match the group screen's 200px
`TranscriptCard` — consistency inside the strip wins; the *hover language* is what
unifies the surfaces.

### Group new-chat screen

Visually unchanged. Same cards, same Plus affordances, same previews — but rendered
through the new shared components.

### State rules (both surfaces)

- `uploading`: no hover preview, no remove button (unchanged rule), progress bar as today.
- `error`: no hover preview; the AlertCircle icon swaps to the X button on hover so the
  failed upload can be dismissed; red border/`Error` text unchanged.
- `complete`: hover preview enabled whenever `workspaceId` is known and `path` starts
  with `uploads/`; remove button available.

## Implementation

### Step 1 — Generalize and move `AttachmentHoverPreview`

Move `src/components/welcome-screen/attachment-hover-preview.tsx` →
`src/components/chat-file-preview/attachment-hover-preview.tsx` and decouple it from
`GroupNewChatAttachmentCard`. Everything else in the file (kind mapping, table shaping,
all body renderers, loading/error states) stays byte-identical.

```tsx
export interface AttachmentHoverPreviewProps {
  /** Header title: chat title for transcripts, original filename otherwise. */
  displayName: string;
  /** Real filename with extension — drives the ext label and the CSV/TSV delimiter. */
  filename: string;
  size?: number;
  contentType?: string;
  kind: AttachmentHoverKind;
  imageUrl: string | null;
  state: AttachmentPreviewState;
  /** Source-chat attribution text. Row (icon + text) is omitted entirely when absent. */
  footer?: ReactNode;
}
```

Changes inside the file:

- `AttachmentHeader` takes `displayName` + derives `ext` from `filename`
  (`getFileExtension(filename)`), not from `displayName` — required for transcript
  headers where `displayName` is a chat title with no extension.
- `TableBody` computes the delimiter from `filename` for the same reason.
- The footer block keeps its chrome inside the component but renders only when
  `footer` is provided:

```tsx
{footer != null ? (
  <div className="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground">
    <MessageSquare className="size-3 shrink-0" aria-hidden />
    <span className="truncate">{footer}</span>
  </div>
) : null}
```

- Delete the `formatRelative` import (moves to the group caller in Step 6).
- Keep exporting `getAttachmentHoverKind`, `shapeDelimitedPreview`,
  `AttachmentHoverKind`, `AttachmentPreviewState`, `DelimitedPreviewShape`.

### Step 2 — New shared `AttachmentHoverCard`

New file `src/components/chat-file-preview/attachment-hover-card.tsx`. This absorbs the
HoverCard shell + fetch-on-open state machine currently inlined in
`RecentAttachmentCard` (`attachment-card.tsx:78-160`), unchanged in behavior.

```tsx
interface AttachmentHoverCardProps {
  workspaceId: string | null;
  /** Stored filename under uploads/ used for preview fetches; null → metadata-only. */
  uploadFilename: string | null;
  displayName: string;
  filename: string;
  size?: number;
  contentType?: string;
  /** Optional image override (composer blob URL). Defaults to the uploads URL. */
  imageUrl?: string | null;
  footer?: ReactNode;
  side?: 'top' | 'bottom';           // default 'bottom' (group screen)
  /** Render children with no hover card at all (uploading/error attachments). */
  disabled?: boolean;
  children: ReactNode;
}
```

Behavior spec:

- `if (disabled) return <>{children}</>;`
- `kind`: `workspaceId && uploadFilename ? getAttachmentHoverKind(filename, contentType) : 'metadata'`
  (matches the group card's `workspaceId ? ... : 'metadata'` fallback — a metadata-only
  header card still shows when the workspace is unknown).
- `resolvedImageUrl`: `imageUrl ?? (kind === 'image' && workspaceId && uploadFilename
  ? \`/api/workspaces/${workspaceId}/uploads/${encodePathSegments(uploadFilename)}\` : null)`.
- Fetch-on-open: copy `handleOpenChange` from `attachment-card.tsx:87-123` verbatim
  (one-shot `fetchStartedRef`, `maxLines: kind === 'table' ? 12 : 24`, 404/410/415 error
  messages).
- Shell markup (identical numbers to the group screen):

```tsx
<HoverCard openDelay={200} closeDelay={100} onOpenChange={handleOpenChange}>
  <HoverCardTrigger asChild>
    <div className="w-fit">{children}</div>
  </HoverCardTrigger>
  <HoverCardContent
    side={side}
    align="start"
    collisionPadding={12}
    className="w-80 overflow-hidden p-0"
  >
    <AttachmentHoverPreview
      displayName={displayName}
      filename={filename}
      size={size}
      contentType={contentType}
      kind={kind}
      imageUrl={resolvedImageUrl}
      state={state}
      footer={footer}
    />
  </HoverCardContent>
</HoverCard>
```

The `<div className="w-fit">` trigger wrapper is required — `FileCard`/`ImageTile` do
not forward refs, and this is exactly how the group card already solves it.

### Step 3 — Shared `ImageTile` with add/remove modes

New file `src/components/image-tile.tsx`. Start from the group screen's `ImageTile`
(`attachment-card.tsx:24-63`) and add a remove mode. Delete the original from
`attachment-card.tsx` and the inline image JSX from `attachment-list.tsx:134-154`.

```tsx
interface ImageTileProps {
  imageUrl: string;
  displayName: string;
  /** Add mode: whole tile is a button; hover shows a Plus badge. */
  onSelect?: () => void;
  /** Remove mode: tile is inert; hover/focus shows an X badge button. */
  onRemove?: () => void;
  onError?: () => void;
  className?: string;
}
```

Exactly one of `onSelect` / `onRemove` is provided (document in JSDoc; no runtime check).

**Add mode** — byte-identical to today's group markup: root
`<button type="button" onClick={onSelect} aria-label={\`Add ${displayName} to chat\`}`
with classes
`group/thumb relative h-[88px] w-[88px] cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/30 transition-all duration-200 ease-out hover:border-ring hover:shadow-md`;
skeleton overlay until `onLoad`; `img` with `alt=""` and
`h-full w-full object-cover transition-opacity duration-150` + loaded opacity swap;
badge:

```tsx
<span
  aria-hidden
  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100"
>
  <Plus className="h-3 w-3 text-foreground" />
</span>
```

**Remove mode** — same shell as a `<div>` (drop `cursor-pointer`, no `aria-label`,
`img` gets `alt={displayName}`), same skeleton/img, and the badge becomes a real button
with identical geometry:

```tsx
<button
  type="button"
  onClick={(event) => {
    event.stopPropagation();
    onRemove();
  }}
  aria-label={`Remove ${displayName}`}
  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 group-focus-within/thumb:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  <X className="h-3 w-3" />
</button>
```

Note the opacity-based reveal (never `hidden`/`display:none`) — a `display:none` button
can't receive keyboard focus, and reveal-on-focus must keep working.

### Step 4 — `FileCard`: remove affordance moves into the icon slot

Rework `src/components/file-card.tsx`:

1. **Delete** the floating remove button (`file-card.tsx:132-145`) and the outer wrapper
   `<div className="group/card relative outline-none" tabIndex=...>` — with the X inside
   the card, the wrapper's only job disappears. Move `group/card relative` onto
   `CardElement`'s own class list (the hover classes below depend on `group/card`).
2. **Replace the top zone** (`file-card.tsx:81-96`) with a unified action slot. Both the
   add (Plus) and remove (X) variants render inside the same 20px stack so the glyph
   geometry is pixel-identical across surfaces:

```tsx
{/* Top zone: extension badge + action slot */}
<div className="flex items-start justify-between">
  <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase leading-none">
    {ext}
  </Badge>
  <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
    {isError ? (
      <AlertCircle
        aria-hidden
        className={cn(
          'h-3.5 w-3.5 text-destructive',
          showRemove &&
            'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0',
        )}
      />
    ) : (
      <Icon
        aria-hidden
        className={cn(
          'h-3.5 w-3.5 text-muted-foreground',
          showAddOnHover && 'group-hover/card:hidden',
          showRemove &&
            'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0',
        )}
      />
    )}
    {showAddOnHover && !isError ? (
      <Plus
        aria-hidden
        className="absolute hidden h-3.5 w-3.5 text-muted-foreground group-hover/card:block"
      />
    ) : null}
    {showRemove ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove?.();
        }}
        aria-label={`Remove ${filename}`}
        className="absolute inset-0 flex items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    ) : null}
  </span>
</div>
```

3. `showRemove` keeps its current definition (`Boolean(onRemove) && !isUploading`).
4. Update the `onRemove` JSDoc: "Renders a hover/focus X button in the icon slot. Do not
   combine with `onClick` (would nest a button inside a button)." No current caller
   combines them — verified: `attachment-list.tsx` passes only `onRemove`,
   `file-preview-chip.tsx:84` and the group card pass only `onClick`.

The 20px slot means the glyph center shifts ~3px from today's top-aligned icon — do this
for **both** modes so the add and remove variants stay identical; the shift itself is
imperceptible.

### Step 5 — Rewrite the composer strip (`attachment-list.tsx`)

Add `workspaceId: string | null` to `AttachmentListProps`. Replace the body of the
`.map()` with a per-attachment component (it needs local state for thumbnail failure):

```tsx
function AttachmentTile({
  attachment,
  workspaceId,
  onRemove,
}: {
  attachment: Attachment;
  workspaceId: string | null;
  onRemove: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const isTranscript = attachment.kind === 'transcript';
  const displayName = isTranscript
    ? attachment.sourceTitle || attachment.originalName || attachment.name
    : attachment.originalName || attachment.name;
  const uploadFilename =
    attachment.status === 'complete' && isUserUploadMountPath(attachment.path)
      ? attachment.path.slice(USER_UPLOAD_MOUNT_PREFIX.length)
      : null;
  const isImage = isImageFile(attachment.name, attachment.contentType);
  const serverImageUrl =
    isImage && workspaceId && uploadFilename
      ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(uploadFilename)}`
      : null;
  const tileImageUrl = attachment.previewUrl ?? serverImageUrl;

  const tile = isTranscript ? (
    <TranscriptAttachmentCard attachment={attachment} onRemove={onRemove} />
  ) : isImage && tileImageUrl && attachment.status === 'complete' && !thumbFailed ? (
    <ImageTile
      imageUrl={tileImageUrl}
      displayName={displayName}
      onRemove={onRemove}
      onError={() => setThumbFailed(true)}
    />
  ) : (
    <FileCard
      filename={attachment.name}
      fileSize={attachment.size}
      contentType={attachment.contentType}
      uploadStatus={attachment.status}
      uploadProgress={attachment.progress}
      uploadError={attachment.error}
      onRemove={onRemove}
    />
  );

  return (
    <AttachmentHoverCard
      workspaceId={workspaceId}
      uploadFilename={uploadFilename}
      displayName={displayName}
      filename={attachment.name}
      size={attachment.size}
      contentType={attachment.contentType}
      imageUrl={attachment.previewUrl ?? undefined}
      footer={
        attachment.sourceTitle ? <>From &ldquo;{attachment.sourceTitle}&rdquo;</> : undefined
      }
      side="top"
      disabled={attachment.status !== 'complete'}
    >
      {tile}
    </AttachmentHoverCard>
  );
}
```

Imports: `USER_UPLOAD_MOUNT_PREFIX`, `isUserUploadMountPath` from
`@/lib/chat-attachment-refs`; `encodePathSegments` from
`@/components/chat-file-preview/file-preview-urls`; `ImageTile` from
`@/components/image-tile`; `AttachmentHoverCard` from
`@/components/chat-file-preview/attachment-hover-card`.

What this fixes beyond hover states:

- **Group-added images become thumbnails.** `previewUrl ?? serverImageUrl` means images
  attached from the group screen (which have no blob URL) now render as 88×88 tiles from
  the uploads endpoint instead of falling back to a generic `FileCard`.
- The old inline image JSX (`attachment-list.tsx:134-154`) and its floating X are deleted.
- Keep the outer wrapper exactly as today:
  `<div className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}>`.

**`TranscriptAttachmentCard` changes** (same file): keep the card shell, badge, title,
snippet, progress bar, and 184×88 shape exactly as-is. Two edits:

1. Delete the floating X button (`attachment-list.tsx:98-110`) and the wrapper's
   `tabIndex`; move `group/card relative` onto the card `<div>` itself.
2. Replace the top-right icon (`attachment-list.tsx:61-65`) with the same 20px action
   slot as `FileCard` (Step 4 markup), using `MessageSquare` as the identity icon,
   `AlertCircle` in the error state, and the same X button with
   `aria-label={\`Remove ${title}\`}`. Reveal rules identical
   (`showRemove = !isUploading`).

### Step 6 — Rewire the group card as a thin composition

`src/components/welcome-screen/attachment-card.tsx` shrinks to trigger-selection +
footer. Delete its local `ImageTile`, preview state machine, `handleOpenChange`, and
HoverCard shell (all now in the shared components):

```tsx
export function RecentAttachmentCard({ card, workspaceId, onSelect }: {...}) {
  const displayName = card.originalName || card.filename;
  const kind = workspaceId
    ? getAttachmentHoverKind(displayName, card.contentType)
    : 'metadata';
  const [thumbFailed, setThumbFailed] = useState(false);
  const imageUrl =
    workspaceId && kind === 'image'
      ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(card.filename)}`
      : null;

  return (
    <AttachmentHoverCard
      workspaceId={workspaceId}
      uploadFilename={card.filename}
      displayName={displayName}
      filename={displayName}
      size={card.size}
      contentType={card.contentType}
      footer={
        <>
          {card.sourceTitle ? (
            <>From &ldquo;{card.sourceTitle}&rdquo;</>
          ) : (
            'Used'
          )}{' '}
          · {formatRelative(card.lastUsedAt)}
        </>
      }
    >
      {imageUrl && !thumbFailed ? (
        <ImageTile
          imageUrl={imageUrl}
          displayName={displayName}
          onSelect={() => onSelect(card)}
          onError={() => setThumbFailed(true)}
        />
      ) : (
        <FileCard
          filename={displayName}
          fileSize={card.size}
          contentType={card.contentType}
          onClick={() => onSelect(card)}
          showAddOnHover
        />
      )}
    </AttachmentHoverCard>
  );
}
```

`filename={displayName}` intentionally preserves today's behavior (ext label, delimiter,
and kind all derive from the display name on the group screen). `formatRelative` is
imported here now, from `@/components/at-mention-menu/mention-target-hover-preview`.
Default `side` stays `'bottom'`. Behavior is otherwise identical to today, including the
image→FileCard fallback on load error (`tests/attachment-hover-preview.test.tsx:269-298`
must keep passing).

### Step 7 — Thread `workspaceId` to the composer

- `src/components/prompt-input.tsx`: add `workspaceId?: string | null` to
  `PromptInputProps`; pass it to `<AttachmentList workspaceId={workspaceId ?? null} ...>`
  at line ~509.
- `src/components/Chat.tsx` (~line 4112, the active-chat `<PromptInput>`): add
  `workspaceId={resolvedWorkspaceId}`.
- `src/components/welcome-screen/index.tsx`: both `<PromptInput>` renders (group branch
  ~line 516, default branch ~line 572) get `workspaceId={workspaceId}` — the prop
  already exists on `WelcomeScreenProps`.

No route, loader, or backend changes anywhere in this plan.

## Scope classification

**Required**

- Steps 1–7. The extraction (Steps 1–3) is not optional polish: the shared
  `AttachmentHoverCard`/`ImageTile` are lifted out of the group card, and Step 6 pointing
  the group card back at them is what prevents a second fork of this UI.

**Cuttable if implementation runs into trouble** (each degrades gracefully)

- Transcript hover preview: pass `disabled` for `kind === 'transcript'` attachments in
  `AttachmentTile` and keep only the X-in-slot restyle for transcript cards.
- Server-URL thumbnail fallback for group-added images: drop `serverImageUrl` and keep
  the `previewUrl`-only condition (group-added images then stay generic cards, as today).

**Deliberately not doing** (do not expand into these)

- Restyling the group screen's 200px `TranscriptCard` or merging it with the composer's
  184px transcript tile — different surfaces, different scale.
- Hover previews for in-message chips (`chat-file-preview/file-preview-chip.tsx`) — those
  have a click-to-open preview panel already.
- Touching `MentionTargetHoverCard` (connections/projects hover) — already shared.
- Any change to upload flows, attachment persistence, or `Attachment` shape.

## Tests

Run: `bun run typecheck` and
`bun run test:run tests/attachment-list.test.tsx tests/attachment-hover-preview.test.tsx tests/recently-used-in-group.test.tsx`.

**`tests/attachment-hover-preview.test.tsx`** — update to the new import path
(`@/components/chat-file-preview/attachment-hover-preview`) and generalized props:
replace `card={makeCard(...)}` with `displayName`/`filename`/`size`/`contentType`, and
the footer assertions with an explicit `footer={<>From “Churn dashboard” · 3 days ago</>}`
(plus one new assertion: no footer row renders when `footer` is omitted). The
`getAttachmentHoverKind`, `shapeDelimitedPreview`, and `RecentAttachmentCard` suites are
unchanged and must keep passing as-is.

**`tests/attachment-list.test.tsx`** — keep the existing transcript test green (the
`Remove Planning chat` aria-label is preserved by Step 5), and add, following the
existing render-and-assert style (no Radix open-state simulation needed):

1. File attachment (`status: 'complete'`, `path: 'uploads/data-123-ab.csv'`,
   `workspaceId="ws_1"`): renders the filename, and
   `getByRole('button', { name: 'Remove data.csv' })` fires `onRemove` with the id.
2. Image attachment with `previewUrl`: renders an `img` with the blob src and an X badge
   button `Remove photo.png`.
3. Group-added image (no `previewUrl`, `contentType: 'image/png'`,
   `path: 'uploads/stored photo.png'`, `workspaceId="ws_1"`): renders an `img` whose src
   contains `/api/workspaces/ws_1/uploads/` and `stored%20photo.png`.
4. Uploading attachment (`status: 'uploading'`): no remove button in the document.
5. `workspaceId={null}`: still renders tiles and remove buttons (hover card degrades to
   metadata-only; nothing throws).

**`tests/recently-used-in-group.test.tsx`** — no edits expected; `RecentAttachmentCard`'s
public API is unchanged. If it breaks, Step 6 drifted from parity — fix the component,
not the test.
