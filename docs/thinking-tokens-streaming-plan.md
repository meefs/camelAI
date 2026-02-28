# Thinking Tokens — Streaming & Accuracy Fix

**February 28, 2026**

---

## Overview

Two bugs with how thinking blocks from the Claude model are handled in the chat UI:

1. **Thinking content doesn't stream live** — Thinking blocks appear as "Thinking..." with empty content during streaming. The thinking text only becomes visible after a page refresh (when messages are loaded from the JSONL file).
2. **Phantom thinking blocks** — During streaming, empty thinking blocks appear (sometimes multiple), then disappear on refresh because the finalized message may not contain separate thinking blocks at those positions.

### Root Causes

**Bug 1 — Missing `thinking_delta` handler:** The streaming reducer (`src/lib/streaming.ts`) handles `content_block_start` with `type: 'thinking'` correctly (creates the block), but has **no handler** for `content_block_delta` with `delta.type === 'thinking_delta'`. The `content_block_delta` handler only processes `text_delta` and `input_json_delta`. Thinking deltas are silently dropped, so the `thinking` field stays as `''` throughout streaming.

**Bug 2 — Phantom blocks:** Because thinking text is never accumulated, every `content_block_start` with `type: 'thinking'` creates a visible-but-empty "Thinking..." block in the message. If the model emits multiple thinking blocks across message segments, they all appear as empty shells during streaming. On page refresh, the JSONL-parsed message has the correct structure — often a single thinking block with content, or none if the model didn't actually think — so the phantom blocks disappear.

**Additionally**, the `SDKEvent` TypeScript interface is missing the `thinking` field on `delta`, and the `content_block` type is missing the `thinking` and `signature` fields needed to properly type thinking blocks.

---

## Part 1: Add `thinking_delta` Handler to Streaming Reducer

### Problem

`src/lib/streaming.ts` line 114-143 — the `content_block_delta` handler only matches two delta types:
```typescript
if (evt.delta?.type === 'text_delta' && evt.delta.text) { ... }
if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) { ... }
// No thinking_delta handler — deltas silently dropped
```

### Implementation

**File: `src/lib/streaming.ts`**

#### Step 1a — Add `thinking` and `signature` fields to the `SDKEvent` interface

The `delta` type (lines 44-51) needs a `thinking` field for thinking deltas and a `signature` field for signature deltas:

```typescript
// BEFORE (lines 44-51)
delta?: {
  type?: string;
  text?: string;
  stop_reason?: string;
  partial_json?: string;
  /** Compaction summary content (delivered as a single chunk) */
  content?: string;
};

// AFTER
delta?: {
  type?: string;
  text?: string;
  stop_reason?: string;
  partial_json?: string;
  /** Compaction summary content (delivered as a single chunk) */
  content?: string;
  /** Thinking block text chunk (thinking_delta) */
  thinking?: string;
  /** Thinking block signature (signature_delta) */
  signature?: string;
};
```

Also add `thinking` and `signature` fields to the `content_block` type (lines 52-57) since the API sends the initial thinking text and signature on the content_block_start event:

```typescript
// BEFORE (lines 52-57)
content_block?: {
  type: string;
  text?: string;
  id?: string;
  name?: string;
};

// AFTER
content_block?: {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  thinking?: string;
  signature?: string;
};
```

#### Step 1b — Add `thinking_delta` handler in `content_block_delta`

Add a new case after the `input_json_delta` handler (after line 142, before the closing `}` of the `content_block_delta` block):

```typescript
if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
  const newContent = [...content];
  const index = typeof evt.index === 'number' ? blockOffset + evt.index : newContent.length - 1;
  const target = newContent[index];
  if (target?.type === 'thinking') {
    newContent[index] = {
      ...target,
      thinking: (target.thinking || '') + evt.delta.thinking,
    };
  }
  return { ...message, content: newContent };
}
```

This follows the exact same pattern as the `text_delta` handler (lines 115-128) — locate the block by index, append the delta text to the existing content.

#### Step 1c — Handle `signature_delta` (optional but recommended)

The Claude API also sends `signature_delta` events for thinking blocks. While signatures aren't displayed to users, handling them prevents the delta from being silently dropped and ensures the block data is complete. Add after the `thinking_delta` handler:

```typescript
if (evt.delta?.type === 'signature_delta' && evt.delta.signature) {
  const newContent = [...content];
  const index = typeof evt.index === 'number' ? blockOffset + evt.index : newContent.length - 1;
  const target = newContent[index];
  if (target?.type === 'thinking') {
    newContent[index] = {
      ...target,
      signature: (target as ContentBlock & { signature?: string }).signature
        ? (target as ContentBlock & { signature?: string }).signature + evt.delta.signature
        : evt.delta.signature,
    };
  }
  return { ...message, content: newContent };
}
```

### Files to modify

| File | Change |
|------|--------|
| `src/lib/streaming.ts` | Add `thinking`/`signature` to `SDKEvent.delta` type, add `thinking`/`signature` to `content_block` type, add `thinking_delta` and `signature_delta` handlers in `content_block_delta` |

---

## Part 2: Update ThinkingBlock Component for Streaming State

### Problem

The `ThinkingBlock` component (`src/components/tool-call/thinking-block.tsx`) always shows static "Thinking..." text. It doesn't:
- Indicate when thinking is actively streaming (pulsing dot, animation)
- Show "Thought for Xs" after thinking completes (like the Claude CLI does)
- Differentiate between an empty thinking block (still streaming) and a completed one

### Design

During streaming, the thinking block should show an animated indicator. After streaming completes, it should show static "Thinking..." as the collapsed label (current behavior is fine for completed state). The label text changes based on state:

```
During thinking streaming:     After thinking completes:
┌───────────────────────────┐  ┌───────────────────────────┐
│ ● Thinking...          ▸  │  │ Thinking...            ▸  │
└───────────────────────────┘  └───────────────────────────┘
  ↑ pulsing blue dot            ↑ no dot, static text
```

### Implementation

**File: `src/components/tool-call/thinking-block.tsx`**

Add an `isStreaming` prop to the component:

```typescript
interface ThinkingBlockProps {
  thinking: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({ thinking, isStreaming = false, defaultExpanded = false }: ThinkingBlockProps) {
```

Add a pulsing dot indicator when streaming:

```tsx
<span className="flex items-center gap-2 flex-1 truncate">
  {isStreaming && (
    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none shrink-0" />
  )}
  <span className="truncate">Thinking...</span>
</span>
```

This matches the existing `CompactingIndicator` pattern (pulsing blue dot + text).

**File: `src/components/message-bubble.tsx`**

Pass `isStreaming` through to the `ThinkingBlock` when rendering it (around line 291-297):

```typescript
// BEFORE
if (block.type === 'thinking') {
  items.push({
    kind: 'other',
    key: `thinking-${index}`,
    node: <ThinkingBlock thinking={block.thinking} />,
  });
  return;
}

// AFTER
if (block.type === 'thinking') {
  items.push({
    kind: 'other',
    key: `thinking-${index}`,
    node: <ThinkingBlock thinking={block.thinking} isStreaming={isStreaming} />,
  });
  return;
}
```

