# @ Mention Menu — Iteration 3 Feedback

**Date:** 2026-04-30
**Branch:** `illianaa/at-menu-connections`
**Reviewing commit:** `9b900635 Iterate on @-mention menu based on feedback`

---

## Summary

The composer chip is rendering with subtle background and the menu now sits above the textarea. Five issues remain — one critical (caret drift), two interaction bugs, one truthfulness concern, and one quick cleanup.

| # | Severity | Issue |
|---|---|---|
| 1 | **Critical** | Caret in textarea drifts behind the visible text after every chip. Root cause: chip uses heavier weight + asymmetric padding/margin that shift overlay glyph positions away from the underlying textarea. |
| 2 | **Bug** | Arrow-key navigation past the visible window in the @ menu doesn't auto-scroll the highlighted item into view. |
| 3 | **Bug** | Double-clicking a chip in the textarea selects the chip's text in the *overlay* (not the textarea), so backspace can't delete it. |
| 4 | **Concern** | "Ready" status indicator overstates what we know. `has_credentials` only tells us the user filled the form, not that the connection is healthy. |
| 5 | **Cleanup** | Remove integration icon from sent-message chip — icon should only appear in the menu and the hover popover. |

---

## Issue 1 — Caret drifts behind text after a chip (CRITICAL)

The screenshot shows the caret rendered ~one character to the left of where typed input lands. The drift is cumulative: each chip on a line adds a few pixels of misalignment between overlay glyphs and textarea glyphs. By end-of-line the caret is visibly behind.

### Root cause

The transparent-text-overlay technique requires **glyph-for-glyph identical advance widths** between the textarea and the overlay. Three things in `composer-mention-overlay.tsx:21-23` violate that:

```ts
const COMPOSER_CHIP_CLASS =
  'pointer-events-auto rounded-md bg-muted px-1 py-0 -mx-0.5 ' +
  'font-semibold text-foreground';
```

| Class | What it does | Effect on alignment |
|---|---|---|
| `font-semibold` | Heavier weight — semibold glyphs render wider per character than normal | Chip text in overlay is wider than `@bigquery` in the textarea → everything after the chip is pushed right in the overlay → caret (textarea-positioned) lags |
| `px-1` | 4px horizontal padding | Adds 8px to chip's box width that the textarea has no equivalent of |
| `-mx-0.5` | -2px horizontal margin | Pulls back 4px total — partially compensates `px-1` but leaves a net +4px and asymmetric box-model |

The `-mx-0.5` was an attempt to absorb the padding back, but it can't — `padding` and `margin` participate in the inline-box layout and **they push surrounding text glyphs**. The textarea, by contrast, has no inline box for the slug — the slug is just plain characters at default font weight.

This is a fundamental constraint of the textarea+overlay pattern: **the chip's box must contribute exactly zero extra width to the line, and its glyphs must use the same font weight as the textarea**. Anything that changes layout (padding, margin, weight, letter-spacing) breaks alignment.

### Fix

Replace the chip class with these exact rules. The trick is to use `box-shadow` instead of `padding` for the visible chip "padding" — `box-shadow` paints outside the element's box without affecting layout:

`src/components/connection-mention-menu/composer-mention-overlay.tsx:21-23`:

```ts
const COMPOSER_CHIP_CLASS =
  // Layout-neutral: zero padding, zero margin, inherit weight from the textarea.
  'pointer-events-auto rounded-sm bg-muted text-foreground ' +
  // The "padding" effect is painted by an outset box-shadow that doesn't
  // affect inline layout. 2px on each side gives the chip breathing room
  // without shifting any glyphs.
  'shadow-[0_0_0_2px_hsl(var(--muted))]';
```

Critical:

- **Drop `font-semibold`** — the textarea renders the same characters in the user agent's default weight (whatever the surrounding `text-base` resolves to). The overlay must inherit that exact weight. If the user wants emphasis, the `bg-muted` highlight already provides it.
- **Drop `px-1`** — zero horizontal padding.
- **Drop `-mx-0.5`** — zero negative margin. The chip's inline box must be exactly the width of the slug glyphs.
- **Replace with `shadow-[0_0_0_2px_hsl(var(--muted))]`** — paints a 2px outset of the chip color around the box. Visually this looks like padding; layout-wise it's free. `box-shadow` follows `border-radius`, so combined with `rounded-sm` you still get rounded corners.
- **`rounded-sm` not `rounded-md`** — slightly tighter radius reads better at the smaller visual size.

If the user still wants the chip to feel a touch more prominent, change the bg color to a slightly stronger token (e.g. `bg-primary/10`) — that doesn't affect layout. **Do not** use any layout-changing property.

### Verification

After the fix, the caret should sit exactly under the next character no matter how many chips are on the line. Test specifically:

1. Type `@bigquery just testing the bigquery integration` — caret stays glued to the end-of-line.
2. Two chips on one line: `@bigquery and @stripe both work` — caret stays correct after both.
3. Wrap at end of viewport: a chip near the wrap point shouldn't break alignment on the next line.

---

## Issue 2 — Arrow keys don't auto-scroll the @ menu

`cmdk` does auto-scroll the active item into view, but only when its own internal keyboard handlers fire. In our setup, keyboard events are intercepted by the textarea (`prompt-input.tsx:handleKeyDown`) and we update `activeId` via the controlled `<Command value={...} onValueChange={...}>` API. The active-item DOM node changes, but cmdk's internal scroll-into-view logic doesn't run for externally-driven value changes.

### Fix

Add a `useEffect` in `connection-mention-menu/index.tsx` that scrolls the active row into view whenever `activeId` changes.

After the existing `useEffect` (around line 56-69), add:

```tsx
const listRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!open || !activeId) return;
  const list = listRef.current;
  if (!list) return;
  // cmdk sets data-value on each CommandItem. Find the active one and bring
  // it into view in the scrolling list container.
  const activeEl = list.querySelector<HTMLElement>(
    `[data-value="${CSS.escape(activeId)}"]`,
  );
  if (activeEl) {
    activeEl.scrollIntoView({ block: 'nearest' });
  }
}, [open, activeId]);
```

Then attach the ref to `<CommandList>`:

```tsx
<CommandList ref={listRef} className="max-h-[200px] py-1">
```

