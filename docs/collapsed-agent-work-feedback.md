# Collapsed Agent Work — Feedback (Round 1)

**May 25, 2026**

The first implementation looks structurally correct — `TurnSummaryBar`, the `chat-messages-view.tsx` wrap, the `renderMode` plumbing, and the `turn/completed` payload extension all match the plan. Three visual changes before this lands.

---

## 1. The summary line is rendering in Figtree, not Geist Mono

**File:** `src/components/turn-summary-bar.tsx:56` — the class is `font-mono`, which is correct. The bug is one layer down in `src/styles/globals.css`.

### Root cause

`src/styles/globals.css:98` declares:

```css
--font-mono: var(--font-geist-mono);
```

…but `--font-geist-mono` is never defined anywhere in the codebase (verified with `grep -rn "font-geist-mono" src/`). Geist Mono is loaded from Google Fonts in `src/root.tsx:40` and is available, but the CSS variable indirection points at a dead reference, so `font-mono` falls back to the next thing in the cascade (Figtree, inherited from `body`).

This is a pre-existing latent bug — every `font-mono` usage in the codebase (admin tables, log viewers, DNS hint blocks, etc.) has been silently rendering in Figtree. It just hasn't been visually obvious because most existing call sites are short tokens (script names, GUIDs) where the wrong family is hard to spot. The summary line sits next to body text, so the mismatch is glaring.

### Fix

Define `--font-geist-mono` properly. Add it to the `:root` declaration in `globals.css` (look for the existing `:root { ... }` block that holds other variable defaults — currently around line 145+):

```css
:root {
  /* …existing declarations… */
  --font-geist-mono: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono",
    Menlo, Consolas, monospace;
}
```

Order of fallbacks matters: `Geist Mono` first (loaded from Google Fonts), then the platform monospace stack so we degrade gracefully if the Google Fonts request fails or hasn't finished loading. No change needed in `turn-summary-bar.tsx` — once the variable is defined, `font-mono` will resolve correctly there and everywhere else.

### Verification

Inspect the summary line in DevTools after the fix. Computed `font-family` on the `<button>` should resolve to `"Geist Mono"` (with the rest as fallbacks). Visually, the digits in `2:18` and `14 steps` should sit on a monospace baseline — the `1` and the `4` should be the same width.

Worth a 30-second sanity sweep across the other `font-mono` sites after the fix (admin pages, DNS hint blocks) to confirm nothing surprising regresses now that they're actually rendering in Geist Mono instead of falling back.

---

## 2. Remove the left vertical border on the expanded trace region

**File:** `src/components/turn-summary-bar.tsx:84`

Current:

```tsx
<div className="ml-1 space-y-1 border-l border-border/40 py-2 pl-4">
  {children}
</div>
```

The spec originally called for an indented vertical rule. In practice, with the hairline separator already closing off the trace below, the left border is redundant — the user can already tell where the tool calls end. The vertical rule is still useful **inside an individual tool call's details panel** (it nests structured data under the call), but at the turn-trace level it adds visual chrome we don't need.

### Change

Remove `border-l border-border/40`. Keep `space-y-1` and `py-2`.

---

## 3. Remove the left padding so tool calls align with the summary line

Same line — once the border goes, the indent (`ml-1 pl-4`) becomes the next thing to evaluate. The tool calls already have their own visual anchor on the left edge (the colored status dot at `src/components/tool-call/tool-call.tsx:152`, `w-1.5 h-1.5`), and we don't need an extra indent to nest them.

### Change

Drop `ml-1` and `pl-4`. The container becomes:

```tsx
<div className="space-y-1 py-2">
  {children}
</div>
```

### Alignment note

After this, the tool-call rows will line up at x=0 with the summary line. The tool call row itself uses `hover:bg-muted/30 rounded px-2 -mx-2` (`tool-call.tsx:142`) — the negative horizontal margin means its hover background bleeds 0.5rem to the left of the alignment line, but the visible content (status dot + verb + target) still starts at x=0. This is the same hover behavior tool calls have everywhere else in the chat; it should feel consistent.

### Resulting expanded layout

```
worked for 2:18 · 14 steps · hide work    ⌄
                                                ← py-2 gap
● Created screensaver.html                      ← aligned with summary text
● Edited screensaver.html (+42 lines)
Thinking…
● Read screensaver.html (1.2 kB)
…
                                                ← py-2 gap
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    ← hairline (unchanged)

Here you go! A pink-themed screensaver…         ← final message (unchanged)
```

The summary text, the tool-call status dots, and the agent's final reply all share the same left edge. The hairline carries the full burden of "this section ended."

---

## Combined diff sketch

```diff
--- a/src/components/turn-summary-bar.tsx
+++ b/src/components/turn-summary-bar.tsx
@@
       <CollapsibleContent
         className={cn(
           "overflow-hidden data-[state=open]:animate-turn-trace-down data-[state=closed]:animate-turn-trace-up",
           "motion-reduce:animate-none",
         )}
       >
-        <div className="ml-1 space-y-1 border-l border-border/40 py-2 pl-4">
+        <div className="space-y-1 py-2">
           {children}
         </div>
       </CollapsibleContent>

--- a/src/styles/globals.css
+++ b/src/styles/globals.css
@@ :root {
+  --font-geist-mono: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono",
+    Menlo, Consolas, monospace;
```

