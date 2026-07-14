# Chat scroll simplification: remove the new-page spacer, fix auto-follow, unify send behavior

## Goal

Three user-visible outcomes, in priority order:

1. **Auto-follow works.** While the agent streams a turn, a user who is at (or returns to)
   the bottom of the chat is kept at the bottom automatically. Today they must scroll
   manually for the whole turn.
2. **The "new page" send animation is removed.** Sending a message no longer scrolls the
   user message to the top of the viewport with a height-managed spacer below it. A send
   simply appends the bubble at the bottom and scrolls to it — the same behavior chat apps
   like claude.ai use.
3. **One send behavior, not two.** A fresh prompt (agent idle) and a steer
   (`sentDuringStreaming`, agent mid-turn) currently scroll differently (fresh = page jump,
   steer = nothing). After this change both behave identically: append at bottom, scroll to
   bottom, follow the stream.

This is almost entirely a **deletion**. No new dependencies (do not add `use-stick-to-bottom`
or similar). No visual redesign — the existing scroll-to-bottom button is kept exactly as is.

## Current implementation map (all line numbers as of branch point `a2fdf052e`)

Everything lives in three source files plus one hook:

### `src/components/Chat.tsx`

| What | Where |
| --- | --- |
| `isUserTurnAnchorMessage()` — picks which user messages anchor the spacer | ~553–562 |
| `CHAT_SCROLL_CONTAINER_STYLE` (`overflow-anchor: none`) | ~566–568 |
| `showScrollButton` state | ~1042 |
| Scroll refs: `messagesEndRef`, `scrollContainerRef`, `messageColumnRef`, `lastUserMessageRef`, `assistantMeasureRef`, `assistantPendingMeasureRef`, `assistantSpacerRef`, `spacerHeightRef`, `spacerMeasureFrameRef`, `initialScrollDoneRef`, `stickToBottomRef`, `forceScrollOnNextUpdate` | ~1209–1220 |
| Per-thread reset of `initialScrollDoneRef` / `stickToBottomRef` | ~1251–1253 |
| `lastUserMessage` memo (only feeds spacer + `lastUserMessageId` prop) | ~2737–2744 |
| `shouldRenderSpacer` derivation | ~2745–2749 |
| `scrollToBottom(behavior)` callback | ~2753–2764 |
| Effect A: jump to bottom when a terminal `error` first appears | ~2766–2780 |
| Effect B: initial-load anchor scroll (`shouldAnchorToLastMessage`, `data-message-id` querySelector) | ~2782–2812 |
| Effect C: the spacer measurement engine (`updateSpacer`, header-overlap math, ResizeObserver on user/assistant/pending elements) | ~2814–2958 |
| `handleScroll` — maintains `stickToBottomRef` (<150px) and `showScrollButton` (>100px) | ~2960–2969 |
| Effect D: ResizeObserver on the message column → `scrollToBottom("auto")` while stuck — **gated on `!shouldRenderSpacer`** | ~2971–2997 |
| Effect E: on message-count/last-id change → initial scroll, forced scroll, near-bottom scroll — **gated on `!shouldRenderSpacer`** | ~2999–3041 |
| `sendMessage`: fresh-send branch sets `forceScrollOnNextUpdate` (unless `/compact`); steer branch does not | ~3820–3840 |
| Scroll container + message column render | ~3997–4011 |
| `ChatMessagesView` props (spacer refs/flags passed down) | ~4012–4047 |
| Scroll-to-bottom button (already exists; `Button` + `ArrowDown`) | ~4051–4069 |

### `src/components/chat-messages-view.tsx`

| What | Where |
| --- | --- |
| Props: `lastUserMessageId`, `lastMessageId`, `isAwaitingAssistant`, `isLastMessageAssistantLike`, `shouldRenderSpacer`, `lastUserMessageRef`, `assistantMeasureRef`, `assistantPendingMeasureRef`, `assistantSpacerRef` | 66–98 |
| `renderMessage` measurement-ref selection (`isLastUserMessage` / `isLastAssistantMessage` → `messageRef`) | 346–355, 362 |
| Summary-branch measurement refs (`finalMessageRef`, `summaryMessageRef`) | 415–426, 434–440, 471–476 |
| `assistantPendingMeasureRef` wrappers around `CompactingIndicator` / `ChatThreadWorkingIndicator` | 518–528 |
| The spacer element itself + `messagesEndRef` | 529–540 |

### `src/hooks/use-chat-transcript.ts`

- `shouldAnchorToLastMessage` (line 70) — returned by `useInitialChatTranscript`, consumed
  only by Effect B in Chat.tsx. Dies with Effect B.

### Why auto-follow is broken today (root cause)

