# File Upload Card Redesign

## Problem

File attachments in chat have two visual problems:

1. **Non-image file cards are rectangular, not square.** Image previews render as `120px x 120px` squares, but non-image file cards render as `160px` wide with variable height (~120px). This makes mixed-type attachment rows look uneven.

2. **The in-chat file cards and the input-field attachment chips look completely different.** The input-field chips are tiny horizontal pills (`px-2 py-1.5`, icon + text in a row), while the in-chat cards are vertical icon-boxes. Users should see the same visual representation of a file in both places.

The goal is to replace both with a single **uniform square card** component that works in both contexts.

---

## Design

All file types (except images/SVGs, which already render as square thumbnails) use the same square card. The card is `88px x 88px` — chosen to sit well alongside the existing `120px` image thumbnails while not feeling oversized for the input field context.

### Card Anatomy

```
┌──────────────────────────────┐
│  ┌─────┐              ┌───┐ │
│  │ CSV │              │ ⊞ │ │   ← Top zone: extension badge (left), category icon (right)
│  └─────┘              └───┘ │
│                              │
│                              │
│                              │
│  723_-_Gar...                │   ← Filename: semi-bold, truncated
│  14 KB                       │   ← File size (or upload % during progress)
│ ━━━━━━━━━━━░░░░░░░░░░░░░░░░ │   ← Progress bar (only during upload)
└──────────────────────────────┘
```

### Top Zone Detail

```
┌─────┐                  ┌───┐
│ CSV │                  │ ⊞ │
└─────┘                  └───┘
  ▲                        ▲
  │                        │
  Extension badge:         Category icon:
  - Uppercase ext          - Lucide icon, muted
  - text-[10px] font-bold  - h-3.5 w-3.5
  - bg-foreground/8        - text-muted-foreground/50
  - px-1.5 py-0.5          - Decorative only
  - rounded-sm
```

### Bottom Zone Detail

```
  723_-_Garden...          ← text-[11px] font-semibold, truncate, text-foreground
  14 KB                    ← text-[10px] text-muted-foreground
```

During upload, the size line shows progress instead:

```
  723_-_Garden...          ← opacity-60 while uploading
  2%                       ← text-[10px] text-muted-foreground tabular-nums
  ━━━░░░░░░░░░░░░░░░░░░░  ← Progress bar at bottom edge
```

### Remove Button (Input Field Only)

```
         ┌──────────────────────────────┐
         │  ┌─────┐            ╭───╮    │
         │  │ CSV │            │ × │    │  ← 16px circle, appears on hover
         │  └─────┘      ┌───┐╰───╯    │     bg-foreground/80, text-background
         │               │ ⊞ │         │     positioned top-right with small offset
         │               └───┘         │
         │                              │
         │  723_-_Gar...                │
         │  14 KB                       │
         └──────────────────────────────┘
```

- Only in input field context (never in chat messages)
- Only when upload is complete (never during active upload)
- Fades in on card hover (`opacity-0 group-hover:opacity-100`)
- Small circular button: `w-4 h-4 rounded-full`

### Hover State

Non-media cards darken slightly on hover:

- Border: `border-border` → `border-border/80` (or equivalent subtle darkening)
- Background: `bg-muted/30` → `bg-muted/50`
- Transition: `transition-colors duration-150`

### Progress Bar

When uploading, a thin bar appears at the very bottom of the card:

```
  ┌──────────────────────────────┐
  │          (card content)       │
  │                               │
  │  ━━━━━━━━━━━░░░░░░░░░░░░░░░ │  ← h-0.5, absolute bottom-0
  └──────────────────────────────┘
       ▲               ▲
       │               │
    bg-foreground    bg-muted
    (filled)         (track)
```

- Track: full width, `bg-muted` (or equivalent)
- Fill: `bg-foreground`, width = progress percentage
- Transition: `transition-all duration-300 ease-out`
- Hugs the bottom border-radius of the card

### Error State

On upload error, the card gets a destructive tint:

```
  ┌──────────────────────────────┐
  │  ┌─────┐              ┌───┐ │
  │  │ CSV │              │ ⚠ │ │  ← AlertCircle icon replaces category icon
  │  └─────┘              └───┘ │
  │                              │
  │  723_-_Gar...                │
  │  Error                       │  ← "Error" in text-destructive
  └──────────────────────────────┘
```

- Border: `border-destructive/40`
- Background: `bg-destructive/5`
- Error icon: `AlertCircle` from lucide-react in `text-destructive`

### Category Icon Mapping

Use the existing `getFileIcon()` from `file-type-utils.ts` — these are already correct Lucide icons per file category. In addition to the icon, here are the extension badge labels — just use the raw file extension uppercased (e.g., `CSV`, `PDF`, `TXT`, `JSON`, `XLSX`, `PY`, `TS`). Files with no extension show a generic `FILE` label.

---

## Implementation

### 1. Create a shared `FileCard` component

**New file: `src/components/file-card.tsx`**

This is the single source of truth for file card rendering, used by both the chat message view and the input attachment list.

