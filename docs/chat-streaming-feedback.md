# Chat Streaming Implementation — Review Feedback

**February 28, 2026**

---

## Overall Assessment

Part 1 (streaming action flicker fix) is implemented correctly — the `!isStreaming` guard was removed, the comment was updated. No notes.

Part 2 (collapsible user messages) is structurally correct but needs three changes to the `CollapsibleUserMessage` component.

---

## Change 1: Replace gradient overlay with text opacity fade

**Problem:** The current gradient overlay (`bg-gradient-to-t from-muted/80 to-transparent`) sits on top of the content as a colored mask. This looks like a colored film over the text rather than the text itself naturally fading out. The muted color also doesn't blend perfectly with the bubble background in all themes.

**Goal:** Make the *text itself* fade out in opacity. The last ~5-10% of visible content should go from full opacity to near-transparent, so it looks like the words are dissolving rather than being covered by a colored sheet.

```
Current (gradient overlay):             Desired (text opacity fade):
┌──────────────────────────┐            ┌──────────────────────────┐
│ Error: Cannot find...    │            │ Error: Cannot find...    │
│   at Module._load        │            │   at Module._load        │
│ ░░░░░░░░░░░░░░░░░░░░░░░░│ ← colored  │   at Module.require      │ ← full opacity
│ ░░░ Show more ▾ ░░░░░░░░│   overlay  │   at require (inter ··   │ ← fading out
│ ░░░░░░░░░░░░░░░░░░░░░░░░│            │        Show more ▾       │ ← nearly invisible text behind
└──────────────────────────┘            └──────────────────────────┘
```

**Implementation:** Use a CSS mask on the content container instead of a gradient overlay div. When collapsed, apply a `mask-image` that is fully opaque for the top ~90% and fades to transparent over the bottom ~10%.

```tsx
// Replace the inline style on the content div:

// BEFORE
style={!isExpanded && isOverflowing ? { maxHeight: MAX_COLLAPSED_HEIGHT } : undefined}

// AFTER
style={!isExpanded && isOverflowing ? {
  maxHeight: MAX_COLLAPSED_HEIGHT,
  maskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)',
} : undefined}
```

Then remove the gradient overlay div entirely (lines 53-63 of `collapsible-user-message.tsx`). The "Show more" button should be repositioned — instead of sitting inside the gradient overlay, position it absolutely at the bottom of the container:

```tsx
{/* Show more button — replaces the gradient overlay div */}
{!isExpanded && isOverflowing && (
  <div className="flex justify-center -mt-1">
    <button
      type="button"
      onClick={() => setIsExpanded(true)}
      className="..." // see Change 2 for button styling
    >
      Show more
      <ChevronDown className="h-3 w-3" />
    </button>
  </div>
)}
```

Note: The button moves from being absolutely positioned inside a gradient to being in normal flow *below* the masked content div. This is simpler and avoids the `pointer-events-none` / `pointer-events-auto` dance.

---

## Change 2: Make the "Show more" button more boxy and full opacity

**Problem:** The current button uses `rounded-full` (pill shape) and `text-muted-foreground` (faded text). It should be more rectangular and the text should be fully visible.

**Current button classes:**
```
rounded-full border border-border/50 bg-background/80 px-3 py-1 text-xs text-muted-foreground
```

**Updated button classes:**
```
rounded-md border border-border/50 bg-background/80 px-3 py-1 text-xs text-foreground
```

Changes:
- `rounded-full` → `rounded-md` (boxy with slight rounding, not a pill)
- `text-muted-foreground` → `text-foreground` (full opacity text)
- Keep `backdrop-blur-sm` for readability over faded text
- Keep `hover:text-foreground` but since base is already `text-foreground`, change hover to `hover:bg-accent` for a subtle hover feedback

**Show more button (collapsed):**
```tsx
<button
  type="button"
  onClick={() => setIsExpanded(true)}
  className="flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent backdrop-blur-sm"
>
  Show more
  <ChevronDown className="h-3 w-3" />
</button>
```