`shouldRenderSpacer` is true whenever the last anchor user message was a fresh prompt and
the transcript ends assistant-like — i.e. **for the entire assistant turn and after it
completes**. Both auto-follow paths early-return while it is true (`Chat.tsx` ~2980 and
~3028). The design assumed the shrinking spacer would keep the viewport filled without
scrolling, but once the assistant content grows past one viewport the spacer is 0 and
nothing ever scrolls — and `shouldRenderSpacer` stays true, so the stick-to-bottom logic
never re-engages for the rest of the turn. Fixing auto-follow and deleting the spacer are
the same change.

## Target behavior

One model: **pinned-to-bottom**. `stickToBottomRef` ("pinned") is the single source of
truth for whether we follow content growth.

- Pinned becomes **true**: on thread open, when the user sends any message (fresh or
  steer, except `/compact`), and when the user scrolls to within **150px** of the bottom
  (this includes clicking the scroll-to-bottom button, via the scroll events it produces).
- Pinned becomes **false**: when the user scrolls to more than 150px from the bottom.
  (`handleScroll` already implements exactly this; it is unchanged.)
- The scroll-to-bottom button shows when more than **100px** from the bottom (unchanged).

Event → behavior:

| Event | While pinned | While unpinned |
| --- | --- | --- |
| Thread opened / first hydrated paint with messages | instant jump to bottom, pin, hide button | n/a (always pins) |
| User sends a message — fresh prompt **or** steer | instant jump to bottom (stay pinned) | pin + instant jump to bottom |
| User sends `/compact` | no scroll (existing carve-out: users run it while reading older messages) | no scroll |
| Streamed content grows the message column (tokens, tool cards, indicator, todos) | instant jump to bottom (rAF-coalesced) | nothing; button visible |
| Turn completes and collapses into `TurnSummaryBar` (column shrinks) | stay at bottom (same observer) | nothing |
| Scroll container itself resizes (window resize, composer grows, mobile keyboard) | stay at bottom | nothing |
| Terminal error notice appears | jump to bottom | jump to bottom (existing Effect A behavior, kept as-is) |
| User scrolls up during a stream | unpin; stream continues without yanking the viewport | — |
| User clicks scroll-to-bottom button | — | smooth scroll to bottom; repins via scroll events |

All programmatic scrolls during send/stream are **instant** (`behavior: "auto"`), not
smooth. Reason: the ResizeObserver snap and a smooth animation race — the snap would cut
every smooth animation short anyway, and the old fresh-send jump was already instant
(`shouldRenderSpacer ? "auto" : ...`). The only smooth scroll left is the button click.

### Before / after, visually

Sending a message today (fresh prompt — the behavior being removed):

```
┌────────────────────────────┐
│ ▌my new prompt          ▐  │  ← user bubble forced to viewport top
│                            │
│   ● Working…               │
│                            │
│        (spacer div,        │  ← height-managed empty space
│    shrinks as reply grows) │
│                            │
├────────────────────────────┤
│ [composer            ] [→] │
└────────────────────────────┘
```

Sending a message after this change (fresh prompt AND steer — identical):

```
┌────────────────────────────┐
│ …earlier transcript…       │
│ assistant: previous reply  │
│                            │
│          ▌my new prompt ▐  │  ← appended at bottom, right-aligned as today
│ ● Working…                 │  ← indicator directly below
├────────────────────────────┤
│ [composer            ] [→] │
└────────────────────────────┘
```

Streaming while pinned (viewport stays glued to the newest content):

```
┌────────────────────────────┐
│ │ Reading src/routes.ts    │
│ │ Edited Chat.tsx          │
│ The fix works by…▌         │  ← newest tokens always visible
├────────────────────────────┤
│ [composer            ] [→] │
└────────────────────────────┘
```

Streaming after the user scrolled up (unpinned — nothing moves, button offers the way back):

```
┌────────────────────────────┐
│ …older message the user    │
│  is re-reading…            │
│                            │
│           ┌───┐            │
│           │ ↓ │            │  ← existing button, unchanged styling:
│           └───┘            │    outline icon Button, rounded-full,
├────────────────────────────┤    absolute -top-12 left-1/2, ArrowDown
│ [composer            ] [→] │
└────────────────────────────┘
```

No new UI is introduced. The scroll-to-bottom button already exists at `Chat.tsx`
~4051–4069 with exactly the right styling and visibility logic — do not restyle, move, or
rename anything about it.

## Implementation

### 1. `src/components/Chat.tsx` — delete the spacer system

Delete outright:

- `isUserTurnAnchorMessage()` (~553–562), and the now-unused imports it pulled in:
  `isInterruptMessage`, `parseLocalCommandStdout` (from `@/components/message-bubble`,
  import lines ~77–78). Both are used nowhere else in this file — confirm with lint.
