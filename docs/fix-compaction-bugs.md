# Fix Compaction Flow Bugs

**March 1, 2026** | Files: `Chat.tsx`, `message-bubble.tsx`, `compact-summary-card.tsx`

---

## Bug Overview

Three compaction UX issues need fixing:

| # | Priority | Bug | Root Cause |
|---|----------|-----|------------|
| 1 | P1 | Assistant message looks "done" when compaction starts (dots vanish, tool calls show action buttons) | `message_delta(stop_reason)` fires before compaction events, calling `finalizeStreamingMessage()` which sets `isStreaming: false` on the message |
| 2 | P0 | Post-compaction assistant content streams into the OLD message (above the compact card) instead of a new message below it | `streamingMessageId` is never cleared when compaction starts, so the new `message_start` after compaction appends to the old message via the existing-streaming-message branch |
| 3 | P2 | Compact summary card uses different expand/collapse styling than long user messages | `CompactSummaryCard` uses a `bg-gradient-to-t` overlay div + `text-xs` button, while `CollapsibleUserMessage` uses CSS `maskImage` fade + a `rounded-md border` button with backdrop blur |

---

## Bug 1: Assistant Message Looks "Done" During Compaction

### Root Cause (detailed)

During auto-compaction, the SDK internally ends the current assistant message before starting the compaction process. The event sequence is:

```
1. message_delta(stop_reason: end_turn)  →  applyStreamingEventToMessage() calls finalizeStreamingMessage()
                                             → message.isStreaming = false
                                             → tool calls show "done" state / action buttons
                                             → LoadingDots disappear from the message

2. result (sometimes)                    →  streamingMessageId = null, loading = false
                                             → assistantTurnActive = false
                                             → hover action row becomes hoverable

3. system/status: "compacting"           →  CompactingIndicator appears below

Gap between steps 1-2 and step 3: the assistant message briefly (or permanently until compact_boundary) looks fully completed.
```

In `streaming.ts:201-203`:
```typescript
if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
  return finalizeStreamingMessage(message);  // ← sets isStreaming: false
}
```

This `isStreaming: false` propagates to `MessageBubble` at line 493 (`const isStreaming = message.isStreaming ?? false`) and then to `ContentBlockRenderer` at line 663 (`isStreaming={isStreaming}`), causing tool calls to transition to their finalized visual state.

### Fix

When compaction is active, the last assistant message should maintain a "turn still in progress" appearance — tool calls stay in their "running" visual state and the hover action row is suppressed. The LoadingDots on the message are NOT shown (the CompactingIndicator handles the "still working" signal separately, and the user confirmed it works well).

**Implementation:**

#### 1a. Track the "prior message" when compaction starts

Add new refs in `Chat.tsx` alongside the existing compaction refs:

```typescript
// ID of the assistant message that was active when compaction started.
// Used to suppress its "finalized" appearance while compacting.
const compactingPriorMessageIdRef = useRef<string | null>(null);
// Expose as state so it triggers a re-render for MessageBubble props
const [compactingPriorMessageId, setCompactingPriorMessageId] = useState<string | null>(null);

// ID of the assistant message from the most recently completed turn.
// Used as a fallback when `streamingMessageIdRef` is already null
// (result fired before compaction started). Scoped to the current turn
// so we never accidentally suppress an unrelated historical message.
const lastCompletedAssistantMessageIdRef = useRef<string | null>(null);
```

Set `lastCompletedAssistantMessageIdRef` in the `result` handler (around line 2060-2083), **before** clearing `streamingMessageId`:

```typescript
} else if (sdkEvent.type === 'result') {
  // ... existing code ...
  const msgId = streamingMessageIdRef.current;
  // Capture the just-finished message ID for compaction prior-message tracking
  lastCompletedAssistantMessageIdRef.current = msgId;
  // ... rest of result handler (finalizeStreamingMessage, setStreamingMessageId(null), etc.) ...
```

Do the same in the `error` handler — set `lastCompletedAssistantMessageIdRef.current = streamingMessageIdRef.current` before clearing.

Clear `lastCompletedAssistantMessageIdRef` when a **new user turn starts** (not mid-stream split). In `sendMessage()`, in the path where `wasSentDuringStreaming === false`:

```typescript
lastCompletedAssistantMessageIdRef.current = null;
```

Also clear it on reconnect reset (in `connectWebSocket`'s initial state reset).

#### 1b. Set the prior message ID when compaction starts

In the `system/status: "compacting"` handler (Chat.tsx, around line 1931-1938):

```typescript
if (status === 'compacting') {
  isAutoCompactingRef.current = true;
  syncCompactionIndicator();

  // Track which assistant message was active for visual continuity.
  // Use streamingMessageId (mid-stream compaction) or the just-completed
  // turn's message ID (result fired first). Do NOT scan message history —
  // that could target an unrelated older message (e.g. manual /compact while idle).
  const priorId = streamingMessageIdRef.current
    ?? lastCompletedAssistantMessageIdRef.current
    ?? null;
  compactingPriorMessageIdRef.current = priorId;
  setCompactingPriorMessageId(priorId);
}
```

Do the same in the `content_block_start(type: compaction)` fallback handler (Chat.tsx, around line 1777-1784):

```typescript
if (evt?.type === 'content_block_start' && evt?.content_block?.type === 'compaction') {
  // ... existing code ...
  isAutoCompactingRef.current = true;
  syncCompactionIndicator();

  // Track prior message (same turn-scoped logic as system/status handler)
  const priorId = streamingMessageIdRef.current
    ?? lastCompletedAssistantMessageIdRef.current
    ?? null;
  compactingPriorMessageIdRef.current = priorId;
  setCompactingPriorMessageId(priorId);
  return;
}
```

#### 1c. Clear the prior message ID when compaction ends

In every path that clears compaction state, also clear the prior message ref. These paths are:

- `compact_boundary` handler (around line 1940-1961)
- `content_block_stop` handler for compaction summary (around line 1791-1829)
- `isCompactSummary` user event handler (around line 1971-2020)
- `system/status` handler with `status === null` (around line 1936-1938)
- `result` handler (around line 2060-2083)
- `error` handler
- Reconnect reset
- Reconnect-exhausted `onclose`

In each, add:
```typescript
compactingPriorMessageIdRef.current = null;
setCompactingPriorMessageId(null);
```

The `status === null` path is important: if the compact summary forwarding is delayed/missed, `status: null` may be the only timely completion signal, and stale suppression state must not linger.

#### 1d. Thread prop through `ChatMessagesView`

`ChatMessagesView` is a separate `memo()`-wrapped component (line 509) with its own props interface (line 483). The new `compactingPriorMessageId` must be explicitly threaded through it.

1. Add to `ChatMessagesViewProps` (around line 483):
   ```typescript
   interface ChatMessagesViewProps {
     // ... existing props ...
     compactingPriorMessageId: string | null;
   }
   ```

2. Destructure in `ChatMessagesView` (around line 509):
   ```typescript
   const ChatMessagesView = memo(function ChatMessagesView({
     // ... existing ...
     compactingPriorMessageId,
   }: ChatMessagesViewProps) {
   ```

3. Pass at the call site (around line 3513):
   ```tsx
   <ChatMessagesView
     // ... existing props ...
     compactingPriorMessageId={compactingPriorMessageId}
   />
   ```

4. Inside `ChatMessagesView`'s `visibleMessages.map()` (around line 559-583), pass to `MessageBubble`:
   ```tsx
   <MessageBubble
     message={msg}
     onCopy={copyMessage}
     copiedId={copiedMessageId}
     showStreamingIndicator={assistantTurnActive && msg.id === activeAssistantMessageId}
     suppressFinalizedState={isCompacting && msg.id === compactingPriorMessageId}
     skillSheets={skillSheetsByToolId}
     hostname={hostname}
     orgSlug={orgSlug}
   />
   ```

#### 1e. Update MessageBubble to use the flag

In `message-bubble.tsx`:

1. Add the prop to `MessageBubbleProps`:
   ```typescript
   interface MessageBubbleProps {
     // ... existing props ...
     /** When true, keep tool calls in "running" state and suppress hover actions (used during compaction) */
     suppressFinalizedState?: boolean;
   }
   ```

2. Destructure it in the component:
   ```typescript
   export function MessageBubble({
     // ... existing ...
     suppressFinalizedState = false,
   }: MessageBubbleProps) {
   ```

3. Compute effective streaming state (around line 493):
   ```typescript
   const isStreaming = (message.isStreaming ?? false) || suppressFinalizedState;
   ```

4. Conditionally hide the assistant message hover action row (around line 666-691). The hover row for assistant messages is currently:
   ```tsx
   {hasContent && (
     <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 ...">
   ```
   Change to:
   ```tsx
   {hasContent && !suppressFinalizedState && (
     <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 ...">
   ```

   This hides the timestamp + copy button row during compaction, so the message doesn't look "done" on hover.

---

## Bug 2: Post-Compaction Content Streams Above Compact Card

### Root Cause (detailed)

When auto-compaction happens mid-stream, `streamingMessageId` is never cleared. After compaction finishes and the SDK starts a new assistant message, the new `message_start` event hits the "existing streaming message" branch in Chat.tsx (around line 1876-1881):

```typescript
if (existingStreamingMsg) {
  // Claude emits a new message_start after each tool call; append to the active turn.
  setMessages(prev => prev.map(msg =>
    msg.id === existingStreamingId ? applyStreamingEventToMessage(msg, sdkEvent) : msg
  ));
  return;
}
```

This applies the new content to the OLD assistant message (which is above the compact card in the message array), rather than creating a new message below the compact card.

The `existingStreamingMsg` lookup (line 1835-1836) finds the message by ID (not by `isStreaming` flag), so even though `finalizeStreamingMessage` set `isStreaming: false`, the message is still found because `streamingMessageIdRef.current` still holds its ID.

### Fix

Clear `streamingMessageId` when compaction starts so that the post-compaction `message_start` creates a NEW assistant message appended to the end of the messages array (after the compact card).

**Implementation:**

#### 2a. Clear streamingMessageId when compaction starts

In the `system/status: "compacting"` handler (same location as Bug 1 fix, around line 1931-1938), **after** capturing `compactingPriorMessageIdRef`, add:

```typescript
if (status === 'compacting') {
  isAutoCompactingRef.current = true;
  syncCompactionIndicator();

  // Bug 1: capture turn-scoped prior message ID (see 1b for full logic)
  const priorId = streamingMessageIdRef.current
    ?? lastCompletedAssistantMessageIdRef.current
    ?? null;
  compactingPriorMessageIdRef.current = priorId;
  setCompactingPriorMessageId(priorId);

  // Bug 2: clear streaming ID so post-compaction content creates a new message
  if (streamingMessageIdRef.current) {
    setStreamingMessageId(null);
  }
}
```

Do the same in the `content_block_start(type: compaction)` fallback handler (around line 1777-1784):

```typescript
if (evt?.type === 'content_block_start' && evt?.content_block?.type === 'compaction') {
  // ... existing code ...
  isAutoCompactingRef.current = true;
  syncCompactionIndicator();

  // Bug 1: capture turn-scoped prior message ID (see 1b)
  const priorId = streamingMessageIdRef.current
    ?? lastCompletedAssistantMessageIdRef.current
    ?? null;
  compactingPriorMessageIdRef.current = priorId;
  setCompactingPriorMessageId(priorId);

  // Bug 2: clear streaming ID so post-compaction content creates a new message
  if (streamingMessageIdRef.current) {
    setStreamingMessageId(null);
  }
  return;
}
```

#### 2b. Verify the new message_start flow

After the fix, when `message_start` arrives after compaction:

1. `streamingMessageIdRef.current` is `null`
2. `existingStreamingMsg` is `undefined` (no message found by null ID)
3. `fallbackStreamingMsg` = `currentMsgs.find(m => m.isStreaming)` — will be `undefined` since the old message was finalized (`isStreaming: false`)
4. Code falls through to "Add new assistant message" branch (line 1892-1909)
5. New message is appended at the END of the array (after the compact card)

Result: messages array is `[old_assistant, compact_card, new_assistant]` — correct order.

#### 2c. Edge case: `result` fires before compaction

If `result` fires first, it already clears `streamingMessageId` (line 2076). The Bug 2 fix's `if (streamingMessageIdRef.current)` check is a no-op in this case — harmless.

#### 2d. Edge case: content_block_start fires without system/status

If `system/status: "compacting"` is unavailable (older SDK), the `content_block_start(type: compaction)` handler is the fallback. The same fix applies there (clearing `streamingMessageId`).

---

## Bug 3: Compact Summary Card Styling Mismatch

### Current vs Target

The compact summary card currently uses a **different** expand/collapse pattern than `CollapsibleUserMessage`:

| Aspect | `CollapsibleUserMessage` (target) | `CompactSummaryCard` (current) |
|--------|-----------------------------------|-------------------------------|
| Fade effect | CSS `maskImage: linear-gradient(to bottom, black 85%, transparent 100%)` — text itself fades to transparent | `bg-gradient-to-t from-background to-transparent` overlay div — gradient rectangle sits on top of text |
| Max height | `300px` | `200px` |
| Overflow detection | `ResizeObserver` + `useLayoutEffect` (dynamic, rechecks on resize) | `useEffect` checking `scrollHeight` once on content change |
| Button style (collapsed) | `absolute bottom-2 right-2 opacity-0 group-hover/msg:opacity-100 transition-opacity` — hidden until hover, with `rounded-md border border-border bg-background/80 px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-accent backdrop-blur-sm` | Always visible, `text-xs text-muted-foreground hover:text-foreground` with `ChevronDown` icon |
| Button style (expanded) | `relative bottom-auto right-auto mt-1 flex justify-end` — flows below content | Same position as collapsed |
| Collapse scroll | `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` | None |
| Group scope | `group/msg` named group for isolated hover targeting | None |

### Fix

Refactor `CompactSummaryCard` to use the same collapsible pattern as `CollapsibleUserMessage`. The card's structural styling (border, background, header) stays the same — only the expand/collapse mechanism and button styling change.

**Implementation:**

#### 3a. Update `compact-summary-card.tsx`

Replace the current expand/collapse implementation with the `CollapsibleUserMessage` pattern. The full updated component:

```tsx
'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ContentBlock } from '@/types';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

const MAX_COLLAPSED_HEIGHT = 300;
const MASK_FADE = 'linear-gradient(to bottom, black 85%, transparent 100%)';

interface CompactSummaryCardProps {
  content: string | ContentBlock[];
}

export function CompactSummaryCard({ content }: CompactSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const displayContent = typeof content === 'string'
    ? content
    : content
        .map(b => (b.type === 'text' ? b.text : ''))
        .filter(Boolean)
        .join('\n');

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const checkOverflow = () => {
      setIsOverflowing(element.scrollHeight > MAX_COLLAPSED_HEIGHT);
    };

    checkOverflow();

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const handleCollapse = () => {
    setIsExpanded(false);
    requestAnimationFrame(() => {
      contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const collapsed = isOverflowing && !isExpanded;

  return (
    <div className={cn(
      'compact-summary mt-1 mb-4 rounded-lg border border-border/50 bg-muted/10 px-4 py-3',
      isOverflowing && 'group/msg',
    )}>
      {/* Header */}
      <div className="mb-2">
        <span className="text-sm text-muted-foreground font-medium">
          Context compacted
        </span>
      </div>

      {/* Body */}
      <div className="relative">
        <div
          ref={contentRef}
          className={cn(
            'text-sm text-muted-foreground/80',
            collapsed && 'overflow-hidden',
          )}
          style={collapsed ? {
            maxHeight: MAX_COLLAPSED_HEIGHT,
            maskImage: MASK_FADE,
            WebkitMaskImage: MASK_FADE,
          } : undefined}
        >
          <MarkdownRenderer content={displayContent} />
        </div>

        {isOverflowing && (
          <div className={cn(
            'absolute bottom-2 right-2 opacity-0 group-hover/msg:opacity-100 transition-opacity',
            isExpanded && 'relative bottom-auto right-auto mt-1 flex justify-end',
          )}>
            <button
              type="button"
              onClick={isExpanded ? handleCollapse : () => setIsExpanded(true)}
              className="rounded-md border border-border bg-background/80 px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-accent backdrop-blur-sm"
            >
              {isExpanded ? 'Show less' : 'Show more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

Key changes from the current implementation:
1. **`useLayoutEffect` with `ResizeObserver`** replaces `useEffect` with `scrollHeight` check — matches `CollapsibleUserMessage` exactly
2. **CSS `maskImage` fade** replaces the gradient overlay `<div>` — the text itself fades to transparent rather than having a gradient rectangle on top
3. **`MAX_COLLAPSED_HEIGHT` changed to `300`** (from `200`) — matches `CollapsibleUserMessage`
4. **Button styling** matches `CollapsibleUserMessage` exactly: `rounded-md border border-border bg-background/80 px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-accent backdrop-blur-sm`
5. **Button positioning** matches: `absolute bottom-2 right-2 opacity-0 group-hover/msg:opacity-100` when collapsed, `relative` when expanded
6. **`group/msg` named group** added to the card container for isolated hover targeting
7. **`handleCollapse`** with smooth scroll — matches `CollapsibleUserMessage`
8. **`ChevronDown` icon removed** — `CollapsibleUserMessage` doesn't use one; button text alone ("Show more"/"Show less") is sufficient
9. Remove the `lucide-react` import for `ChevronDown` (no longer needed)

---

## Combined Implementation Order

Execute these steps in order:

### Step 1: Bug 2 + Bug 1 state management (Chat.tsx)

These changes are interrelated and should be done together.

1. Add `compactingPriorMessageIdRef`, `compactingPriorMessageId` state, and `lastCompletedAssistantMessageIdRef`
2. Set `lastCompletedAssistantMessageIdRef` in `result` and `error` handlers (before clearing `streamingMessageId`)
3. Clear `lastCompletedAssistantMessageIdRef` in `sendMessage` (non-mid-stream path) and reconnect reset
4. In `system/status: "compacting"` handler: capture prior message ID (turn-scoped: `streamingMessageIdRef ?? lastCompletedAssistantMessageIdRef ?? null`), clear `streamingMessageId`
5. In `content_block_start(type: compaction)` handler: same changes as above
6. In all compaction-end paths (including `status === null`): clear `compactingPriorMessageIdRef` and `compactingPriorMessageId`
7. Thread `compactingPriorMessageId` through `ChatMessagesViewProps` → `ChatMessagesView` call site → `MessageBubble` via `suppressFinalizedState={isCompacting && msg.id === compactingPriorMessageId}`

### Step 2: Bug 1 visual suppression (message-bubble.tsx)

1. Add `suppressFinalizedState` prop to `MessageBubbleProps`
2. Compute `effectiveIsStreaming` using `(message.isStreaming ?? false) || suppressFinalizedState`
3. Use `effectiveIsStreaming` in place of current `isStreaming` for `ContentBlockRenderer`'s `isStreaming` prop
4. Conditionally hide assistant hover action row when `suppressFinalizedState` is true

### Step 3: Bug 3 styling (compact-summary-card.tsx)

1. Replace the full component with the updated version from the design above
2. Remove the gradient overlay `<div>` and `ChevronDown` icon
3. Add CSS `maskImage` fade, `ResizeObserver`, `group/msg` scope, matching button styling

### Step 4: Tests

See the **Automated Tests** section below.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/Chat.tsx` | Add `compactingPriorMessageIdRef` + state; clear `streamingMessageId` on compaction start; clear prior message ref on compaction end; pass `suppressFinalizedState` prop |
| `src/components/message-bubble.tsx` | Add `suppressFinalizedState` prop; compute `effectiveIsStreaming`; conditionally hide hover actions |
| `src/components/compact-summary-card.tsx` | Replace expand/collapse with `CollapsibleUserMessage` pattern (maskImage, ResizeObserver, matching button styling, 300px max height) |

## Files NOT Modified

| File | Reason |
|------|--------|
| `sandbox/control-plane.mjs` | Already broadcasts all SDK events correctly |
| `workers/main/src/durable-objects.ts` | Event forwarding works correctly |
| `src/components/compacting-indicator.tsx` | Already works well (user confirmed) |
| `src/components/collapsible-user-message.tsx` | Reference only — we copy its patterns into compact-summary-card |
| `src/lib/streaming.ts` | `finalizeStreamingMessage` behavior is correct; we override at the component level |
| `src/types.ts` | No type changes needed |

---

## Automated Tests

The core UX fixes are UI-state-sensitive and easy to regress. Add targeted tests:

### 4a. Compaction message ordering (extend existing compaction integration tests)

File: `tests/compact-message.test.tsx` (or equivalent)

Add a test that simulates the full auto-compaction event sequence and asserts the final message order:

1. Simulate assistant streaming (message_start + content_block_start/delta/stop)
2. Simulate `message_delta(stop_reason: end_turn)` → message finalized
3. Simulate `system/status: "compacting"`
4. Simulate compaction content blocks → compact summary card inserted
5. Simulate `compact_boundary`
6. Simulate new `message_start` → new assistant message created
7. **Assert** final messages array is ordered: `[pre-compaction assistant, compact summary (isCompactSummary: true), post-compaction assistant]`
8. **Assert** the post-compaction assistant message has a DIFFERENT ID from the pre-compaction one

### 4b. MessageBubble `suppressFinalizedState` rendering

File: `tests/message-bubble.test.tsx` (or equivalent)

1. Render `MessageBubble` with `message.isStreaming = false` and `suppressFinalizedState = true`
2. **Assert** `ContentBlockRenderer` receives `isStreaming={true}` (tool calls stay in running state)
3. **Assert** the assistant hover action row (`role="group" aria-label="Message actions"`) is NOT rendered
4. Render the same message with `suppressFinalizedState = false`
5. **Assert** `ContentBlockRenderer` receives `isStreaming={false}`
6. **Assert** the hover action row IS rendered

### 4c. CompactSummaryCard ResizeObserver compatibility

File: `tests/compact-summary-card.test.tsx` (or equivalent)

The updated `CompactSummaryCard` uses `ResizeObserver` (via `useLayoutEffect`). Test environments (jsdom) may not provide `ResizeObserver`. Either:

- **Option A (preferred):** Stub `ResizeObserver` in the test setup file:
  ```typescript
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  ```
- **Option B:** Guard in the component: `if (typeof ResizeObserver !== 'undefined')` before creating the observer (less clean but defensive)

Then test:
1. Render with short content → "Show more" button should NOT appear
2. Render with content exceeding 300px → "Show more" button should appear (mock `scrollHeight` via the stub)

---

## Verification

### Bug 1
- [ ] Trigger auto-compaction (fill context in a long conversation). When compaction starts, the last assistant message should NOT show its hover action row (timestamp + copy button) and tool calls should remain in their "running" visual state (no action buttons on tool calls).
- [ ] The CompactingIndicator ("Compacting conversation...") should still appear below the message as it does today.
- [ ] When compaction completes and the compact summary card appears, the prior message should transition to its normal finalized state (hover actions available).

### Bug 2
- [ ] Trigger auto-compaction. After the compact summary card appears, new assistant content should stream into a NEW message BELOW the compact card — not into the old message above it.
- [ ] The message order should be: `[old_assistant, compact_card, new_assistant]`
- [ ] The LoadingDots should appear on the new assistant message (below the compact card), not above it.

### Bug 3
- [ ] Long compact summaries should fade using CSS `maskImage` (text fades to transparent) — NOT a gradient overlay div.
- [ ] The "Show more" button should match the user message button exactly: rounded-md border, bg-background/80, backdrop-blur-sm, px-4 py-1.5, text-sm.
- [ ] Button should be hidden by default, appearing on hover (group-hover/msg pattern).
- [ ] "Show less" button should be always visible when expanded, positioned below content.
- [ ] Clicking "Show less" should smooth-scroll the card into view.
- [ ] Max collapsed height should be 300px (matching user messages).
- [ ] Verify in both light and dark mode.

### Regression
- [ ] Manual `/compact` command still works: shows CompactingIndicator, produces summary card, clears indicator.
- [ ] Normal streaming (no compaction) is unaffected: dots appear on message, hover actions appear when turn completes.
- [ ] Reconnect mid-compaction: stale state is cleared on reconnect.
- [ ] Page reload: compact summary cards render correctly from JSONL history.