**Show less button (expanded):** Also update for consistency — use `text-muted-foreground` is OK here since it's less prominent, but keep the boxy shape:
```tsx
<button
  type="button"
  onClick={handleCollapse}
  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground hover:bg-accent"
>
  Show less
  <ChevronDown className="h-3 w-3 rotate-180" />
</button>
```

---

## Change 3: Add snappy expand/collapse animation

**Problem:** Currently `maxHeight` snaps between `300px` and `undefined` with no transition. This feels jarring.

**Goal:** A fast, snappy animation (150-200ms) when expanding and collapsing. Not a slow reveal — just enough to feel smooth rather than instant.

**Implementation:** Use a measured-height approach. When expanding, measure the full `scrollHeight` and transition `maxHeight` from `300px` to that value. When collapsing, transition from the current `scrollHeight` back to `300px`. After the expand transition ends, remove `maxHeight` entirely so the content can reflow naturally.

Add state for the measured height and transition handling:

```tsx
const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
const [isAnimating, setIsAnimating] = useState(false);

const handleExpand = () => {
  const el = contentRef.current;
  if (!el) return;
  // Measure full height before expanding
  setMeasuredHeight(el.scrollHeight);
  setIsAnimating(true);
  // Force a layout read so the browser registers the starting maxHeight
  // before we change it (required for CSS transition to fire)
  el.getBoundingClientRect();
  setIsExpanded(true);
};

const handleCollapse = () => {
  const el = contentRef.current;
  if (!el) return;
  // Set maxHeight to current scroll height first so we have a start value
  setMeasuredHeight(el.scrollHeight);
  setIsAnimating(true);
  // Force layout
  el.getBoundingClientRect();
  setIsExpanded(false);
  requestAnimationFrame(() => {
    contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
};
```

Handle transition end to clean up:
```tsx
const handleTransitionEnd = () => {
  setIsAnimating(false);
  if (isExpanded) {
    setMeasuredHeight(null); // Remove maxHeight so content reflows naturally
  }
};
```

Update the content div's style:
```tsx
<div
  ref={contentRef}
  className={cn(
    !isExpanded && isOverflowing && 'overflow-hidden',
    isAnimating && 'overflow-hidden'
  )}
  style={{
    ...(!isExpanded && isOverflowing ? {
      maxHeight: MAX_COLLAPSED_HEIGHT,
      maskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)',
      WebkitMaskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)',
    } : {}),
    ...(isAnimating ? {
      maxHeight: isExpanded ? measuredHeight ?? undefined : MAX_COLLAPSED_HEIGHT,
      transition: 'max-height 150ms ease-out',
    } : {}),
    // When expanded and not animating, no maxHeight at all
    ...(isExpanded && !isAnimating ? {} : {}),
  }}
  onTransitionEnd={handleTransitionEnd}
>
```

The mask should also animate out when expanding. During the expand animation, transition the mask from the fade to fully opaque:
```tsx
// Add to the style object when animating expand:
...(isAnimating && isExpanded ? {
  maskImage: 'linear-gradient(to bottom, black 100%, black 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, black 100%, black 100%)',
  transition: 'max-height 150ms ease-out, mask-image 100ms ease-out',
} : {}),
```

**Key details:**
- Duration: `150ms` — fast and snappy, not sluggish
- Easing: `ease-out` — starts fast, decelerates naturally
- The mask-image transition is slightly faster (100ms) so text becomes fully visible before the height finishes expanding
- After expand animation completes, `maxHeight` is removed entirely (via `setMeasuredHeight(null)`) so content can reflow if the window resizes
- `overflow-hidden` stays on during animation to prevent content from spilling out

---

## Summary of All Changes

All changes are in `src/components/collapsible-user-message.tsx`:

| # | Change | What to modify |
|---|--------|----------------|
| 1 | Text opacity fade via CSS mask | Replace gradient overlay div with `maskImage` on content div |
| 2 | Boxy button with full opacity text | `rounded-full` → `rounded-md`, `text-muted-foreground` → `text-foreground` |
| 3 | Snappy expand/collapse animation | Add measured-height transition (150ms ease-out) with `onTransitionEnd` cleanup |

No changes needed to `message-bubble.tsx` — the integration wrapper is correct as-is.