- Refs (~1209–1220): `lastUserMessageRef`, `assistantMeasureRef`,
  `assistantPendingMeasureRef`, `assistantSpacerRef`, `spacerHeightRef`,
  `spacerMeasureFrameRef`.
  **Keep**: `messagesEndRef`, `scrollContainerRef`, `messageColumnRef`,
  `initialScrollDoneRef`, `stickToBottomRef`, `forceScrollOnNextUpdate`.
- `lastUserMessage` memo (~2737–2744) and `shouldRenderSpacer` (~2745–2749). Nothing else
  reads `lastUserMessage` except the `lastUserMessageId` prop, which is also being deleted.
- Effect B, the initial-anchor scroll (~2782–2812). Its job is folded into Effect E below.
  (It existed because "scroll to bottom" landed *below the spacer*; with no spacer,
  bottom is correct on load.) Keep the `data-message-id` attributes in the view — they
  cost nothing and remain useful for debugging/tests; only this querySelector consumer dies.
- Effect C, the spacer measurement engine (~2814–2958), in its entirety.

Keep unchanged:

- `scrollToBottom` (~2753–2764).
- Effect A, error → jump to bottom (~2766–2780).
- `handleScroll` (~2960–2969) — already maintains pin state and button visibility.
- `CHAT_SCROLL_CONTAINER_STYLE` / `overflow-anchor: none` (~566–568): our observer is the
  single scroll authority; leaving native anchoring off prevents the browser fighting it.
- The scroll container / message column / button JSX (~3997–4011, ~4051–4069).
- Per-thread reset (~1251–1253).

### 2. `src/components/Chat.tsx` — unify the two follow effects

**Effect D** (~2971–2997), ResizeObserver on the column: remove the
`if (shouldRenderSpacer) return;` gate, and additionally observe the scroll container so
container shrinkage (composer growing, window resize, mobile keyboard) keeps a pinned user
at the bottom:

```tsx
useEffect(() => {
  if (!shouldShowChat || !threadId) return;

  const container = scrollContainerRef.current;
  const column = messageColumnRef.current;
  if (!column || typeof ResizeObserver === "undefined") return;

  let frameId: number | null = null;
  const observer = new ResizeObserver(() => {
    if (!stickToBottomRef.current) return;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
    }
    frameId = requestAnimationFrame(() => {
      frameId = null;
      scrollToBottom("auto");
    });
  });

  observer.observe(column);
  if (container) observer.observe(container);

  return () => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
    }
    observer.disconnect();
  };
}, [scrollToBottom, shouldShowChat, threadId]);
```

**Effect E** (~2999–3041), on transcript updates: drop the spacer gates and the redundant
manual distance re-check (`handleScroll` already owns `stickToBottomRef`), and pin
explicitly on the initial/forced paths so follow engages even before any scroll event fires:

```tsx
// Auto-scroll on new messages (initial load, own sends, and while pinned)
useLayoutEffect(() => {
  if (!shouldShowChat || !threadId) return;
  if (!hasHydratedChatTranscript) return;

  if (!initialScrollDoneRef.current && visibleMessageCount > 0) {
    initialScrollDoneRef.current = true;
    stickToBottomRef.current = true;
    scrollToBottom("auto");
    setShowScrollButton(false);
    return;
  }

  const shouldForce = forceScrollOnNextUpdate.current;
  forceScrollOnNextUpdate.current = false;

  if (shouldForce) {
    stickToBottomRef.current = true;
    scrollToBottom("auto");
    return;
  }

  if (stickToBottomRef.current) {
    scrollToBottom("auto");
  }
}, [
  visibleMessageCount,
  lastVisibleMessageId,
  scrollToBottom,
  shouldShowChat,
  threadId,
  hasHydratedChatTranscript,
]);
```

### 3. `src/components/Chat.tsx` — unify the send paths

In `sendMessage` (~3809–3852): hoist the force-scroll line above the
`wasSentDuringStreaming` branch so **both** fresh prompts and steers get it. Keep the two
`setMessages` branches exactly as they are (the steer branch's dedupe-by-clientMessageId
append is turn-model behavior, not animation):

```tsx
// Sending your own message always brings the bottom into view. /compact is
// operational and can happen while users read older messages — don't jump.
forceScrollOnNextUpdate.current = !shouldShowCompactingIndicator;

if (wasSentDuringStreaming) {
  // Steering: … (existing dedupe append, unchanged)
} else {
  setMessages((prev) => [...prev, userMsg]);
}
```

The flag is consumed by Effect E on the very next transcript commit (the optimistic append
itself), which is what makes the scroll happen *after* the new bubble has layout.

### 4. `src/components/chat-messages-view.tsx` — remove spacer plumbing

