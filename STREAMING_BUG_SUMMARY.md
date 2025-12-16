# Streaming Bug Summary

## Problem Statement

The chat app should show AI responses streaming incrementally (word by word, like ChatGPT). Instead, users see:
1. Loading indicator
2. Brief flash of the complete message
3. Back to loading
4. Full message appears again

## Architecture

```
User types message
    ↓
WebSocket sends to Durable Object (ChatThreadDO)
    ↓
DO spawns Cloudflare Container with driver.mjs
    ↓
driver.mjs runs Claude SDK: query({ prompt, options: { sessionId, includePartialMessages: true } })
    ↓
SDK streams NDJSON events to stdout
    ↓
Container output → DO parses events → WebSocket → Frontend React state
```

## Key Files

| File | Role |
|------|------|
| `sandbox/driver.mjs` | Runs Claude SDK inside container |
| `worker/durable-objects.ts` | WebSocket handler, spawns container, forwards events |
| `src/components/Chat.tsx` | React UI, manages streaming state |

## SDK Event Types

The Claude SDK with `includePartialMessages: true` emits:

1. **`system` (subtype: init)** - Session started
2. **`stream_event`** - Real-time streaming events:
   - `content_block_start` - New text block begins
   - `content_block_delta` - Incremental text chunk (the actual streaming content)
   - `message_delta` - Stop reason when done
3. **`assistant`** - Full or partial assistant message (contains cumulative content)
4. **`user`** - Tool results
5. **`result`** - Query complete

## Bugs Fixed

### 1. No streaming at all
- **Cause:** Missing `includePartialMessages: true` in SDK options
- **Fix:** Added option to `query()` call in driver.mjs

### 2. Content duplicating/wrong accumulation
- **Cause:** Frontend was APPENDING content, but partial messages contain CUMULATIVE content
- **Fix:** REPLACE content instead of append when handling `assistant` events

### 3. stream_event being ignored
- **Cause:** Frontend only handled `assistant` type events
- **Fix:** Added handler for `stream_event` type with content_block_delta processing

### 4. API key not reaching container
- **Cause:** Environment variable not passed to Durable Object
- **Fix:** Added `ANTHROPIC_API_KEY=your-key` to `.dev.vars`

### 5. Docker cache not invalidating
- **Cause:** Docker COPY step cached old driver.mjs
- **Fix:** Added version comment to force rebuild

### 6. Flash bug (current issue)
- **Cause:** `result` event was clearing streaming content before final `assistant` event
- **Fix:** Only set `isStreaming: false` on result, don't clear content

## Current Problem (Unresolved)

### Verified Working
- Deltas ARE being received (11-14 deltas over 700ms confirmed via tests)
- WebSocket connection is stable
- Events are being forwarded correctly

### Suspected Issue
The `assistant` event arrives during streaming and contains the FULL accumulated text. This overwrites the content that was being built up from `content_block_delta` events.

Timeline might look like:
```
0ms:   stream_event content_block_start
50ms:  stream_event content_block_delta "Hello"
100ms: stream_event content_block_delta " world"
150ms: assistant {content: [{text: "Hello world"}]}  ← OVERWRITES with full text
200ms: stream_event content_block_delta "!"
250ms: assistant {content: [{text: "Hello world!"}]} ← OVERWRITES again
...
```

### React State Management

```typescript
// Current logic in Chat.tsx:

// On content_block_delta - appends incrementally
if (evt?.type === 'content_block_delta') {
  setStreaming(prev => {
    const newContent = [...prev.content];
    const lastBlock = newContent[newContent.length - 1];
    if (lastBlock?.type === 'text') {
      newContent[newContent.length - 1] = {
        ...lastBlock,
        text: (lastBlock.text || '') + (evt.delta?.text || ''),
      };
    }
    return { ...prev, content: newContent };
  });
}

// On assistant event - REPLACES with cumulative content
if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
  setStreaming(prev => ({
    ...prev,
    content: sdkEvent.message!.content,  // ← Full replace!
    isStreaming: !sdkEvent.message!.stop_reason,
  }));
}
```

## Proposed Fix

Option A: Ignore `assistant` events while `isStreaming` is true
```typescript
if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
  // Only process if NOT actively streaming deltas
  if (!streaming.isStreaming) {
    setStreaming(prev => ({
      ...prev,
      content: sdkEvent.message!.content,
    }));
  }
}
```

Option B: Use a flag to track if we're in "delta mode"
```typescript
const [usingDeltas, setUsingDeltas] = useState(false);

// Set flag on first delta
if (evt?.type === 'content_block_start') {
  setUsingDeltas(true);
}

// Ignore assistant events if in delta mode
if (sdkEvent.type === 'assistant' && !usingDeltas) {
  // process
}
```

## Test Files

| File | Purpose |
|------|---------|
| `e2e/chat.spec.ts` | Basic chat flow, streaming verification |
| `e2e/debug-deltas.spec.ts` | Traces all events + UI state over time |
| `tests/Chat.test.tsx` | React unit tests for streaming logic |

## How to Debug

1. Start server: `npx wrangler dev`
2. Run debug test: `BASE_URL=http://localhost:8787 npx playwright test e2e/debug-deltas.spec.ts --reporter=list`
3. Check output for event timeline vs UI state timeline
4. Look for `assistant` events interleaved with `content_block_delta` events
