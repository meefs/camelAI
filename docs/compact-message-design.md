# Compact Message UX Design

## Problem

When the Claude SDK's context window fills up, it automatically **compacts** the conversation: it summarizes everything so far into a single message and continues from that summary. Currently:

1. **During live streaming**, the compact summary arrives as a `user` SDK event without `isMeta` set, so it gets marked as a meta message and **hidden entirely**. The user gets no indication compaction happened.
2. **On page reload** (history loaded from JSONL), the compact summary has no `isMeta` or `sourceToolUseID` flags, so it falls through to the regular user message branch and **appears as a user-sent message bubble** (right-aligned, looks like the user typed it).

Both behaviors are wrong. Compaction is a significant system event that users should understand, especially since it can take time.

## Event Shape (from Claude SDK)

Two JSONL events mark compaction:

**1. Compact boundary** (compaction starts):
```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "content": "Conversation compacted",
  "compactMetadata": { "trigger": "auto", "preTokens": 175095 },
  "uuid": "f6645935-..."
}
```

**2. Compact summary** (compaction complete, new context):
```json
{
  "type": "user",
  "message": { "role": "user", "content": "This session is being continued from a previous conversation..." },
  "isVisibleInTranscriptOnly": true,
  "isCompactSummary": true,
  "uuid": "8678670b-..."
}
```

Both flow through `claude-runner.mjs` → `ChatThreadDO` → client WebSocket as `sdk_event` wrappers. No special handling exists for either today.

---

## Design

### Two UI states

#### State 1: Compaction In-Progress

When we receive `compact_boundary`, show a centered system indicator. This communicates that something is happening while the user waits. It should feel like a system notification, not a message from either party.

```
                            ┌──────────────────────────────────┐
                            │  ◐  Compacting conversation...   │
                            └──────────────────────────────────┘
```

- Centered in the message stream (not left-aligned like assistant, not right-aligned like user)
- Pulsing/animated indicator (reuse the blue pulsing dot pattern from tool calls)
- Text: "Compacting conversation..."
- Muted, subtle appearance: `text-muted-foreground`, `text-sm`
- Disappears when the compact summary arrives (replaced by State 2)
- If the user scrolls up and back, this should not persist in history

#### State 2: Compact Summary (completed)

Once the summary arrives, replace the in-progress indicator with a compact summary card. This is the persistent view that also renders when loading from history.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   ● Context compacted                                               │
  │                                                                     │
  │   This session is being continued from a previous conversation      │
  │   that ran out of context. The summary below covers the earlier     │
  │   portion of the conversation.                                      │
  │                                                                     │
  │   Analysis:                                                         │
  │   Let me go through the conversation chronologically to capture     │
  │   all details:                                                      │
  │                                                                     │
  │   1. **Initial Request**: User asked for an SVG animator website    │
  │   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │   ░░░░░░░░░░░░░░░  (gradient fade to background)  ░░░░░░░░░░░░░░░ │
  │                                                                     │
  │                                                        Show more ▾  │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

**Expanded state** (after clicking "Show more"):

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   ● Context compacted                                               │
  │                                                                     │
  │   This session is being continued from a previous conversation      │
  │   that ran out of context. The summary below covers the earlier     │
  │   portion of the conversation.                                      │
  │                                                                     │
  │   Analysis:                                                         │
  │   Let me go through the conversation chronologically to capture     │
  │   all details:                                                      │
  │                                                                     │
  │   1. **Initial Request**: User asked for an SVG animator website    │
  │      where you upload an SVG and it gets animated.                  │
  │                                                                     │
  │   2. **Architecture Decisions**: We built it as a single-page app   │
  │      with drag-and-drop upload and real-time preview...             │
  │                                                                     │
  │   ... (full summary content, rendered as markdown) ...              │
  │                                                                     │
  │                                                        Show less ▴  │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

**Design details:**