The `isStreaming` variable is already available in the `ContentBlockRenderer` scope (passed from the message's `isStreaming` property, already used for MarkdownRenderer on line 284).

### Files to modify

| File | Change |
|------|--------|
| `src/components/tool-call/thinking-block.tsx` | Add `isStreaming` prop, render pulsing dot when streaming |
| `src/components/message-bubble.tsx` | Pass `isStreaming` to `ThinkingBlock` (line ~295) |

---

## Part 3: Filter Empty Thinking Blocks on Finalization

### Problem

When a message finishes streaming (`isStreaming` flips to `false`), thinking blocks with empty `thinking` text may remain in the content array. These are "phantom" blocks — the model started a thinking block but didn't emit any thinking content (or emitted it in a subsequent message segment that was split). On page refresh, the JSONL-parsed message has the correct structure without these empty blocks.

### Design

Strip empty thinking blocks when streaming completes. This should happen in the streaming reducer when the message transitions from streaming to non-streaming (on `message_delta` with `stop_reason`, `message_stop`, or `result` event).

### Implementation

**File: `src/lib/streaming.ts`**

In the `message_delta` handler (lines 162-167) and `message_stop` handler (lines 169-174), filter out thinking blocks with empty content:

```typescript
// BEFORE (message_delta, lines 162-167)
if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  return { ...rest, isStreaming: false };
}

// AFTER
if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  const cleanedContent = content.filter(
    block => block.type !== 'thinking' || (block.type === 'thinking' && block.thinking.trim().length > 0)
  );
  return { ...rest, content: cleanedContent, isStreaming: false };
}
```

Apply the same filter in the `message_stop` handler:

```typescript
// BEFORE (message_stop, lines 169-174)
if (evt?.type === 'message_stop') {
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  return { ...rest, isStreaming: false };
}

// AFTER
if (evt?.type === 'message_stop') {
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  const cleanedContent = content.filter(
    block => block.type !== 'thinking' || (block.type === 'thinking' && block.thinking.trim().length > 0)
  );
  return { ...rest, content: cleanedContent, isStreaming: false };
}
```

### Files to modify

| File | Change |
|------|--------|
| `src/lib/streaming.ts` | Filter empty thinking blocks in `message_delta` and `message_stop` handlers |

---

## Part 4: Add Tests for Thinking Block Streaming

### Problem

`tests/stream-playback.test.ts` has no test cases for thinking blocks. The existing tests cover `text_delta` and `input_json_delta` only.

### Implementation

**File: `tests/stream-playback.test.ts`**

Add three test cases:

#### Test 1: `thinking_delta` accumulation

```typescript
it('accumulates thinking blocks from thinking_delta events', () => {
  const events = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'analyze this' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is my response' } },
    },
  ];

  let message = createMessage();
  for (const event of events) {
    message = applyStreamingEventToMessage(message, event);
  }

  expect(message.content).toEqual([
    { type: 'thinking', thinking: 'Let me analyze this' },
    { type: 'text', text: 'Here is my response' },
  ]);
});
```

#### Test 2: Empty thinking blocks are filtered on message_stop

```typescript
it('filters empty thinking blocks on message_stop', () => {
  const events = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Response' } },
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
    },
  ];

  let message = createMessage();
  for (const event of events) {
    message = applyStreamingEventToMessage(message, event);
  }

  expect(message.content).toEqual([
    { type: 'text', text: 'Response' },
  ]);
  expect(message.isStreaming).toBe(false);
});
```

#### Test 3: Non-empty thinking blocks are preserved on message_stop

```typescript
it('preserves non-empty thinking blocks on message_stop', () => {
  const events = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning here' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Response' } },
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
    },
  ];

  let message = createMessage();
  for (const event of events) {
    message = applyStreamingEventToMessage(message, event);
  }

  expect(message.content).toEqual([
    { type: 'thinking', thinking: 'Reasoning here' },
    { type: 'text', text: 'Response' },
  ]);
  expect(message.isStreaming).toBe(false);
});
```

### Files to modify

| File | Change |
|------|--------|
| `tests/stream-playback.test.ts` | Add 3 test cases for thinking_delta accumulation, empty block filtering, and non-empty block preservation |

---

## Summary

| # | Change | Files | What it fixes |
|---|--------|-------|---------------|
| 1 | Add `thinking_delta` handler to streaming reducer | `src/lib/streaming.ts` | Thinking content streams live instead of appearing empty |
| 2 | Add streaming indicator to ThinkingBlock | `src/components/tool-call/thinking-block.tsx`, `src/components/message-bubble.tsx` | Visual feedback during active thinking |
| 3 | Filter empty thinking blocks on finalization | `src/lib/streaming.ts` | Phantom empty thinking blocks no longer persist |
| 4 | Add tests | `tests/stream-playback.test.ts` | Regression coverage for thinking streaming |

### Implementation order

1. **Part 1** — `thinking_delta` handler (core fix, highest priority)
2. **Part 3** — Empty block filtering (prevents phantom blocks)
3. **Part 2** — Streaming indicator (UX polish)
4. **Part 4** — Tests (validation)

### Components & dependencies used

- All changes use existing dependencies — no new npm packages needed
- No new shadcn/ui components needed
- The pulsing dot pattern in Part 2 reuses the same markup from `CompactingIndicator`

### Verification

- Send a message to the agent and watch the thinking block during streaming — thinking text should accumulate live inside the collapsed block
- Expand the thinking block during streaming — text should appear incrementally
- After streaming ends — thinking block should show full thinking text, no pulsing dot
- If model doesn't emit thinking content for a block — the empty block should be cleaned up on message completion, not visible as a phantom "Thinking..." row
- Page refresh — thinking blocks should look identical before and after refresh
- Run `bun run test` — all existing tests pass, new thinking tests pass
