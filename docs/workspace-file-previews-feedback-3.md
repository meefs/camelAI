# File Previews — Feedback Round 3

Three issues to fix, ordered by severity.

---

## 1. CRITICAL: Image preview dialog shows infinite spinner

### Problem

When the user clicks to open the preview dialog for an image (SVG or PNG), the spinner shows indefinitely. The download button works, confirming the URL is valid — the image just never renders.

### Root cause

The `<img>` on line 139-152 of `file-preview-popover.tsx` still has `className={cn("...", mediaLoading && "hidden")}`. The previous fix attempt changed `hidden` to something else, but looking at the current code it's still using `hidden`.

The real problem is deeper: **Radix Dialog renders content lazily.** When `open` transitions to `true`, the `useLayoutEffect` on line 89 fires and sets `mediaLoading = true` synchronously. But the `DialogContent` is portal-mounted by Radix, and the `<img>` element may not yet be in the DOM at that point. Even when it does mount, `hidden` (which is `display: none`) prevents some browsers from initiating the image load at all, so `onLoad` never fires.

### Fix

**Remove the loading state machinery for images entirely.** Replace it with a much simpler approach: use an `<img>` that is always visible, and overlay a spinner on top that disappears when the image loads.

In `file-preview-popover.tsx`, for the image preview section (lines 131-154):

```tsx
{previewType === 'image' && (
  <ImagePreview
    src={previewUrl}
    alt={filename}
  />
)}
```

Extract the image preview into a small local component within the same file. This component manages its own state and avoids the timing issues with the parent `useLayoutEffect`:

```tsx
function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [src]);

  return (
    <div className="flex min-h-[200px] items-center justify-center relative">
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <p className="text-sm text-muted-foreground">Failed to load image.</p>
      )}
      {!error && (
        <img
          src={src}
          alt={alt}
          className={cn(
            "max-h-[60vh] w-full object-contain transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
}
```

Key differences from current approach:
- **`opacity-0` instead of `hidden`** — the image is always in the layout, always loading, just invisible until ready. Browsers will load `opacity-0` images.
- **Self-contained state** — no dependency on the parent `useLayoutEffect` timing. The component mounts when Dialog renders, and that's when state begins.
- **No `loading="lazy"`** — remove this attribute. The dialog is opened intentionally by the user; the image should start loading immediately. `lazy` can delay loads for off-screen content, which a dialog technically is until the portal mounts.

Also remove the `mediaLoading`/`mediaError` state and the `useLayoutEffect` from the parent component if images were the only type using it. If PDF/audio/video still use those states, keep them but exclude the `'image'` case from the `useLayoutEffect` condition.

---

## 2. File uploads don't show previews until page refresh

### Problem

When a user attaches a file (one or more) and sends a message, the preview chips don't render. After refreshing the page, the previews appear correctly. This affects all file uploads, not just multiple files.

### Root cause

In `Chat.tsx` lines 2022-2031, the optimistic user message is constructed with only `userMessage` (the typed text), not `finalContent` (which includes the upload refs):

```typescript
const userMsg: Message = {
  id: `local_${Date.now()}`,
  thread_id: threadId,
  role: 'user',
  content: userMessage,        // ← just the typed text, no file refs
  created_at: Date.now(),
  sentDuringStreaming: wasSentDuringStreaming,
};
```

Meanwhile `finalContent` (which has the `(user uploaded file to ...)` lines) is only sent over the WebSocket. So the optimistic message rendered immediately has no upload refs for `parseUploadRefs()` to find. On refresh, the server returns the full message content (with upload refs), so previews appear.

### Fix

Use `finalContent` for the optimistic message content, not `userMessage`:

```typescript
const userMsg: Message = {
  id: `local_${Date.now()}`,
  thread_id: threadId,
  role: 'user',
  content: finalContent,       // ← includes file refs so previews render
  created_at: Date.now(),
  sentDuringStreaming: wasSentDuringStreaming,
};
```

This is safe because `parseUploadRefs()` in `message-bubble.tsx` strips the upload text before rendering — the user will see the preview chips plus their clean message text, not the raw `(user uploaded file to ...)` strings.

Apply the same fix to the `startNewChat` function (around line 1728). Currently the new-chat path stores `finalContent` in a ref but it should also use `finalContent` in whatever optimistic message it creates.

---

## 3. Text preview overflows the dialog horizontally

### Problem

When previewing a text file with long lines (like SQL queries), the `<pre>` block's content extends beyond the dialog's right edge. The dialog should have a fixed width with scrollable content.

### Root cause

The `<pre>` element on line 248 has `overflow-auto` which should handle this, but `<pre>` has `white-space: pre` by default, and the dialog's content area has no `overflow-hidden` to clip children. The `DialogContent` base class uses `grid` layout which can allow children to overflow in some cases, and there's no `min-w-0` or `overflow-hidden` on the content wrapper.

### Fix

Two changes in `file-preview-popover.tsx`:

**a)** Add `overflow-hidden` to the dialog body wrapper (the `<div className="p-4">` on line 130):

```tsx
<div className="overflow-hidden p-4">
```

This ensures no child can push beyond the dialog bounds.

**b)** Ensure the `<pre>` constrains its width. Add `w-full min-w-0` to the `<pre>`:

```tsx
<pre
  className={cn(
    'w-full min-w-0 max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs',
    textPreview ? 'text-foreground' : 'text-muted-foreground'
  )}
>
```

`min-w-0` prevents the `<pre>` from sizing to its intrinsic content width inside the grid/flex context. `overflow-auto` then enables horizontal scrolling within the `<pre>` for long lines.

These are standard CSS techniques — no custom component work needed. The shadcn `DialogContent` is being used correctly; the issue is just that `<pre>` has unusual default sizing behavior (`white-space: pre` makes it as wide as its longest line) and needs `min-w-0` to participate properly in the flex/grid layout.