```typescript
interface FileCardProps {
  /** Display filename (used for extension extraction and display) */
  filename: string;
  /** File size in bytes — shown as human-readable (e.g., "14 KB") */
  fileSize?: number;
  /** Content type hint for category detection */
  contentType?: string;
  /** Upload progress 0-100. When present, card is in "uploading" state. */
  uploadProgress?: number;
  /** Upload status. Omit for read-only (in-chat) usage. */
  uploadStatus?: 'uploading' | 'complete' | 'error';
  /** Error message for failed uploads */
  uploadError?: string;
  /** Called when the remove button is clicked. Only rendered when provided. */
  onRemove?: () => void;
  /** Called when the card is clicked (e.g., to open a preview). */
  onClick?: () => void;
  className?: string;
}
```

**Rendering logic:**

```tsx
function FileCard({ filename, fileSize, contentType, uploadProgress, uploadStatus, uploadError, onRemove, onClick, className }: FileCardProps) {
  const ext = getFileExtension(filename).toUpperCase() || 'FILE';
  const category = getFileCategory(filename, contentType);
  const Icon = getFileIcon(category);
  const isUploading = uploadStatus === 'uploading';
  const isError = uploadStatus === 'error';
  const showRemove = Boolean(onRemove) && !isUploading;

  return (
    <div className="group/card relative">
      {/* The card itself */}
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={cn(
          // Fixed square + layout
          'relative flex h-[88px] w-[88px] flex-col justify-between overflow-hidden rounded-lg border p-2 text-left',
          // Default styling
          'border-border bg-muted/30',
          // Hover (non-error)
          !isError && 'transition-colors duration-150 hover:border-border/80 hover:bg-muted/50',
          // Error styling
          isError && 'border-destructive/40 bg-destructive/5',
          // Clickable cursor
          onClick && 'cursor-pointer',
          className
        )}
        aria-label={`${filename}${isError ? ' (upload failed)' : ''}`}
      >
        {/* ── Top zone: extension badge + category icon ── */}
        <div className="flex items-start justify-between">
          {/* Extension badge */}
          <span className="rounded-sm bg-foreground/8 px-1.5 py-0.5 text-[10px] font-bold leading-none text-foreground">
            {ext}
          </span>
          {/* Category icon (or error icon) */}
          {isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Icon className="h-3.5 w-3.5 text-muted-foreground/50" />
          )}
        </div>

        {/* ── Bottom zone: filename + size/progress ── */}
        <div className="min-w-0">
          <p className={cn(
            'truncate text-[11px] font-semibold leading-tight text-foreground',
            isUploading && 'opacity-60'
          )}>
            {filename}
          </p>
          <p className="text-[10px] leading-tight text-muted-foreground tabular-nums">
            {isError
              ? <span className="text-destructive">Error</span>
              : isUploading
                ? `${Math.round(uploadProgress ?? 0)}%`
                : fileSize != null
                  ? formatFileSize(fileSize)
                  : null}
          </p>
        </div>

        {/* ── Progress bar (uploading only) ── */}
        {isUploading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
            <div
              className="h-full bg-foreground transition-all duration-300 ease-out"
              style={{ width: `${Math.max(0, Math.min(100, uploadProgress ?? 0))}%` }}
            />
          </div>
        )}
      </button>

      {/* ── Remove button (hover-only, input field context) ── */}
      {showRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover/card:opacity-100"
          aria-label={`Remove ${filename}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
