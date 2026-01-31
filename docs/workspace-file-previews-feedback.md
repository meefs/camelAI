# File Previews — Implementation Feedback

Two changes needed from the current implementation.

---

## 1. Move upload previews outside the user message bubble, and make image chips borderless

### What's wrong

Upload preview chips currently render **inside** the user message bubble (the `rounded-3xl border border-border bg-muted/30` container). They should render **above** and **outside** that bubble, as a separate visual element.

Additionally, for image files, the chip currently wraps the thumbnail in a bordered card with the filename below it. For images, we want the image itself to **be** the entire chip — no border, no filename label, no container chrome. Just the image, with rounded corners. The filename should only appear when the user clicks through to the preview dialog.

### Current layout (simplified)

```
                              ┌─ user bubble ────────────────────────┐
                              │ ┌───────────┐                       │
                              │ │  (image)  │                       │
                              │ │ photo.png │  ← inside bubble      │
                              │ └───────────┘                       │
                              │                                     │
                              │ Hey can you analyze this?           │
                              └─────────────────────────────────────┘
```

### Target layout

```
                                            ┌──────────┐
                                            │          │
                                            │ (image)  │  ← outside bubble, no border/name
                                            │          │
                                            └──────────┘
                              ┌─ user bubble ────────────────────────┐
                              │ Hey can you analyze this?           │
                              └─────────────────────────────────────┘
```

For non-image files, the existing card style (border + icon + filename) is fine — just move it outside the bubble too.

### Changes required

**`src/components/message-bubble.tsx`** — In the user message block (around line 332-353):

Move the `previewRefs` rendering **above** the `<div className="max-w-[85%] ... rounded-3xl border ...">` bubble, not inside it. The outer container is the `<div className="flex flex-col items-end gap-1">` — put the previews there, between that wrapper and the bubble div. Use a small gap (e.g. `gap-1.5` or `gap-2` on the outer flex-col).

If `cleanedContent` is empty after stripping upload refs (user sent only a file with no text), don't render the message bubble at all — just the preview chips.

**`src/components/chat-file-preview/file-preview-chip.tsx`** — Two rendering modes:

- **Image files:** Render just the `<img>` with `rounded-lg overflow-hidden` and a max-width/max-height constraint (e.g. `max-w-[240px] max-h-[180px]`). No border container, no filename text. The image should feel like an inline media preview, similar to iMessage or WhatsApp. On error, fall back to the non-image card style.

- **Non-image files:** Keep the current card layout (border + icon + filename). No changes.

Add an `onClick` handler to both variants. When the user clicks an image preview, it opens the `FilePreviewPopover` dialog where they can see the full image plus filename and download button.

To wire that up, `FilePreviewChip` needs to either manage its own dialog state, or accept props for it. The simplest approach: give it internal `useState` for the dialog, render `FilePreviewPopover` inside the component, and open it on click. This avoids prop-drilling from `message-bubble.tsx`.

Rough sketch for the image variant:

```tsx
// Image chip (no card chrome)
<>
  <button
    type="button"
    onClick={() => setPreviewOpen(true)}
    className="overflow-hidden rounded-lg hover:opacity-90 transition-opacity"
  >
    <img
      src={previewUrl}
      alt={filename}
      loading="lazy"
      className="max-w-[240px] max-h-[180px] object-cover"
      onError={() => setImageError(true)}
    />
  </button>
  <FilePreviewPopover
    open={previewOpen}
    onOpenChange={setPreviewOpen}
    filename={filename}
    previewUrl={previewUrl}
  />
</>
```

---

## 2. Add a loading state to the preview dialog

### What's wrong

When the user clicks a temporary file link (in a tool call) or an image preview chip, the `FilePreviewPopover` dialog opens immediately but the content (image, PDF iframe, etc.) can take a moment to load. During that time the dialog body is blank, which feels broken.

### Fix

Add a loading spinner that displays while the content is loading. The text preview type already has a loading state (`textStatus === 'loading'`). Apply the same pattern to image, PDF, audio, and video.

For **images**, track loading with an `onLoad` callback on the `<img>`:

```tsx
const [imageLoaded, setImageLoaded] = useState(false);
const [imageError, setImageError] = useState(false);

// Reset when URL changes
useEffect(() => {
  setImageLoaded(false);
  setImageError(false);
}, [previewUrl]);

// In render:
{previewType === 'image' && (
  <div className="flex items-center justify-center min-h-[200px]">
    {!imageLoaded && !imageError && (
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    )}
    {imageError && (
      <p className="text-sm text-muted-foreground">Failed to load image.</p>
    )}
    <img
      src={previewUrl}
      alt={filename}
      className={cn(
        "max-h-[60vh] w-full object-contain",
        !imageLoaded && "hidden"
      )}
      loading="lazy"
      onLoad={() => setImageLoaded(true)}
      onError={() => setImageError(true)}
    />
  </div>
)}
```

For **PDF and video/audio**, a similar approach works but browser-native elements don't have reliable `onLoad` events. A reasonable approach: show the spinner for a brief moment (e.g. 300ms via `setTimeout`) then hide it, since the iframe/player will show its own loading chrome. Or simply don't add loading states for those — the image loading state is the most impactful since images are the most common preview type and have no built-in loading indicator.

**File to change:** `src/components/chat-file-preview/file-preview-popover.tsx`

Import `Loader2` from `lucide-react` (already available in the project).