- Full-width, left-aligned (like assistant messages, not right-aligned like user)
- Container: `border border-border/50 rounded-lg bg-muted/10` — subtle card, not a heavy box
- Header row: green status dot (`bg-green-500`, like completed tool calls) + "Context compacted" in `text-sm text-muted-foreground font-medium`
- Summary body: rendered with `<MarkdownRenderer>` (supports bold, lists, code, etc.)
- **Collapsed state** (default): `max-h-[200px]` with `overflow-hidden` and a gradient overlay fading to the card background at the bottom. "Show more" button positioned at the bottom-right of the card, visible on hover or always visible if content overflows.
- **Expanded state**: full height, "Show less" button at bottom-right
- The "Show more" / "Show less" button: `text-xs text-muted-foreground hover:text-foreground` with a small chevron icon, always visible when content overflows (not just on hover — since the fade already implies there's more)
- No copy button, no timestamp in the hover row (this is a system event, not a conversation turn)

---

## Implementation

### 1. Add `isCompactSummary` flag to Message type

**File: `src/types.ts`**

Add an optional boolean to the `Message` interface:

```typescript
export interface Message {
  // ... existing fields ...
  /** True when this message is a compaction summary (system-generated context recap) */
  isCompactSummary?: boolean;
}
```

### 2. Add `isCompacting` state flag to Message type

We also need a way to represent the in-progress compaction state. Rather than adding a new message type, we'll use a simple boolean state in Chat.tsx (see step 5).

### 3. Handle compact events in JSONL history parser

**File: `src/lib/chat-do.server.ts`** — in the `getMessages()` function, around line 354

Currently, the `event.type === 'user'` branch doesn't check for `isCompactSummary`. The compact summary has `isCompactSummary: true` and `isVisibleInTranscriptOnly: true`, but neither `isMeta` nor `sourceToolUseID`, so it falls through to the regular user message path.

**Changes needed:**

Inside the `if (event.type === 'user' && event.message?.content)` block, add a check for `isCompactSummary` **before** the existing meta/regular branches:

```typescript
if (event.type === 'user' && event.message?.content) {
  // ... existing meta detection code ...

  // NEW: Detect compact summary messages
  const isCompactSummary = Boolean(event.isCompactSummary);

  if (isToolResult) {
    // ... existing tool result handling ...
  } else if (isCompactSummary) {
    // Compact summaries are system-generated context recaps, not real user messages.
    // Flush any pending assistant segments (compaction marks a boundary).
    flushAssistantGroup();
    const createdAt = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
    const id = event.uuid || `compact_${messages.length}`;
    messages.push({
      id,
      thread_id: threadId,
      role: 'user',
      content: event.message.content,
      created_at: createdAt,
      isCompactSummary: true,
    });
  } else if (isMeta || resolvedToolUseId) {
    // ... existing meta handling ...
  } else {
    // ... existing regular user message handling ...
  }
}
```

Also skip `compact_boundary` system events (they don't need to be in history — the summary replaces them):

```typescript
// Skip compact_boundary system events (transient, the summary replaces them)
if (event.type === 'system' && event.subtype === 'compact_boundary') {
  continue;
}
```

### 4. Handle compact events in live WebSocket streaming

**File: `src/components/Chat.tsx`** — in the `ws.onmessage` handler, inside the `data.type === 'sdk_event'` branch

**4a. Handle `compact_boundary` (compaction starts)**

In the `sdkEvent.type === 'system'` check (currently only handles `subtype === 'init'`), add handling for `compact_boundary`:

```typescript
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
  splitStreamingMessageOnNextPartRef.current = false;
  setStreamingMessageId(null);
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
  // Compaction started — show loading indicator
  setIsCompacting(true);
}
```

**4b. Handle compact summary (compaction complete)**

In the `sdkEvent.type === 'user'` branch, check for `isCompactSummary` before the existing logic:

```typescript
} else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
  // NEW: Check for compact summary
  const isCompactSummary = Boolean(
    (sdkEvent as Record<string, unknown>).isCompactSummary
  );

  if (isCompactSummary) {
    // Clear compacting state and add compact summary message
    setIsCompacting(false);
    const content = sdkEvent.message.content;
    const compactMsg: Message = {
      id: (sdkEvent as { uuid?: string }).uuid || `compact_${Date.now()}`,
      thread_id: id,
      role: 'user',
      content: typeof content === 'string' ? content : content,
      created_at: Date.now(),
      isCompactSummary: true,
    };
    setMessages(prev => [...prev, compactMsg]);
    return;
  }

  // ... existing tool result / meta handling ...
}
```

### 5. Add `isCompacting` state to Chat.tsx

**File: `src/components/Chat.tsx`**

Add a new state variable alongside the existing streaming state:

```typescript
const [isCompacting, setIsCompacting] = useState(false);
```

Clear it on `result` events and on errors (alongside the existing `setLoading(false)` calls), so that if compaction is abandoned or the session ends, the indicator goes away:

- In the `result` handler (around line 973): add `setIsCompacting(false);`
- In the `error` handler (around line 1008): add `setIsCompacting(false);`

### 6. Render compact messages in the message list

**File: `src/components/Chat.tsx`** — in the `visibleMessages.map()` render loop

Currently, `visibleMessages` is filtered to exclude meta/sub-agent messages. The compact summary has `role: 'user'` and `isCompactSummary: true`, and is NOT meta, so it will pass through the filter. It will then be rendered by `<MessageBubble>`.

**6a. Update the visible messages filter**

The compact summary should pass through the existing filter (it's not `isMeta` and has no `sourceToolUseID`), so no filter changes are needed.

**6b. Render the compacting indicator**

Below the last message (and above the loading dots / input area), render the compacting indicator when `isCompacting` is true:

```tsx
{isCompacting && (
  <CompactingIndicator />
)}
```

Place this in the message list area, after the `visibleMessages.map()` block and before the loading dots, so it appears at the bottom of the conversation stream.

### 7. Update MessageBubble to handle compact messages

**File: `src/components/message-bubble.tsx`**

At the top of the `MessageBubble` component, before the existing `isMeta` check, add a check for compact summaries:

```tsx
if (message.isCompactSummary) {
  return <CompactSummaryCard content={message.content} />;
}
```

This short-circuits the normal user/assistant rendering path entirely.

### 8. Create the CompactSummaryCard component

**New file: `src/components/compact-summary-card.tsx`**

This is the main new UI component. It renders the compact summary in a styled card with collapse/expand behavior.

**Props:**
```typescript
interface CompactSummaryCardProps {
  content: string | ContentBlock[];
}
```

**Component structure:**
```tsx
function CompactSummaryCard({ content }: CompactSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Check if content overflows the collapsed height
  useEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > COLLAPSED_MAX_HEIGHT);
    }
  }, [content]);

  const displayContent = typeof content === 'string'
    ? content
    : content.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');

  return (
    <div className="compact-summary my-4 rounded-lg border border-border/50 bg-muted/10 px-4 py-3">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
        <span className="text-sm text-muted-foreground font-medium">
          Context compacted
        </span>
      </div>

      {/* Body */}
      <div className="relative">
        <div
          ref={contentRef}
          className={cn(
            "text-sm text-muted-foreground/80 overflow-hidden",
            !isExpanded && "max-h-[200px]"
          )}
        >
          <MarkdownRenderer content={displayContent} />
        </div>

        {/* Gradient fade overlay (only when collapsed and overflowing) */}
        {!isExpanded && isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-muted/10 to-transparent pointer-events-none" />
        )}
      </div>

      {/* Show more / Show less button */}
      {isOverflowing && (
        <div className="flex justify-end mt-1">
          <button
            type="button"
            onClick={() => setIsExpanded(prev => !prev)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            {isExpanded ? 'Show less' : 'Show more'}
            <ChevronDown className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")} />
          </button>
        </div>
      )}
    </div>
  );
}
```

**Gradient note:** The gradient fades from the card's background color to transparent. Since the card uses `bg-muted/10`, the gradient's `from` color should match. If the exact color is hard to match with a utility class, use `from-background` as an approximation (the card background is nearly transparent so the page background shows through). The implementer should verify this looks correct in both light and dark mode and adjust accordingly.

**`COLLAPSED_MAX_HEIGHT`**: Set to `200` (pixels). This allows roughly 8-10 lines of summary text to show before fading. The implementer can tune this value.

### 9. Create the CompactingIndicator component

**New file: `src/components/compacting-indicator.tsx`**

A simple centered indicator shown while compaction is in progress.

```tsx
export function CompactingIndicator() {
  return (
    <div className="flex justify-center py-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
        <span>Compacting conversation...</span>
      </div>
    </div>
  );
}
```

This matches the tool call aesthetic (status dot + description text) but is centered to signal it's a system event, not a message from either party.

### 10. Handle edge case: result event clears compacting

If the runner exits or a `result` event arrives while compaction was in progress (e.g., an error), the compacting indicator should be cleared. This is already covered by step 5 (clearing on `result` and `error` events).

---

## Files to modify (summary)

| File | Change |
|------|--------|
| `src/types.ts` | Add `isCompactSummary?: boolean` to `Message` interface |
| `src/lib/chat-do.server.ts` | Detect `isCompactSummary` in JSONL parser; skip `compact_boundary` |
| `src/components/Chat.tsx` | Add `isCompacting` state; handle `compact_boundary` and `isCompactSummary` SDK events; render `<CompactingIndicator>` |
| `src/components/message-bubble.tsx` | Short-circuit to `<CompactSummaryCard>` for `isCompactSummary` messages |
| `src/components/compact-summary-card.tsx` | **New** — collapsible compact summary card |
| `src/components/compacting-indicator.tsx` | **New** — centered loading indicator |

## Components used

- `MarkdownRenderer` (existing) — for rendering the summary text
- `cn()` from `@/lib/utils` (existing) — for conditional class merging
- `ChevronDown` from `lucide-react` (existing) — for the expand/collapse toggle
- No new shadcn/ui components needed; the card is custom-styled with Tailwind to match the tool call aesthetic

## Not in scope

- Persisting compaction state in ChatThreadDO for replay (compaction is fast enough that replay isn't necessary; if the user reconnects mid-compaction, the summary will arrive shortly after)
- Showing compaction metadata (token count, trigger reason) — this could be a future enhancement
- Handling multiple compactions in a single session (the design works naturally for this case; each compaction produces its own summary card)
