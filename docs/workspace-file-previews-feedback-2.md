# File Previews — Feedback Round 2

One change: fix the image chip to be a fixed 120x120 square.

---

## Image chip should be a fixed 120x120 square thumbnail

### What's wrong

The image chip currently uses `max-h-[180px] max-w-[240px]` on the `<img>`, which lets the image render at its natural size up to those bounds. For large images (especially SVGs which have no intrinsic pixel size), this produces an oversized preview.

### Fix

Make the image chip a fixed 120x120 square. The image should fill the square using `object-cover` (center-crop), so regardless of the image's aspect ratio, the chip is always exactly 120x120.

**File:** `src/components/chat-file-preview/file-preview-chip.tsx`

Change the image branch (lines 30-46) — apply the fixed size on the **button** wrapper, not the img:

```tsx
<button
  type="button"
  onClick={() => setPreviewOpen(true)}
  className={cn(
    'h-[120px] w-[120px] overflow-hidden rounded-lg transition-opacity hover:opacity-90',
    className
  )}
  aria-label={`Open preview for ${filename}`}
>
  <img
    src={previewUrl}
    alt={filename}
    loading="lazy"
    className="h-full w-full object-cover"
    onError={() => setImageError(true)}
  />
</button>
```

The button is the fixed 120x120 box with `overflow-hidden` and `rounded-lg`. The image fills it completely with `h-full w-full object-cover`, which center-crops to fill the square regardless of the source aspect ratio.
