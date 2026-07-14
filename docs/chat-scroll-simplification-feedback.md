# Chat scroll simplification — implementation feedback

Review of the working-tree implementation of
[chat-scroll-simplification-plan.md](./chat-scroll-simplification-plan.md).

## Implementation review

The diff matches the plan: the spacer engine, measurement refs, initial-anchor effect,
`isUserTurnAnchorMessage`, and all nine `ChatMessagesView` plumbing props are gone; the two
follow effects are unified exactly as specified (spacer gates removed, container observed,
`frameId` reset inside the rAF); the force-scroll flag is hoisted above the fresh/steer
branch; `shouldAnchorToLastMessage` is removed from the hook and both test files were
updated correctly. `bun run typecheck` and the five chat test files (41 tests) pass.

One bug to fix, found in manual testing. It is a pre-existing design gap that the plan
failed to call out, not a deviation from the plan.

## Bug: scroll-to-bottom button gets stuck visible after the turn trace collapses

**Repro:** let the agent stream a long turn, scroll up (button appears — correctly), then
stop the turn (or click "hide work" on a finished turn). The trace collapses into
`TurnSummaryBar` and the whole transcript now fits inside the viewport. The
scroll-to-bottom button stays visible even though there is nothing to scroll, and it can
never clear. Expanding "show work" and scrolling syncs it again; collapsing re-triggers it.

**Root cause:** `stickToBottomRef` and `showScrollButton` are recomputed only in
`handleScroll` (`src/components/Chat.tsx:2746–2754`), which runs only on `scroll` events
from the container. But distance-from-bottom also changes when content **resizes without
any scrolling** — exactly what a trace collapse does. When the collapse shrinks the
transcript to fit the viewport:

- the browser clamps `scrollTop` itself (no reliable `scroll` event; and if the
  pre-collapse `scrollTop` is already within the new valid range there is no clamp and
  definitely no event), and
- once content fits the viewport there is **no scrollable overflow at all**, so no scroll
  event can ever fire again — whatever value `showScrollButton` had is frozen forever.

The column ResizeObserver (`src/components/Chat.tsx:2764`) sees every one of these
resizes but cannot help: its first line is `if (!stickToBottomRef.current) return;` — the
unpinned path (the stuck path) is skipped entirely, and it never updates
`showScrollButton` in any case.

The same gap produces the symmetric stale-**hidden** state: expanding "show work" while
unpinned grows distance-from-bottom past 100px with no scroll event, so the button that
should appear doesn't until the user nudges the scrollbar. One fix covers both.

## Fix: re-derive scroll state on resize, not just on scroll

In `src/components/Chat.tsx`, rename `handleScroll` to `syncScrollPosition` (it is no
longer only a scroll handler) and call it from the ResizeObserver as well —
**unconditionally**, after the pinned-follow scroll so it measures post-scroll geometry:

```tsx
// Derives pin state + scroll-button visibility from the current geometry.
// Called on scroll events AND on content/container resize — resizes (e.g. the
// turn trace collapsing to fit the viewport) change distance-from-bottom
// without firing any scroll event.
const syncScrollPosition = useCallback(() => {
  const container = scrollContainerRef.current;
  if (!container) return;

  const { scrollTop, scrollHeight, clientHeight } = container;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  stickToBottomRef.current = distanceFromBottom < 150;
  setShowScrollButton(distanceFromBottom > 100);
}, []);
```

Update the container JSX: `onScroll={syncScrollPosition}` (currently
`onScroll={handleScroll}` at `src/components/Chat.tsx:3778`).

In the follow-observer effect (`src/components/Chat.tsx:2758–2784`), replace the observer
callback body — note the pinned early-return moves *inside* so the sync always runs:

```tsx
const observer = new ResizeObserver(() => {
  if (frameId !== null) {
    cancelAnimationFrame(frameId);
  }
  frameId = requestAnimationFrame(() => {
    frameId = null;
    if (stickToBottomRef.current) {
      scrollToBottom("auto");
    }
    syncScrollPosition();
  });
});
```

Add `syncScrollPosition` to that effect's dependency array (it is a stable
`useCallback`, so this does not re-run the effect).

Ordering matters and is load-bearing:

- **Pinned:** `scrollToBottom("auto")` sets `scrollTop` synchronously, so the sync reads
  distance ≈ 0 → button hidden, still pinned. Following is unaffected.
- **Unpinned, collapse-to-fit:** sync reads the clamped geometry → distance ≤ 0 → button
  hides **and the user repins** (distance < 150). Repinning is correct: with everything in
  view, "at the bottom" is trivially true and future streaming should auto-follow.
- **Unpinned, expand:** distance grows past 100 → button appears (there is now content
  below the viewport).

Do not change anything else — `scrollToBottom`, the transcript-update effect, the send
path, the error effect, and the button JSX are all correct as implemented.

### Intentional behavior to leave alone

With the fix, clicking "show work" while pinned at the bottom keeps the viewport
bottom-anchored: the trace expands upward out of view and nothing visibly jumps (the
follow-observer compensates `scrollTop` for the growth). That is the intended
pinned-growth behavior, shared with streaming — do not special-case collapsible expansion.

## Verification

```bash
bun run typecheck
bun run test:run -- tests/chat-messages-view-collapsed-turn.test.tsx tests/chat-hooks.test.tsx tests/chat-question-response-focus.test.tsx tests/steer-split.test.ts tests/runtime-message-overlay.test.ts
```

Then in `bun run dev`, the reported repro plus regression passes:

1. Stream a long turn, scroll up (button appears), press stop → trace collapses to fit the
   viewport → **button disappears**.
2. On the collapsed thread, click "show work" → button appears (content extends below);
   click the button → lands at bottom, button hides; click "hide work" → still hidden.
3. Re-check plan scenarios 2–4 (send pins and follows; scroll-up mid-stream unpins;
   button returns you to following) to confirm the observer change didn't regress
   streaming follow.