`CommandList` from shadcn forwards refs (verify in `src/components/ui/command.tsx`; if it doesn't, wrap the inner `<div>` you actually want to scroll). `block: 'nearest'` keeps already-visible items where they are and only scrolls when the active item is out of bounds — exactly the desired behavior.

---

## Issue 3 — Backspace can't delete a chip after double-click

### Root cause

`COMPOSER_CHIP_CLASS` includes `pointer-events-auto`. That re-enables pointer events on the overlay chip (necessary for `HoverCard` to detect hover). The side effect: when the user double-clicks the chip, the browser intercepts the click on the overlay's non-editable `<span>` and selects the chip's text in the *overlay layer*. The textarea below never receives the click, so its `selectionStart`/`selectionEnd` don't change, and Backspace deletes (or no-ops) at whatever caret position the textarea last held — usually somewhere irrelevant.

Triple-clicking a line works because the click started outside the chip area (in textarea text) and the drag carried selection through the chip in the textarea's own selection — the chip's pointer-events-auto doesn't block that drag because the mousedown happened in textarea space.

### Fix

Make the chip an "atomic" unit from the user's perspective:

1. **Disable text selection on the chip** so double-click doesn't grab non-editable overlay text.
2. **On click, programmatically select the chip's range in the textarea** so Backspace can delete it natively.

In `composer-mention-overlay.tsx`:

```ts
// 1. Add select-none to the chip class
const COMPOSER_CHIP_CLASS =
  'pointer-events-auto select-none rounded-sm bg-muted text-foreground ' +
  'shadow-[0_0_0_2px_hsl(var(--muted))]';
```

```tsx
// 2. ComposerChip receives the textarea ref + the chip's source-string range,
//    and on click forwards selection to the textarea.
function ComposerChip({
  slug,
  integration,
  textareaRef,
  startIndex,
  endIndex,
}: {
  slug: string;
  integration: Integration;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  startIndex: number;
  endIndex: number;
}) {
  const handlePointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    // Prevent the browser from selecting overlay text and forward selection
    // to the textarea so Backspace, Delete, copy, etc. all "just work".
    e.preventDefault();
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(startIndex, endIndex);
  };

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          className={COMPOSER_CHIP_CLASS}
          onPointerDown={handlePointerDown}
        >
          @{slug}
        </span>
      </HoverCardTrigger>
      <HoverCardContent ... />
    </HoverCard>
  );
}
```

Plumbing change: `renderComposerTokens` already has access to `match.index` and `match.length` — pass `startIndex={match.index}` and `endIndex={match.index + match.length}` into `<ComposerChip>`. Pass `textareaRef` from `prompt-input.tsx` down through `<ComposerMentionOverlay>` to `ComposerChip`.

`ComposerMentionOverlay`'s prop signature becomes:

```tsx
interface ComposerMentionOverlayProps {
  value: string;
  slugMap: Map<string, Integration>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}
```

And the call site in `prompt-input.tsx:497`:

```tsx
<ComposerMentionOverlay value={value} slugMap={slugMap} textareaRef={effectiveTextareaRef} />
```

After this change:

- Single click on a chip selects the chip's full range in the textarea (visible via the existing `selection:bg-primary/30` highlight).
- Backspace deletes the chip (textarea-native edit).
- Cmd-A still works to select all.
- Drag-through-chip still works because mousedown began outside the chip.
- HoverCard still triggers because mouseenter/mouseleave fire on `pointer-events-auto` regardless of `select-none`.

Trailing-space note: the inserted text is `@<slug> ` (with one trailing space). Decide whether clicking the chip should select just `@<slug>` or `@<slug> `. Recommendation: select just `@<slug>` (range = `[match.index, match.index + match.length]`, which excludes the trailing space). That way Backspace deletes the chip but leaves the space, so the user can keep typing where they were. If they Backspace again, the space goes too.

---

## Issue 4 — Drop the "Ready" status indicator

The user is right: `has_credentials` is a write-side flag (creds were submitted) and tells us nothing about connection health. Showing a green "Ready" dot for a connection whose creds are stale, revoked, or pointing at a wrong host is actively misleading.

### Recommendation

Show the indicator **only as a warning**, never as a confirmation. Drop the green dot and "Ready" text entirely. When `has_credentials === false`, show an amber warning. Otherwise show nothing.

`composer-mention-overlay.tsx:62-75` — replace the status row with:

```tsx
{!integration.has_credentials && (
  <div className="flex items-center gap-1.5 text-xs">
    <span className="inline-block size-1.5 rounded-full bg-amber-500" />
    <span className="text-muted-foreground">No credentials configured</span>
  </div>
)}
<div className="text-xs text-muted-foreground">
  Updated {formatRelative(integration.updated_at)}
</div>
```

This way:

- Healthy-looking connection → shows just name, type, and last-updated. No false claim of "Ready."
- Connection missing creds → shows amber warning that's actually true.

If/when the platform adds a real health-check signal (e.g. last-successful-use timestamp, last-error code), revisit and add a positive "Ready" state then. For now, silence is more honest than green.

---

## Issue 5 — Remove integration icon from sent-message chip

Sent-message chip currently includes a small integration icon. Per the user, the icon should only appear in the @ menu and in the hover popover, not inline in the user's sent message.

### Fix

`src/components/connection-mention-menu/mention-chip.tsx`:

```tsx
'use client';

import { cn } from '@/lib/utils';
import type { Integration } from '@/types';

interface MentionChipProps {
  slug: string;
  integration: Integration | null;
}

const CHIP_BASE =
  'inline rounded-sm align-baseline text-[0.95em] font-semibold leading-[inherit] cursor-default';
const CHIP_LIVE = 'bg-muted text-foreground';
const CHIP_DELETED = 'bg-muted/60 text-muted-foreground';

export function MentionChip({ slug, integration }: MentionChipProps) {
  const isDeleted = integration === null;
  return (
    <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
      @{slug}
    </span>
  );
}
```

Changes from current:

- Remove `IntegrationIcon` import and JSX.
- Remove `inline-flex items-center gap-1 px-1 py-0 -mx-0.5` (no longer needs flex layout — single text node).
- Switch to `inline` — chip flows naturally with text.
- Keep `font-semibold` here because this is a static rendered message bubble (no overlay alignment constraint), so the heavier weight is fine.

The `MentionChip` callers in `message-bubble.tsx` and the markdown renderer don't need to change.

---

## Implementation order

1. **Issue 5** — trivial, unblocks visual review of chip.
2. **Issue 1** — caret drift fix. Highest-impact correctness bug.
3. **Issue 3** — chip click-to-select. Builds on Issue 1's chip class.
4. **Issue 2** — menu auto-scroll. Independent.
5. **Issue 4** — "Ready" indicator removal. Tiny, drop in last.

After 1 + 3, manually verify in dev mode by typing a multi-line message with multiple chips, double-clicking a chip, and pressing backspace.

---

## Verification checklist

- [ ] Caret in the textarea sits exactly at the end of typed input, regardless of how many chips precede it on the line.
- [ ] Arrow-down past the bottom-visible row in the @ menu scrolls the menu so the highlighted row is in view.
- [ ] Arrow-up past the top-visible row scrolls back up.
- [ ] Single-click on a chip in the textarea selects `@<slug>` (visible selection highlight); Backspace deletes the chip.
- [ ] Double-click on a chip behaves the same as single-click (range select).
- [ ] Cmd/Ctrl-A still selects everything; Backspace deletes the line.
- [ ] Triple-click selecting a line including a chip + Backspace still works.
- [ ] HoverCard popover still appears on hover.
- [ ] HoverCard popover no longer shows "Ready" when the connection has credentials. Shows "No credentials configured" only when creds are missing.
- [ ] Sent-message chip in a message bubble has no integration icon, just `@<slug>` text on a subtle background.
