# Chat Animation Regression — Root Cause & Fix Plan

**June 8, 2026**

---

## TL;DR

Two chat animations regressed together:

1. **User message send** no longer reserves the correct amount of vertical space (the just-sent message doesn't pin to the top correctly).
2. **Tool-call expand/collapse** animates slowly toward a height that is too tall, overshoots, then snaps ("glitches up") to the real height — worst when the expanded content is short.

**Root cause:** a single style object, `MESSAGE_LAYOUT_CONTAINMENT_STYLE` in `src/components/chat-messages-view.tsx`, gained two properties — `content-visibility: auto` and `contain-intrinsic-size: auto 180px` — in PR **#701 "Improve long chat render performance"** (commit `71331db9`, 2026-06-02). That style is attached to the exact DOM nodes whose height is measured (for the send-spacer) and that contain the animating tool-call collapsibles. The hard-coded `180px` intrinsic placeholder is literally the "grows past the required height" the bug report describes.

**This was NOT introduced by the #718 project-runtime merge.** #718 (`c927818d`, 2026-06-05) is when the change reached this branch (it bundled in main, including #701), but #718's own diff touches **zero** animation/measurement code. The culprit code is #701, which arrived in the same merge window.

**The fix:** remove those two properties, restoring the pre-#701 value `{ contain: "layout paint style" }`. One file, ~2 lines. Keep everything else #701 added.

---

## Symptoms (as reported)

- "The animation of the user message send is not calculating the correct amount of space required on message send anymore."
- "Expand/collapse of the tool calls is glitchy — the animation is slow in the beginning and then auto-jumps to the correct height. It looks really bad when there aren't a lot of tool calls. This slow animation (suspected hard-coded) grows past the required height and then glitches up."
- Both were "great before"; both regressed at the same time.

---

## Root cause

`src/components/chat-messages-view.tsx`, lines 25–29 (current state):

```ts
const MESSAGE_LAYOUT_CONTAINMENT_STYLE = {
  contain: "layout paint style",
  contentVisibility: "auto",          // ← added by #701
  containIntrinsicSize: "auto 180px", // ← added by #701
} satisfies CSSProperties;
```

This object is applied via `style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}` to the message wrapper `<div>`s, including the ones that carry the measurement refs:

- Line ~287 — the `renderMessage` wrapper that receives `lastUserMessageRef` **or** `assistantMeasureRef`.
- Line ~358 — the turn-summary wrapper that receives `assistantMeasureRef` (summary case).
- Line ~383 — the final-output wrapper that receives `assistantMeasureRef` (final-text case).

So the spacer measures these nodes, and tool-call collapsibles render *inside* them.

### The #701 diff that introduced it

```diff
 const MESSAGE_LAYOUT_CONTAINMENT_STYLE = {
   contain: "layout paint style",
-} as const;
+  contentVisibility: "auto",
+  containIntrinsicSize: "auto 180px",
+} satisfies CSSProperties;
```

Before #701 the wrappers had **only** `contain: layout paint style`, and both animations worked. After #701 they also have `content-visibility: auto` + a `180px` intrinsic-size placeholder, and both animations broke. The two added properties are the entire delta. (It is also the only use of `content-visibility` anywhere in `src/`.)

---

## Audit trail (why we are certain it is #701, not #718)

The bug report blames the #718 merge (`Merge origin main and add project runtime migration`, branch `codex/project-vm-sandbox-tools`). The merge is the *delivery vehicle*, not the cause:

| Check | Result |
| --- | --- |
| Did #718 (`faed78d9..c927818d`) change any chat-animation source file? | **No.** #718 is a large squash-style single-parent commit, but none of its changes touch the animation/measurement paths (`chat-messages-view.tsx`, the spacer in `Chat.tsx`, `tool-call.tsx`, `globals.css`). Within the tool-call area its only source edits are `tool-call/details/skill-details.tsx` and `tool-call/mcp-utils.ts` — neither affects height animation. |
| Did `Chat.tsx` change across #718→HEAD? | Yes, but **only** WebSocket-reconnect and model-resolution logic. The spacer/scroll/measurement code is byte-identical. |
| Did the Radix `Collapsible`, the `collapsible-down/up` keyframes (`globals.css`), or `tool-call.tsx` change in the regression window? | **No.** Unchanged since before #701. |
| Did the "older main" merge downgrade the UI stack in a way that could explain this? | **No.** No relevant downgrades: `@radix-ui/react-collapsible` stays `1.1.12`. `bun.lock` did move `react`/`react-dom` `19.2.3 → 19.2.7` and `tailwindcss` `4.1.18 → 4.3.0`, but those are **upgrades**, not downgrades, and are not the cause — the `content-visibility` change predates them (#701) and reproduces independently, and the collapsible keyframes are hand-written CSS in `globals.css`, not Tailwind-generated utilities. |
| When did `content-visibility` + `contain-intrinsic-size: auto 180px` enter the code? | PR **#701** `71331db9`, 2026-06-02 — 3 days before the #718 merge. |

Conclusion: the animations are driven by Radix + CSS keyframes that are unchanged and correct. The only thing that changed near the measured/animated DOM is the #701 containment style. Removing those two properties restores the known-good pre-#701 DOM.

---

## Why these two properties break each animation

`content-visibility: auto` tells the browser it may skip rendering an element it deems off-screen / not-yet-relevant and, while skipped, size it from `contain-intrinsic-size` (here `180px` tall) instead of its real content. That directly corrupts every height read of these nodes.

### Symptom 1 — send spacer (`Chat.tsx`, `useLayoutEffect` at ~3732–3876)

The spacer reserves space so a freshly sent message scrolls to the top. It measures the user/assistant wrappers synchronously:

```ts
const userRect = measureUser.getBoundingClientRect();      // node has content-visibility: auto
// ...
const assistantRect = measureAssistant.getBoundingClientRect();
exchangeHeight = exchangeBottom - exchangeTop;             // height of the user→assistant block
height = availableHeight - exchangeHeight - rowGap - paddingBottom; // → spacer height
```

Immediately after a message mounts/updates, a `content-visibility: auto` node can still report its `180px` intrinsic placeholder for that synchronous `getBoundingClientRect()` (the browser resolves on-screen relevance on a later frame). `exchangeHeight` is therefore wrong, so the reserved spacer is wrong → the message lands at the wrong scroll offset. A frame later the `ResizeObserver` in the same effect re-measures the now-resolved real height and rewrites the spacer, producing the visible "wrong space, then jump." Net effect: "not calculating the correct amount of space on send."

### Symptom 2 — tool-call collapsible (`tool-call.tsx` + `globals.css`)

The collapsible is standard and correct:

```tsx
<CollapsibleContent className="… data-[state=open]:animate-collapsible-down …">
```
```css
@keyframes collapsible-down {
  from { height: 0; opacity: 0; }
  to   { height: var(--radix-collapsible-content-height); opacity: 1; }
}
```

The content lives inside a `content-visibility: auto` wrapper. When the expand animation changes layout (and can push the wrapper's own box partway past the relevance margin), the wrapper falls back to its `180px` intrinsic height for one or more frames. The animation grows toward ~`180px` (the "hard-coded" overshoot the report calls out), then snaps to the true content height once layout resolves. This is **most visible when the real expanded height is well below 180px** — i.e., "when there aren't a lot of tool calls" — exactly as reported. Tall expansions (> 180px) hide the overshoot, which is why it looked fine sometimes.

The Radix component and keyframes need no changes; they are fed bad layout by the ancestor containment.

---

## The fix (primary — do this)

**File:** `src/components/chat-messages-view.tsx`

Restore the pre-#701 value:

```ts
const MESSAGE_LAYOUT_CONTAINMENT_STYLE = {
  contain: "layout paint style",
} satisfies CSSProperties;
```

That is the whole fix: delete the `contentVisibility` and `containIntrinsicSize` lines. `contain: layout paint style` stays (it was present during the known-good era and still isolates per-message layout/paint). `CSSProperties` is still referenced by `satisfies`, so its import stays.

### Keep everything else #701 added — do NOT revert these

#701 also added a message-group memoization cache. It is pure JS object reuse with **no** DOM/CSS effect and is a legitimate perf win. Leave it untouched:

- `messageGroupCacheRef` (`useRef<Map<string, MessageGroup>>`)
- `haveSameMessageRefs(...)`
- the `MessageGroup` type
- the `previousGroup` reuse branch inside the `messageGroups` `useMemo`
- the `useRef` import (still used by `messageGroupCacheRef`)

### Do NOT touch (these are correct; changing them will reintroduce or mask bugs)

- The spacer `useLayoutEffect` math in `Chat.tsx` (~3732–3876). It is correct once it measures real heights.
- `src/components/tool-call/tool-call.tsx` and the Radix `Collapsible` wrapper.
- The `collapsible-down` / `collapsible-up` keyframes and `--animate-*` variables in `src/styles/globals.css`.
- `src/components/collapsible-user-message.tsx` (a different, unrelated "show more" collapser).

---

## Performance consideration & optional follow-up

#701's stated goal was long-chat render performance. Removing `content-visibility: auto` means the browser no longer skips rendering off-screen messages. Mitigations already in place keep this low-risk: the `contain: layout paint style` isolation and the message-group memoization both remain. `content-visibility: auto` on nodes that are continuously measured and that host height-animated collapsibles is the wrong tool here — it trades correctness for a paint optimization on exactly the nodes that must measure honestly.

**Recommendation:** ship the primary fix as-is. If profiling later shows a real long-thread regression, the correct durable approach is windowing/virtualization of *static historical* turns — NOT re-adding `content-visibility`/intrinsic-size to measured or animated nodes.

> **Frontend-sensitive — do not attempt as part of this fix.** A partial approach ("apply `content-visibility` only to old history turns") does not fully work: any historical message can contain an expandable tool call, so its expand animation would still overshoot. Treat virtualization as a separate, scoped project for someone comfortable with layout/measurement. For this task, stop at the primary fix.

---

## Files to change

| File | Change |
| --- | --- |
| `src/components/chat-messages-view.tsx` | Remove `contentVisibility: "auto"` and `containIntrinsicSize: "auto 180px"` from `MESSAGE_LAYOUT_CONTAINMENT_STYLE` (lines ~25–29). Nothing else. |

No CSS, Radix, `Chat.tsx`, or test-file edits are required.

---

## Verification

Commands:

```bash
bun run typecheck
bun run test:run -- tests/chat-messages-view-collapsed-turn.test.tsx
bun run test:e2e -- e2e/chat-rendering-performance.spec.ts   # uses its own synthetic CSS; unaffected
```

No existing test asserts on `content-visibility` / `containIntrinsicSize` / `180px`, so none should need updating. The `chat-rendering-performance` e2e models the spacer with its own inline CSS (`contain: layout paint style`, no content-visibility), matching the post-fix style, and should stay green.

Manual repro (before vs after) in a real chat:

1. **Send spacer** — send a *short* one-line message at the bottom of a populated thread. After fix: it pins to the top of the viewport with the response area reserved below in one settle, no visible jump/re-measure. Before fix: it lands too low and/or snaps after a frame.
2. **Tool-call collapse** — expand a tool call whose details are short (e.g. a single `Read`/`Grep`). After fix: it grows smoothly straight to its real height. Before fix: it grows past (~toward 180px) then snaps up.
3. **Tall expansion sanity** — expand a sub-agent / many-line tool result and confirm it still animates open smoothly (regression guard for the tall case that previously masked the bug).
