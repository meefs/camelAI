# Sidebar Animation Polish — Implementation Feedback

**July 14, 2026** · Review of the working-tree implementation of `docs/sidebar-animation-polish-plan.md`

---

## TL;DR

The implementation is faithful to the plan and verified green: `bun run typecheck` clean, 104/104 tests passing across `tests/chat-groups-recency.test.ts`, `tests/use-flip-list.test.tsx`, `tests/chat-groups-ui.test.tsx`. The reorder data flow, FLIP hook, and pin logic are correct — do not rework them.

Two user-reported issues need fixes, both in the toggle polish surface:

1. **Chat-group avatar sits low (bottom-ish aligned) next to its text in the expanded sidebar.** Root cause: the invisible 24px collapsed-avatar layer inflates the icon wrapper's grid track past the 20px wrapper. Two-utility fix in `ChatGroupIcon`.
2. **The collapse/expand still flashes at the separators** because the discrete `display` toggle inserts/removes the separator's ~9px layout box mid-animation, shifting everything below it. Fix is structural, and *simpler* than what's there: replace the discrete-transition machinery with a **zero-height overlay hairline** whose only animatable property is opacity — toggling then cannot change layout, by construction.

---

## Fix 1 — avatar centering in the expanded state (required)

**File: `src/components/sidebar/chat-groups-list.tsx`, `ChatGroupIcon` wrapper (~line 113).**

### Root cause

The wrapper is `grid size-5` (20px) in the expanded state, and its two stacked children are the `sm` avatar (20px) and the always-mounted collapsed layer, which is `size-6` (24px, `opacity-0` when expanded). A grid's implicit track sizes to its largest item → the single cell is **24px inside a 20px box**. Overflowing grid content anchors to the start edge, so the track spans the wrapper's top-left to 4px past its bottom-right, and `place-items-center` centers items **within that track**, not the wrapper: the visible small avatar lands 2px low and 2px right. In the collapsed state the wrapper is 24px, the track fits exactly, so it centers — which is why the bug only shows expanded.

### Fix

Pin the explicit track to the wrapper's box so `place-items-center` always centers against the wrapper, in every state and continuously during the 20px→24px morph. Add `grid-cols-[100%] grid-rows-[100%]` to the wrapper — full class string:

```
relative grid size-5 shrink-0 grid-cols-[100%] grid-rows-[100%] place-items-center transition-[width,height] duration-200 ease-linear group-data-[collapsible=icon]:size-6 motion-reduce:transition-none
```