- Delete props (interface + destructuring + all uses): `lastUserMessageId`,
  `lastMessageId`, `isAwaitingAssistant`, `isLastMessageAssistantLike`,
  `shouldRenderSpacer`, `lastUserMessageRef`, `assistantMeasureRef`,
  `assistantPendingMeasureRef`, `assistantSpacerRef`. Every one of these exists only to
  drive spacer measurement. **Keep `messagesEndRef`** (scroll target / fallback).
- In `renderMessage` (346–368): delete `isLastUserMessage`, `isLastAssistantMessage`, and
  `messageRef`; the wrapper div keeps its `key`, `data-message-id`, containment style, and
  classes — just no `ref`.
- In the summary branch (415–498): delete `isLastAssistantMessage`, `finalMessageRef`,
  `summaryMessageRef` and the `ref={...}` usages; keep the `data-message-id` attributes
  as they are.
- Indicators (518–528): keep the conditional rendering, drop the ref wrappers:

  ```tsx
  {isCompacting && <CompactingIndicator />}

  {showGlobalAssistantIndicator && !isCompacting && (
    <ChatThreadWorkingIndicator startedAt={runningStartedAt} />
  )}
  ```

- Spacer block (529–540): replace the whole conditional with the plain end anchor:

  ```tsx
  <div ref={messagesEndRef} />
  ```

- In `Chat.tsx` (~4012–4047), remove the corresponding props from the `<ChatMessagesView>`
  call site. Side benefit: this memoized component no longer re-renders on
  `isAwaitingAssistant`/`lastMessageId` churn during streaming.

### 5. `src/hooks/use-chat-transcript.ts` — drop `shouldAnchorToLastMessage`

Remove it from `useInitialChatTranscript`'s return (line 70) and from the destructuring in
`Chat.tsx` (~634–643). Its only consumer was Effect B.

### 6. Tests

- `tests/chat-messages-view-collapsed-turn.test.tsx` — remove the deleted props from the
  `baseProps` fixture (lines ~95–98 and ~115–120: `lastUserMessageId`, `lastMessageId`,
  `isAwaitingAssistant`, `isLastMessageAssistantLike`, `shouldRenderSpacer`,
  `lastUserMessageRef`, `assistantMeasureRef`, `assistantPendingMeasureRef`,
  `assistantSpacerRef`; keep `messagesEndRef`). No behavioral assertions in that file
  depend on the spacer.
- `tests/chat-hooks.test.tsx` — drop the `shouldAnchorToLastMessage` assertion (line ~57).
- Do **not** change `tests/steer-split.test.ts`, `tests/runtime-message-overlay.test.ts`,
  or `tests/ui-message-adapter.test.ts` — `sentDuringStreaming` semantics are untouched.

## Explicitly out of scope — do not touch

- **`sentDuringStreaming` itself.** It is a turn-model field (server stamping in
  `chat-thread-do.ts`, adapter round-trip, steer overlay ordering in
  `runtime-message-state.ts`, turn grouping via `lastFreshPromptUserMessageId` in
  `chat-messages-view.tsx`). Only its `shouldRenderSpacer` consumer goes away.
- The steer/optimistic-echo merge logic and the two `setMessages` branches in `sendMessage`.
- `TurnSummaryBar` collapse animation, `freshlyCompletedTurnId` flow.
- The bridged-stream seed seam (`bridgedStreamingMessageId`, `resolveDisplayChatData`).
- The scroll-to-bottom button's markup, position, thresholds, or styling.
- Effect A (error → jump to bottom).
- `data-message-id` attributes.
- No new dependencies.

## Optional (cuttable — skip if anything is unclear)

- **Reduced motion:** in the button's `onClick`, and anywhere `"smooth"` remains, respect
  `window.matchMedia("(prefers-reduced-motion: reduce)").matches` by falling back to
  `"auto"`. One-line guard inside `scrollToBottom`.
- The read-only admin view currently has no scroll button (it lives in the `!readOnly`
  composer block) but does get auto-follow. That asymmetry predates this change; leave it.

## Verification

```bash
bun run typecheck
bun run test:run -- tests/chat-messages-view-collapsed-turn.test.tsx tests/chat-hooks.test.tsx
bun run test:run -- tests/chat-question-response-focus.test.tsx tests/steer-split.test.ts tests/runtime-message-overlay.test.ts
```

Then drive the real flow with `bun run dev` against a thread with enough history to scroll:

1. Open a long thread → lands at the bottom, no button visible.
2. Send a prompt → bubble appends at the bottom (no page jump), working indicator below it,
   viewport pinned.
3. Let a long reply stream → viewport follows continuously past one viewport height,
   including tool cards appearing and the end-of-turn summary collapse.
4. Scroll up mid-stream → viewport stops moving, button appears; click it → back to bottom
   and following again.
5. While the agent is working, send a steer → identical behavior to step 2.
6. Scroll up, send `/compact` → no jump.
7. Switch to another thread and back mid-stream → lands at bottom, following.