(Put the `--font-geist-mono` declaration alongside the existing `:root` variables — wherever the other defaults like `--background`, `--foreground` live.)

---

## What's not changing

- The hairline separator (`<hr className="my-2 border-t border-border/40" />`) stays exactly where it is — it's now doing the full job of "trace ends here."
- The summary line markup, animations, and Pi `turn/completed` wiring all stay as-is.
- The collapse / expand toggle behavior, focus ring, hover brightening, and `animateOnMount` flow are unchanged.
- The `border-l` inside individual tool calls' details panels (`src/components/tool-call/tool-call.tsx`, `thinking-block.tsx`) is unchanged — that nesting still helps readability inside a single call's expanded body.

---

# Backend / React Review Addendum

I reviewed the worktree diff after the UI pass, including the memo behavior in the chat message tree. The implementation is generally on the right track: `renderMode` is included in `MessageBubble`'s memo comparator, `completedTurns` is replaced with a new `Map` instead of mutating state in place, and `freshlyCompletedTurnId` is cleared after the one-shot collapse animation. Focused tests and typecheck pass:

```bash
bun run test:run -- tests/turn-utils.test.ts tests/turn-summary-bar.test.tsx tests/chat-messages-view-collapsed-turn.test.tsx tests/message-bubble-tool-continuation.test.tsx
bun run typecheck
```

I have three technical follow-ups before landing.

---

## 4. `MessageBubble` memo still ignores provider props used by error rendering

**File:** `src/components/message-bubble.tsx:862-875`

The new comparator correctly includes `renderMode`, which is the main new memo key. However, it still omits `llmProvider` and `threadProvider`, even though `ContentBlockRenderer` uses both when rendering `error` blocks through `getChatApiErrorPresentation(...)`.

That means an error message can stay memoized with stale presentation if the provider context changes while the `message` object is unchanged. The collapsed work feature makes this more relevant because `final-text-only` intentionally preserves `error` blocks below the hairline.

### Fix

Add both provider props to the memo comparator:

```ts
prev.llmProvider === next.llmProvider &&
prev.threadProvider === next.threadProvider &&
```

Keep the existing `messageSkillSheetsEqual(...)` check — that part is fine.

---

## 5. The synthetic final-output message strips mention metadata too early

**File:** `src/lib/turn-utils.ts:123-138`

`buildFinalOutputMessageView(...)` currently calls `stripSystemMessageTags(...)` and writes the stripped text into the synthetic message. That helper also calls `stripMentionAnnotations(...)`.

This loses the mention metadata before `MessageBubble` gets to run its normal `prepareDisplayText(...)` path, which uses `stripMentionAnnotationsWithMetadata(...)` to preserve annotated connection mentions. Result: a final answer rendered through the collapsed path can display mentions differently from the same answer in the normal full message path.

### Fix

Use stripping only as a visibility check, but keep the original text block for rendering:

```ts
if (block.type === "text") {
  const visibleText = stripSystemMessageTags(block.text);
  if (visibleText) {
    outputBlocks.push(block);
  }
}
```

For string content, create a text block with the original string once the visibility check passes. Let `MessageBubble` strip system tags and preserve mention metadata at render time, as it already does today.

---

## 6. Memo/perf: collapsed turn view models are rebuilt on every `ChatMessagesView` render

**File:** `src/components/chat-messages-view.tsx:191-293`

`ChatMessagesView` itself is memoized, so normal composer typing should not redraw the whole message tree as long as its props stay referentially stable. Within a `ChatMessagesView` render, though, every message group recomputes:

- `countTurnSteps(messageGroup.messages)`
- `visibleMessages.find(...)` for the preceding user message
- `buildFinalOutputMessageView(...)`

The last item also creates a fresh synthetic `Message` object every render. That defeats `MessageBubble` memo for collapsed final answers because `prev.message === next.message` will be false whenever `ChatMessagesView` does re-render for unrelated reasons like copy state, completion metadata, compaction state, or errors.

### Fix

Move collapsed-turn derivation into a memoized view-model pass keyed by `visibleMessages`, for example by extending the existing `messageGroups` `useMemo` to include stable derived fields:

```ts
{
  ...group,
  stepCount,
  precedingUserMessageId,
  fallbackDurationMs,
  finalOutputMessage,
}
```

Then the render loop only does cheap state lookups:

```ts
const durationMs =
  completedTurns.get(group.actionMessageId)?.durationMs ??
  group.fallbackDurationMs;
```

This keeps synthetic final messages referentially stable across unrelated re-renders and lets the existing `MessageBubble` memo actually pay off for long threads.

### Test gap

The current `tests/chat-messages-view-collapsed-turn.test.tsx` mocks `MessageBubble`, which is fine for high-level layout, but it does not catch this memo behavior. Add a focused unit test around `buildFinalOutputMessageView(...)` preserving mention annotations, and either a small React test or profiler-style assertion that an unrelated `copiedMessageId` update does not recreate/re-render unchanged collapsed final output more than necessary.