Nothing else in `ChatGroupIcon` changes: both children keep `col-start-1 row-start-1`; the 24px layer now overflows the 20px track symmetrically (invisible at `opacity-0`, and the button's `overflow-hidden` never mattered here). No test changes — jsdom can't assert layout; verify visually (avatar optically centered against the group name in expanded, unchanged in collapsed).

---

## Fix 2 — separators: replace the discrete cross-fade with a zero-layout overlay (required)

**File: `src/components/sidebar/app-sidebar.tsx`** — the `collapsedRailSeparatorClassName` const (~line 37) and both `<SidebarSeparator … />` usages (~lines 129, 170).

### Why the current version still flashes

The staggered fade fixed the *opacity* pop but kept the separator as a **layout-participating block** toggled via `display`. Its box (`my-1` + 1px ≈ 9px) is inserted when collapsing starts and removed when the expand fade ends — so the Workspace icons and chat-group avatars below it jump ~9px vertically mid-animation, in both directions. That is the "grows the height temporarily" flashing. No timing values can fix this; the box itself has to stop existing in layout.

### The fix: overlay hairline (less machinery, zero layout delta)

Render each separator as a **zero-height positioning shell** with an absolutely-positioned hairline inside. The shell contributes 0px to layout in *both* states — toggling the sidebar can no longer move anything. The line itself only animates opacity, and it has a **fixed collapsed-rail width** (`w-8` at `left-2`, exactly where the old `mx-2 w-auto` line sat in the 3rem rail), so it can never paint wide mid-collapse either. All of `transition-discrete`, `starting:`, and the display toggle go away.

```
before (collapsed rail, today)          after
──────────────────────────────
[ Workspace icons ]                    [ Workspace icons ]
   ↕ 4px group padding                    ↕ 4px group padding
┌─ separator block: 9px tall ─┐        ── hairline: 0px tall, overlaid ──
│  appears/vanishes on toggle │           in the existing 8px gap;
│  → content below JUMPS      │           fades opacity only → nothing
└──────────────────────────────┘           below ever moves
   ↕ 4px group padding                    ↕ 4px group padding
[ Chat group avatars ]                 [ Chat group avatars ]
```

Replace the const with a tiny local component (it's used twice), delete `collapsedRailSeparatorClassName`, and swap both usages:

```tsx
// Collapsed-rail section separator. A zero-height shell + absolutely
// positioned hairline: it occupies no layout in either state, so toggling the
// rail can never shift content — only opacity animates. Fixed w-8 (the
// collapsed icon-column width, matching the old mx-2 line in the 3rem rail)
// so it never paints wide mid-collapse. Expanded mode still delineates
// sections with the group headers.
function CollapsedRailSeparator() {
  return (
    <div aria-hidden className="relative h-0">
      <div className="absolute left-2 top-0 h-px w-8 bg-sidebar-border opacity-0 transition-opacity duration-150 ease-linear group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-100 motion-reduce:transition-none" />
    </div>
  );
}
```

Both usages become `<CollapsedRailSeparator />` (replace the old three-line comment blocks above them — the component's comment now carries the explanation). Timing keeps the baton pass: labels fade out during the first half of the collapse; the line fades in from 100ms and settles at 250ms, a soft landing just after the rail reaches 3rem. Expanding fades it out immediately (150ms) as a 32px stub at the left edge — innocuous at any width.

Housekeeping:

- Remove the now-unused `SidebarSeparator` import from `app-sidebar.tsx` (lint's unused checks will flag it otherwise). Do **not** touch the `SidebarSeparator` primitive in `src/components/ui/sidebar.tsx`.
- Accepted visual delta (intentional, do not compensate): the collapsed rail loses the ~9px block the old separator occupied — sections sit slightly closer, with the hairline centered in the existing 8px inter-group gap. The expanded layout is untouched. Do **not** add state-dependent padding to restore the old collapsed spacing; state-dependent layout is exactly what this fix removes.
- No tests cover the separators; verification is manual (below).

### Pre-approved fallback

If review still dislikes the hairline after seeing it, **full removal is already approved**: delete `CollapsedRailSeparator` and both usages entirely and let the 8px group gaps carry the section boundaries. Don't do this preemptively — ship the overlay first; it preserves the rail's grouping at zero smoothness cost.

---

## Verified — keep as-is

- **A1 sort + pin** (`use-chat-groups.tsx`): helpers, memo placement (sort after all live overlays), unchanged dependency array, and the missing-active-group pin are all exactly per plan. Recency tests cover ties, live bumps, pin edge cases, and input immutability.
- **A2 FLIP hook** (`use-flip-list.ts`): dependency-array-less layout effect, `offsetTop` measurement, mid-flight interruption math (read transform before `cancel()`), WAAPI/jsdom guard, reduced-motion guard — all correct. The test file's `animate` stub returns `playState: "finished"`, which correctly keeps the interruption branch (and its `DOMMatrixReadOnly` use) out of jsdom's reach; the stub is scoped to that file, so `chat-groups-ui.test.tsx` still exercises the no-WAAPI guard. Nice touch.
- **B3 button timing** (`ui/sidebar.tsx`): `duration-200 ease-linear` appended as planned. Known accepted side effect: hover background fades on all sidebar menu buttons are now 200ms/linear (previously ~150ms/ease). Revisit only if hover feels mushy in review.
- **Known subtle behavior, intentional**: the name span and count slot carry `starting:opacity-0`, so row text fades in over 100ms when rows first mount (initial load, workspace switch). This is what makes the *expand* direction fade instead of pop; the load-time fade is a quiet side effect, not a bug.

## Run after fixing

`bun run typecheck && bun run test:run -- tests/chat-groups-recency.test.ts tests/use-flip-list.test.tsx tests/chat-groups-ui.test.tsx` (fix 2 also wants `bun run lint` for the removed import), then manually: toggle `⌘B` both directions watching the Workspace/Chat Groups boundary — nothing below the separators may move; double-tap `⌘B` mid-animation; confirm the expanded avatar sits optically centered against its group name.