```

Move the existing `formatFileSize` helper from `attachment-list.tsx` into this file (or into a shared util) so both components can use it.

**Imports needed:**
- `X`, `AlertCircle` from `lucide-react`
- `cn` from `@/lib/utils`
- `getFileExtension`, `getFileCategory`, `getFileIcon` from `@/components/chat-file-preview/file-type-utils`

### 2. Update `FilePreviewChip` to use `FileCard` for non-image files

**File: `src/components/chat-file-preview/file-preview-chip.tsx`**

Currently the non-image branch renders a `160px`-wide rectangle with an icon box + filename. Replace it with `FileCard`.

**Changes:**

Add a `fileSize` prop to `FilePreviewChipProps`:
```typescript
export interface FilePreviewChipProps {
  filename: string;
  previewUrl: string;
  contentType?: string;
  className?: string;
  previewTarget?: PreviewTarget;
  fileSize?: number;  // NEW — pass through from upload refs
}
```

Replace the non-image return block (lines 74–103) with:

```tsx
return (
  <>
    <FileCard
      filename={filename}
      fileSize={fileSize}
      contentType={contentType}
      onClick={handleOpen}
      className={className}
    />
    {!shouldUseChatPanel && (
      <FilePreviewPopover
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        filename={filename}
        previewUrl={previewUrl}
        contentType={contentType}
      />
    )}
  </>
);
```

**Image rendering stays unchanged** — images already render as square thumbnails.

### 3. Update `AttachmentList` to use `FileCard`

**File: `src/components/attachment-list.tsx`**

Replace the current horizontal pill chips with `FileCard` instances.

**Replace the entire inner rendering** (the `<div>` per attachment, lines 37–90) with:

```tsx
<div className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}>
  {attachments.map((attachment) => {
    const isImage = isImageFile(attachment.name, attachment.contentType);

    // Image attachments get a square thumbnail preview
    if (isImage && attachment.status === 'complete') {
      return (
        <div key={attachment.id} className="group/card relative">
          <div className="h-[88px] w-[88px] overflow-hidden rounded-lg border border-border bg-muted/30">
            <img
              src={attachment.previewUrl ?? attachment.path}
              alt={attachment.name}
              className="h-full w-full object-cover"
            />
          </div>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover/card:opacity-100"
            aria-label={`Remove ${attachment.name}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      );
    }

    // Non-image files (and images still uploading) use FileCard
    return (
      <FileCard
        key={attachment.id}
        filename={attachment.name}
        fileSize={attachment.size}
        contentType={attachment.contentType}
        uploadStatus={attachment.status}
        uploadProgress={attachment.progress}
        uploadError={attachment.error}
        onRemove={() => onRemove(attachment.id)}
      />
    );
  })}
</div>
```

This completely replaces the old pill-chip rendering. The `AttachmentList` component now imports `FileCard` and `isImageFile` instead of `File`, `Loader2`, and `Progress`.

The `formatFileSize` function can be removed from this file (it moves to `file-card.tsx` or a shared util).

### 4. Add `previewUrl` to the Attachment interface (optional)

**File: `src/components/attachment-list.tsx`**

For image thumbnail previews in the input field, the `Attachment` interface may need a `previewUrl` field. If images already have a usable `path`, this can be used directly. Otherwise, add:

```typescript
export interface Attachment {
  // ... existing fields ...
  previewUrl?: string; // Client-side blob URL for image preview
}
```

Check wherever `Attachment` objects are created (likely in Chat.tsx's upload handler) — if images already generate a preview URL or blob URL, thread it through. If not, create one with `URL.createObjectURL(file)` during upload initiation. This is an optional enhancement; the core card redesign works without it (image attachments in the input will just use the `FileCard` treatment until upload completes).

### 5. Pass `fileSize` through `FilePreviewChip` in `message-bubble.tsx`

**File: `src/components/message-bubble.tsx`**

Currently, `FilePreviewChip` in the message bubble doesn't receive a `fileSize` prop. The upload ref parser (`parseUploadRefs`) doesn't extract file size — the size isn't available in the message text.

**Two options:**

**Option A (simpler, recommended):** Show no file size in the in-chat cards. The `FileCard` already handles `fileSize` being undefined — it simply doesn't render the size line. The card still looks good with just the extension badge, icon, and filename.

**Option B (enhancement, can defer):** Fetch file metadata (HEAD request to the upload URL) to get `Content-Length`, and pass it through. This adds complexity and latency. Not recommended for the initial implementation.

For now, no changes needed in `message-bubble.tsx` beyond the `FilePreviewChip` prop update (which is backwards-compatible — `fileSize` is optional).

### 6. Adjust image thumbnail size in `FilePreviewChip`

**File: `src/components/chat-file-preview/file-preview-chip.tsx`**

The image branch currently renders at `120px x 120px`. To make the grid perfectly uniform with the new `88px` file cards, consider changing images to `88px x 88px` as well. This is a judgment call — `120px` images are nice for visual richness, but `88px` makes everything uniform.

**Recommendation:** Keep images at `120px x 120px`. The slight size difference between image thumbnails and file cards is actually desirable — images are richer content and deserve more space. The prototype screenshot also shows images larger than file cards. Only change this if strict uniformity is preferred.

---

## Files to Modify (Summary)

| File | Change |
|------|--------|
| `src/components/file-card.tsx` | **New** — shared square file card component |
| `src/components/chat-file-preview/file-preview-chip.tsx` | Use `FileCard` for non-image files; add optional `fileSize` prop |
| `src/components/attachment-list.tsx` | Replace pill chips with `FileCard`; add image thumbnail support |
| `src/components/chat-file-preview/file-type-utils.ts` | No changes needed — already has all needed utilities |
| `src/components/message-bubble.tsx` | No changes needed (props are backwards-compatible) |

## Components Used

- `cn()` from `@/lib/utils` — conditional class merging
- `getFileExtension`, `getFileCategory`, `getFileIcon`, `isImageFile` from `@/components/chat-file-preview/file-type-utils` — existing file utilities
- `X`, `AlertCircle` from `lucide-react` — icons
- No new shadcn/ui components needed — the card is custom-styled with Tailwind using design tokens (`border-border`, `bg-muted`, `text-foreground`, etc.)
- The shadcn `Progress` component is **no longer needed** in `attachment-list.tsx` — replaced by the custom bottom-edge progress bar in `FileCard`

## Not in Scope

- **Image/SVG preview squares** — already render correctly as squares; no changes needed
- **File preview popover/dialog** — click-to-preview behavior stays the same
- **Upload flow mechanics** — the actual upload API (multipart R2) is unchanged; only the visual representation changes
- **File size in chat messages** — upload refs in message text don't include file size; the card gracefully handles missing size
- **Dark mode** — all styles use design tokens (`border-border`, `bg-muted`, `text-foreground`) which automatically adapt to the active theme
