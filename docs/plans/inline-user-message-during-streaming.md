# Plan: Inline User Message Styling During Assistant Streaming

## Problem Statement

When a user sends a message while the assistant is still streaming, the current "new page" animation (spacer calculation + scroll-to-top) creates a jarring experience. The animation triggers the page-up effect, but the assistant message continues streaming from its previous position, creating visual confusion.

## Desired Behavior

- **Normal case (assistant completed)**: Keep the fancy animation - user message scrolls to top, spacer fills viewport, assistant response streams in while spacer shrinks.
- **During streaming case**: Skip the fancy animation entirely. The user message should appear inline like an "old message" - no spacer calculation, no forced scroll-up. This visually communicates that the user is "chiming in" on the current task rather than starting a new one.

## Technical Analysis

### Current Flow (src/components/Chat.tsx)

1. **sendMessage()** (lines 1467-1535):
   - Sets `forceScrollOnNextUpdate.current = true` (line 1511)
   - Adds user message to state
   - Triggers auto-scroll via useLayoutEffect dependency

2. **Auto-scroll useLayoutEffect** (lines 1277-1304):
   - Checks `forceScrollOnNextUpdate.current`
   - If true, always scrolls to bottom with smooth animation

3. **Spacer calculation useLayoutEffect** (lines 1148-1236):
   - Uses `shouldRenderSpacer` to determine if spacer should exist
   - ResizeObserver recalculates as content changes

4. **Streaming detection** (line 276):
   - `isStreaming = streamingMessageId !== null`

### Key Variables

| Variable | Location | Purpose |
|----------|----------|---------|
| `isStreaming` | Line 276 | Boolean - true when assistant is actively streaming |
| `streamingMessageId` | Line 215 | ID of currently streaming message (null if not streaming) |
| `forceScrollOnNextUpdate` | Ref | Forces scroll on next render when true |
| `shouldRenderSpacer` | Line 1014 | Controls whether spacer div is rendered |

## Implementation Plan

### Step 1: Modify sendMessage() to Detect Streaming Context

**File:** `src/components/Chat.tsx`
**Location:** `sendMessage()` function (lines 1467-1535)

Add a check for streaming state before setting the force scroll flag:

```typescript
function sendMessage() {
  if (!input.trim() || !shouldShowChat || !resolvedWorkspaceId || !threadId) {
    return;
  }

  // Capture streaming state BEFORE adding the user message
  const wasSentDuringStreaming = isStreaming;

  // ... existing message creation code ...

  // Only trigger the "new page" animation if NOT streaming
  // When streaming, user is "chiming in" - message appears inline naturally
  if (!wasSentDuringStreaming) {
    forceScrollOnNextUpdate.current = true;
  }

  setMessages(prev => [...prev, userMsg]);

  // ... rest of function ...
}
```

### Step 2: Track "Sent During Streaming" State on Messages

**File:** `src/types.ts`

Add a new optional property to the Message type:

```typescript
export interface Message {
  // ... existing properties ...

  /** True if this user message was sent while assistant was streaming */
  sentDuringStreaming?: boolean;
}
```

**File:** `src/components/Chat.tsx`

Update the user message creation in `sendMessage()`:

```typescript
const userMsg: Message = {
  id: `local_${Date.now()}`,
  thread_id: threadId,
  role: 'user',
  content: userMessage,
  created_at: Date.now(),
  sentDuringStreaming: wasSentDuringStreaming,
};
```

### Step 3: Modify Spacer Behavior for Inline Messages

**File:** `src/components/Chat.tsx`

Update `shouldRenderSpacer` logic (line 1014) to NOT render spacer when the last user message was sent during streaming:

```typescript
// Don't render spacer if the last user message was sent during streaming
// (user was "chiming in" - no new page animation needed)
const shouldRenderSpacer = Boolean(lastUserMessage) &&
  !lastUserMessage.sentDuringStreaming &&
  (isAwaitingAssistant || lastMessage?.role === 'assistant');
```

### Step 4: Maintain Natural Scroll Behavior

The auto-scroll useLayoutEffect (lines 1277-1304) already handles the non-forced case well:

```typescript
// This existing logic will handle inline messages correctly:
if (shouldForce || stickToBottomRef.current || distanceFromBottom < 150) {
  scrollToBottom('smooth');
}
```

When `shouldForce` is false (message sent during streaming):
- If user was already at bottom (`stickToBottomRef.current` or `distanceFromBottom < 150`), scroll continues naturally
- If user had scrolled up, their position is preserved

This is the desired behavior - the message appears and scrolling continues naturally as if it's part of the ongoing stream.

### Step 5: Optional Visual Differentiation (Enhancement)

Consider adding subtle visual styling to differentiate inline user messages:

**File:** `src/components/message-bubble.tsx`

```typescript
// Optionally add a subtle visual indicator that this was an inline message
const isInlineMessage = message.role === 'user' && message.sentDuringStreaming;

// In the JSX, could add a subtle visual treatment:
<div className={cn(
  // ... existing classes ...
  isInlineMessage && "opacity-95" // Subtle visual hint (optional)
)}>
```

> **Note:** This step is optional. The core behavior change (skipping the animation) may be sufficient without additional visual differentiation. Evaluate after implementing steps 1-4.

## Testing Checklist

### Normal Flow (Assistant Completed)
- [ ] Send a message when chat is idle → User message scrolls to top with spacer animation
- [ ] Assistant response streams in → Spacer shrinks as expected
- [ ] Scroll behavior remains smooth throughout

### Inline Flow (During Streaming)
- [ ] Send a message while assistant is streaming → User message appears inline without page-up animation
- [ ] Spacer is NOT created/resized when inline message sent
- [ ] Assistant streaming continues uninterrupted
- [ ] If user was scrolled to bottom, scroll continues naturally
- [ ] If user had scrolled up, their scroll position is preserved

### Edge Cases
- [ ] Send multiple messages rapidly during streaming → Each appears inline correctly
- [ ] Send message right as streaming completes → Correct animation based on timing
- [ ] Thread reload preserves message display (sentDuringStreaming is cosmetic, doesn't affect persistence)
- [ ] New thread after inline message → Next full message triggers normal animation

## Files to Modify

| File | Changes |
|------|---------|
| `src/types.ts` | Add `sentDuringStreaming?: boolean` to Message interface |
| `src/components/Chat.tsx` | 1. Check `isStreaming` in sendMessage() before setting force flag<br>2. Set `sentDuringStreaming` on user message<br>3. Update `shouldRenderSpacer` condition |
| `src/components/message-bubble.tsx` | (Optional) Add subtle visual styling for inline messages |

## Implementation Notes

1. **No backend changes required** - `sentDuringStreaming` is a client-side display flag only; it doesn't need to be persisted or sent to the server.

2. **Ref capture timing** - Capture `isStreaming` at the START of `sendMessage()` before any state updates, to avoid race conditions.

3. **Backward compatibility** - Messages without `sentDuringStreaming` (existing messages, messages from history) will behave as normal (falsy value = normal animation on next send).

4. **The spacer condition change is key** - By checking `!lastUserMessage.sentDuringStreaming`, we ensure the spacer doesn't activate when the user chimes in, which is what causes the current "wonky" behavior.
