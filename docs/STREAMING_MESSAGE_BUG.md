# Streaming Message State Bug

## Summary

We have a race condition in the chat UI where assistant messages either **duplicate** or **disappear** after streaming completes. The bug is in how we convert streaming content to persisted messages in `src/components/Chat.tsx`.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   Next.js UI    │◀────│   Cloudflare Worker  │◀────│ Container (ws-server)│
│   Chat.tsx      │     │   (WebSocket proxy)  │     │   (Claude SDK)      │
└─────────────────┘     └──────────────────────┘     └─────────────────────┘
```

### Event Flow from SDK

The Claude Agent SDK emits these events via WebSocket:

1. **`stream_event`** - Real-time streaming deltas
   - `content_block_start` - New block starting
   - `content_block_delta` - Incremental text/JSON
   - `message_delta` with `stop_reason` - Current message done streaming

2. **`assistant`** - Full/partial message snapshots
   - Emitted multiple times if `includePartialMessages: true`
   - Final one should have `stop_reason` set (e.g., `"end_turn"`, `"tool_use"`)

3. **`user`** - Tool results (comes between assistant turns)

4. **`result`** - Query complete (end of entire conversation turn)

### Frontend State

```typescript
// Messages - persisted/final messages
const [messages, setMessages] = useState<Message[]>([]);

// Streaming - temporary content being built up
const [streaming, setStreaming] = useState<StreamingState>({
  content: ContentBlock[],  // accumulates during streaming
  isStreaming: boolean
});
```

**Render logic**: Shows `messages` array, plus `streaming.content` if not empty.

## The Problem

We need to convert `streaming.content` → a new entry in `messages` **exactly once** when streaming completes. But:

| Approach | Result |
|----------|--------|
| Add message from `message_delta` + `assistant` + `result` | **Duplicates** - all three fire close together with different timestamp IDs |
| Add message only from `assistant` with `stop_reason` | **Disappears** - `stop_reason` sometimes null/missing, `result` clears streaming |
| Add message from `assistant` OR fallback in `result` | **Duplicates** - both handlers fire before React processes state updates |

## Root Cause

1. **Multiple events signal "done"**: `message_delta`, `assistant`, and `result` all indicate the message is complete
2. **Timestamp-based IDs don't dedupe**: `turn_${Date.now()}` generates different IDs milliseconds apart
3. **React state batching**: When `assistant` clears streaming, `result` may still see old state in its callback
4. **`stop_reason` unreliable**: The `assistant` event sometimes has `stop_reason: null` even for complete messages

## What We've Tried

### Attempt 1: Single handler with SDK message ID
```typescript
// Only add from 'assistant' with stop_reason, use SDK's stable ID
if (sdkEvent.type === 'assistant' && sdkEvent.message?.stop_reason) {
  const msgId = sdkEvent.message.id; // stable like "msg_01ABC..."
  // Add message, clear streaming
}
// 'result' just clears streaming
```
**Result**: Messages disappear. The `stop_reason` check fails sometimes.

### Attempt 2: Fallback in result handler
```typescript
// 'assistant' handler same as above
// 'result' adds if streaming content still exists
if (sdkEvent.type === 'result') {
  setStreaming(prev => {
    if (prev.content.length > 0) {
      // Fallback: add streaming content as message
    }
    return { content: [], isStreaming: false };
  });
}
```
**Result**: Duplicates. Both handlers run before state updates propagate.

### Attempt 3: Don't clear streaming in message_delta
```typescript
// message_delta: just mark isStreaming: false, keep content
// assistant: add message using SDK ID, clear streaming
// result: add remaining content as fallback
```
**Result**: Still duplicates. The `assistant` and `result` handlers both see content.

## The Core Tension

```
                    ┌─────────────────────────────────────┐
                    │     Event arrives via WebSocket     │
                    └─────────────────────────────────────┘
                                      │
           ┌──────────────────────────┼──────────────────────────┐
           ▼                          ▼                          ▼
    message_delta              assistant                     result
    (stop_reason)            (stop_reason?)                 (always)
           │                          │                          │
           │     All fire within      │                          │
           │     ~1-10ms of each      │                          │
           │     other                │                          │
           └──────────────────────────┴──────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  Need to add message EXACTLY ONCE   │
                    └─────────────────────────────────────┘
```

## Potential Solutions

### Option A: Track "message added" with a ref
```typescript
const addedMessageIds = useRef<Set<string>>(new Set());

// In any handler that adds a message:
if (!addedMessageIds.current.has(msgId)) {
  addedMessageIds.current.add(msgId);
  setMessages(prev => [...prev, newMessage]);
}
```
**Concern**: Refs don't trigger re-renders; need to ensure cleanup between turns.

### Option B: Upsert pattern instead of append
```typescript
// Instead of checking "does this ID exist", always upsert by ID
setMessages(prev => {
  const idx = prev.findIndex(m => m.id === msgId);
  if (idx >= 0) {
    // Update existing
    return [...prev.slice(0, idx), newMessage, ...prev.slice(idx + 1)];
  }
  return [...prev, newMessage];
});
```
**Concern**: Multiple events might still cause multiple state updates.

### Option C: Debounce message finalization
```typescript
const pendingMessageRef = useRef<{id: string, content: ContentBlock[], timer: NodeJS.Timeout} | null>(null);

// When any "done" event fires:
if (pendingMessageRef.current?.id === msgId) {
  clearTimeout(pendingMessageRef.current.timer);
}
pendingMessageRef.current = {
  id: msgId,
  content,
  timer: setTimeout(() => {
    // Actually add the message after 50ms of no updates
    setMessages(prev => [...prev, ...]);
    pendingMessageRef.current = null;
  }, 50)
};
```
**Concern**: Adds latency, complexity.

### Option D: Single source of truth from SDK
Don't check `stop_reason` at all. Process every `assistant` event and upsert by message ID:
```typescript
if (sdkEvent.type === 'assistant' && sdkEvent.message?.id) {
  const msgId = sdkEvent.message.id;
  setMessages(prev => {
    const existing = prev.find(m => m.id === msgId);
    if (existing) {
      // Update in place with latest content
      return prev.map(m => m.id === msgId ? {...m, content: sdkEvent.message.content} : m);
    }
    return [...prev, {id: msgId, content: sdkEvent.message.content, ...}];
  });
  // Clear streaming since we're showing in messages now
  setStreaming({ content: [], isStreaming: false });
}
```
**Concern**: Partial messages would show in messages array (might flash/update).

## Files Involved

| File | Role |
|------|------|
| `src/components/Chat.tsx` | Frontend state management, WebSocket handling |
| `sandbox/ws-server.mjs` | Container-side SDK integration, persistence logging |
| `workers/main/src/durable-objects.ts` | WebSocket proxy, message persistence from logs |

## Persistence vs UI

**Important**: Persistence works correctly! The `ws-server.mjs` persists every `assistant` event (no `stop_reason` check), and reloading the page shows correct messages. The bug is **only in the live UI state management**.

## Reproduction

1. Go to https://dev-miguel.chiridion.ai
2. Start a new chat
3. Send a message
4. Watch the response stream in
5. When streaming completes, observe either:
   - Message disappears (previous bug)
   - Message duplicates (current bug)
6. Reload the page - message appears correctly (persistence works)

## Current State

As of the last deploy, we have the "duplicates" bug - both `assistant` and `result` handlers are adding messages because the React state updates haven't propagated between them.
