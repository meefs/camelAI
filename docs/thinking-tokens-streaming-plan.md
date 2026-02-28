# Thinking Tokens — Streaming & Accuracy Fix

**February 28, 2026**

---

## Overview

Two bugs with how thinking blocks from the Claude model are handled in the chat UI, plus a backend parser bug that causes data loss on refresh:

1. **Thinking content doesn't stream live** — Thinking blocks appear as "Thinking..." with empty content during streaming. The thinking text only becomes visible after a page refresh (when messages are loaded from the JSONL file).
2. **Phantom thinking blocks** — During streaming, empty thinking blocks appear (sometimes multiple), then disappear on refresh because the finalized message may not contain separate thinking blocks at those positions.
3. **Thinking blocks can vanish on refresh** — The Go JSONL parser's merge logic drops thinking blocks when later assistant segments contain text blocks, so thinking content visible during streaming can disappear after refresh.

### Root Causes

**Bug 1 — Missing `thinking_delta` handler:** The streaming reducer (`src/lib/streaming.ts`) handles `content_block_start` with `type: 'thinking'` correctly (creates the block), but has **no handler** for `content_block_delta` with `delta.type === 'thinking_delta'`. The `content_block_delta` handler only processes `text_delta` and `input_json_delta`. Thinking deltas are silently dropped, so the `thinking` field stays as `''` throughout streaming.

**Bug 2 — Phantom blocks & incomplete finalization:** Because thinking text is never accumulated, every `content_block_start` with `type: 'thinking'` creates a visible-but-empty "Thinking..." block in the message. Additionally, empty thinking blocks are not cleaned up on all completion paths — the streaming reducer handles `message_delta`/`message_stop`, but `Chat.tsx` directly mutates state for `result` and `error` events without any cleanup.

**Bug 3 — JSONL parser merge drops thinking:** `mergeContentBlocks()` in `chat_jsonl_parser.go` (line 395-413) only preserves `tool_result` blocks from existing content when incoming content has text blocks — thinking blocks from earlier segments are discarded.

**Additionally**, the `SDKEvent` TypeScript interface is missing the `thinking` field on `delta`, and the `content_block` type is missing the `thinking` and `signature` fields needed to properly type thinking blocks. The `redacted_thinking` block type is also unhandled.

---

## Part 1: Add `thinking_delta` Handler to Streaming Reducer

**Priority: P0 — Core fix**

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

#### Step 1b — Handle `redacted_thinking` in `content_block_start`

The existing handler at line 107-109 only matches `type === 'thinking'`. Add handling for `redacted_thinking` so it doesn't cause runtime issues:

```typescript
// BEFORE (lines 107-109)
if (block?.type === 'thinking') {
  newContent[index] = { type: 'thinking', thinking: (block as { thinking?: string }).thinking || '' };
  return { ...message, content: newContent, isStreaming: true };
}

// AFTER
if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
  newContent[index] = { type: 'thinking', thinking: (block as { thinking?: string }).thinking || '' };
  return { ...message, content: newContent, isStreaming: true };
}
```

This maps `redacted_thinking` to the existing `thinking` content block type with empty content, which is safe — the block will be filtered out during finalization if it remains empty.

#### Step 1c — Add `thinking_delta` handler in `content_block_delta`

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

#### Step 1d — Handle `signature_delta`

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
| `src/lib/streaming.ts` | Add `thinking`/`signature` to `SDKEvent.delta` type, add `thinking`/`signature` to `content_block` type, handle `redacted_thinking` in `content_block_start`, add `thinking_delta` and `signature_delta` handlers in `content_block_delta` |

---

## Part 2: Centralize Finalization & Filter Empty Thinking Blocks

**Priority: P0 — Prevents phantom blocks on all completion paths**

### Problem

When a message finishes streaming, thinking blocks with empty `thinking` text may remain in the content array. These are "phantom" blocks. The plan must clean them up on **all** completion paths:

1. **`message_delta` with `stop_reason`** (streaming reducer, line 162-167)
2. **`message_stop`** (streaming reducer, line 169-174)
3. **`result` event** (`Chat.tsx` line 2035-2037 — direct `setMessages` call, bypasses reducer)
4. **`error` event** (`Chat.tsx` line 2077-2079 — direct `setMessages` call, bypasses reducer)

### Implementation

#### Step 2a — Add `finalizeStreamingMessage` helper

**File: `src/lib/streaming.ts`**

Export a helper function that centralizes all finalization logic. Add it after the `applyStreamingEventToMessage` function:

```typescript
/**
 * Finalize a streaming message: remove empty thinking blocks, clear internal
 * offset tracking, and mark as no longer streaming.
 */
export function finalizeStreamingMessage(message: Message): Message {
  const content: ContentBlock[] = Array.isArray(message.content)
    ? message.content
    : [];
  const cleanedContent = content.filter(
    block => block.type !== 'thinking' || (block.type === 'thinking' && block.thinking.trim().length > 0)
  );
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  return { ...rest, content: cleanedContent, isStreaming: false };
}
```

#### Step 2b — Use helper in streaming reducer

**File: `src/lib/streaming.ts`**

Replace both `message_delta` and `message_stop` handlers to use the shared helper:

```typescript
// BEFORE (message_delta, lines 162-167)
if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  return { ...rest, isStreaming: false };
}

// AFTER
if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
  return finalizeStreamingMessage(message);
}
```

```typescript
// BEFORE (message_stop, lines 169-174)
if (evt?.type === 'message_stop') {
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  return { ...rest, isStreaming: false };
}

// AFTER
if (evt?.type === 'message_stop') {
  return finalizeStreamingMessage(message);
}
```

#### Step 2c — Use helper in Chat.tsx `result` handler

**File: `src/components/Chat.tsx`**

Import `finalizeStreamingMessage` from `@/lib/streaming` and use it in the `result` event handler (around line 2035):

```typescript
// BEFORE (lines 2035-2037)
setMessages(prev => prev.map(msg =>
  msg.id === msgId ? { ...msg, isStreaming: false, created_at: completedAt } : msg
));

// AFTER
setMessages(prev => prev.map(msg =>
  msg.id === msgId ? { ...finalizeStreamingMessage(msg), created_at: completedAt } : msg
));
```

#### Step 2d — Use helper in Chat.tsx `error` handler

**File: `src/components/Chat.tsx`**

Use the same helper in the error handler (around line 2077):

```typescript
// BEFORE (lines 2077-2079)
setMessages(prev => prev.map(msg =>
  msg.id === msgId ? { ...msg, isStreaming: false } : msg
));

// AFTER
setMessages(prev => prev.map(msg =>
  msg.id === msgId ? finalizeStreamingMessage(msg) : msg
));
```

### Files to modify

| File | Change |
|------|--------|
| `src/lib/streaming.ts` | Add exported `finalizeStreamingMessage` helper, use it in `message_delta` and `message_stop` handlers |
| `src/components/Chat.tsx` | Import `finalizeStreamingMessage`, use it in `result` and `error` completion paths |

---

## Part 3: Update ThinkingBlock Component for Streaming State

**Priority: P1 — UX polish**

### Problem

The `ThinkingBlock` component (`src/components/tool-call/thinking-block.tsx`) always shows static "Thinking..." text. It doesn't indicate when thinking is actively streaming.

### Design

During streaming, the thinking block should show an animated indicator. After streaming completes, it should show static "Thinking..." as the collapsed label (current behavior). The label text changes based on state:

```
During thinking streaming:     After thinking completes:
┌───────────────────────────┐  ┌───────────────────────────┐
│ ● Thinking...          ▸  │  │ Thinking...            ▸  │
└───────────────────────────┘  └───────────────────────────┘
  ↑ pulsing blue dot            ↑ no dot, static text
```

**Note:** The initial implementation uses `message.isStreaming` to drive the indicator, which means the dot persists for the entire assistant turn (not just the thinking phase). This is intentionally approximate. A follow-up can add phase-aware tracking using `content_block_start`/`content_block_stop` events to show the dot only during active thinking.

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

## Part 4: Fix JSONL Parser to Preserve Thinking Blocks on Merge

**Priority: P0 — Prevents thinking from vanishing on refresh**

### Problem

`mergeContentBlocks()` in `services/sandbox-host/internal/app/chat_jsonl_parser.go` (lines 365-414) has a branch that drops thinking blocks. When the incoming assistant segment contains text blocks (`hasTextBlocks(incoming) == true`), the function:

1. Extracts only `tool_result` blocks from the existing content (lines 395-405)
2. Prepends them to incoming blocks (lines 410-412)
3. Returns the merged result — **discarding all other existing blocks, including thinking blocks**

The JSONL file emits the same assistant message ID across multiple lines: first a line with thinking content, then a line with text content. When the parser calls `mergeContentBlocks(existing=[thinking], incoming=[text])`, the thinking block is lost.

### Implementation

**File: `services/sandbox-host/internal/app/chat_jsonl_parser.go`**

Update the `hasTextBlocks` branch (lines 395-413) to preserve `thinking` and `redacted_thinking` blocks from existing content alongside `tool_result`:

```go
// BEFORE (lines 395-413)
toolResults := make([]any, 0, len(existingBlocks))
for _, block := range existingBlocks {
    blockMap, ok := asMap(block)
    if !ok {
        continue
    }
    blockType, _ := asString(blockMap["type"])
    if blockType == "tool_result" {
        toolResults = append(toolResults, block)
    }
}
if len(toolResults) == 0 {
    return incoming
}

merged := make([]any, 0, len(toolResults)+len(incomingBlocks))
merged = append(merged, toolResults...)
merged = append(merged, incomingBlocks...)
return merged

// AFTER
preserved := make([]any, 0, len(existingBlocks))
for _, block := range existingBlocks {
    blockMap, ok := asMap(block)
    if !ok {
        continue
    }
    blockType, _ := asString(blockMap["type"])
    if blockType == "tool_result" || blockType == "thinking" || blockType == "redacted_thinking" {
        preserved = append(preserved, block)
    }
}
if len(preserved) == 0 {
    return incoming
}

merged := make([]any, 0, len(preserved)+len(incomingBlocks))
merged = append(merged, preserved...)
merged = append(merged, incomingBlocks...)
return merged
```

This preserves the existing merge semantics (tool_results prepended, text blocks from incoming) while also keeping thinking blocks from earlier segments. The order is: `[thinking, ..., tool_result, ..., text, ...]` which matches the natural Claude API output order (thinking first, then text, then tool_use).

### Files to modify

| File | Change |
|------|--------|
| `services/sandbox-host/internal/app/chat_jsonl_parser.go` | Update `mergeContentBlocks()` to preserve `thinking`/`redacted_thinking` blocks alongside `tool_result` |

---

## Part 5: Add Tests

**Priority: P0/P1 — Regression coverage**

### TypeScript Tests

**File: `tests/stream-playback.test.ts`**

Add test cases covering thinking streaming, finalization, and edge cases:

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

#### Test 2: Empty thinking blocks are filtered on `message_stop`

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

#### Test 3: Non-empty thinking blocks are preserved on `message_stop`

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

#### Test 4: `finalizeStreamingMessage` cleans up empty thinking blocks

```typescript
import { finalizeStreamingMessage } from '@/lib/streaming';

it('finalizeStreamingMessage removes empty thinking blocks and clears streaming state', () => {
  const message: Message = {
    id: 'test',
    thread_id: 'thread',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: 'Real thought' },
      { type: 'text', text: 'Response' },
    ],
    created_at: Date.now(),
    isStreaming: true,
    _blockOffset: 5,
  };

  const result = finalizeStreamingMessage(message);

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'Real thought' },
    { type: 'text', text: 'Response' },
  ]);
  expect(result.isStreaming).toBe(false);
  expect((result as any)._blockOffset).toBeUndefined();
});
```

#### Test 5: `redacted_thinking` is handled without errors

```typescript
it('handles redacted_thinking content_block_start without errors', () => {
  const events = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } },
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

  // redacted_thinking with no content is filtered as empty
  expect(message.content).toEqual([
    { type: 'text', text: 'Response' },
  ]);
  expect(message.isStreaming).toBe(false);
});
```

### Go Tests

**File: `services/sandbox-host/internal/app/chat_jsonl_parser_test.go`**

Add test cases covering thinking block preservation during JSONL merge:

#### Test 6: Thinking blocks preserved when merged with text segments

```go
func TestParseClaudeJSONLMessagesThinkingPreserved(t *testing.T) {
	ts1 := "2026-01-02T03:04:05.000Z"
	ts2 := "2026-01-02T03:04:06.000Z"
	resultTS := "2026-01-02T03:04:07.000Z"

	// Same assistant message ID across two JSONL lines: thinking then text
	jsonl := fmt.Sprintf(
		`{"type":"user","uuid":"u1","timestamp":"%s","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","timestamp":"%s","message":{"id":"a1","content":[{"type":"thinking","thinking":"Let me analyze this","signature":"sig123"}]}}
{"type":"assistant","timestamp":"%s","message":{"id":"a1","content":[{"type":"text","text":"Here is my response"}]}}
{"type":"result","timestamp":"%s"}`,
		ts1, ts1, ts2, resultTS)

	messages := parseClaudeJSONLMessages(jsonl, "thread-1")
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	assistantMsg := messages[1]
	contentBlocks, ok := asSlice(assistantMsg.Content)
	if !ok {
		t.Fatalf("expected content to be a slice")
	}
	if len(contentBlocks) != 2 {
		t.Fatalf("expected 2 content blocks (thinking + text), got %d", len(contentBlocks))
	}

	// First block should be thinking
	thinkingBlock, _ := asMap(contentBlocks[0])
	blockType, _ := asString(thinkingBlock["type"])
	if blockType != "thinking" {
		t.Fatalf("expected first block type 'thinking', got %q", blockType)
	}
	thinkingText, _ := asString(thinkingBlock["thinking"])
	if thinkingText != "Let me analyze this" {
		t.Fatalf("expected thinking text preserved, got %q", thinkingText)
	}

	// Second block should be text
	textBlock, _ := asMap(contentBlocks[1])
	textType, _ := asString(textBlock["type"])
	if textType != "text" {
		t.Fatalf("expected second block type 'text', got %q", textType)
	}
}
```

#### Test 7: Thinking + text + tool_use all preserved

```go
func TestParseClaudeJSONLMessagesThinkingTextToolUsePreserved(t *testing.T) {
	ts := "2026-01-02T03:04:05.000Z"
	resultTS := "2026-01-02T03:04:07.000Z"

	// thinking -> text -> tool_use, same message ID
	jsonl := fmt.Sprintf(
		`{"type":"user","uuid":"u1","timestamp":"%s","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","timestamp":"%s","message":{"id":"a1","content":[{"type":"thinking","thinking":"reasoning"}]}}
{"type":"assistant","timestamp":"%s","message":{"id":"a1","content":[{"type":"text","text":"response"},{"type":"tool_use","id":"tool1","name":"bash","input":{"cmd":"ls"}}]}}
{"type":"result","timestamp":"%s"}`,
		ts, ts, ts, resultTS)

	messages := parseClaudeJSONLMessages(jsonl, "thread-1")
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	contentBlocks, ok := asSlice(messages[1].Content)
	if !ok {
		t.Fatalf("expected content to be a slice")
	}
	if len(contentBlocks) != 3 {
		t.Fatalf("expected 3 content blocks (thinking + text + tool_use), got %d", len(contentBlocks))
	}

	// Verify order: thinking, text, tool_use
	types := make([]string, len(contentBlocks))
	for i, block := range contentBlocks {
		blockMap, _ := asMap(block)
		types[i], _ = asString(blockMap["type"])
	}
	expected := []string{"thinking", "text", "tool_use"}
	for i, exp := range expected {
		if types[i] != exp {
			t.Fatalf("block %d: expected type %q, got %q (all types: %v)", i, exp, types[i], types)
		}
	}
}
```

### Files to modify

| File | Change |
|------|--------|
| `tests/stream-playback.test.ts` | Add 5 test cases for thinking_delta accumulation, empty block filtering, non-empty block preservation, `finalizeStreamingMessage`, and `redacted_thinking` lifecycle |
| `services/sandbox-host/internal/app/chat_jsonl_parser_test.go` | Add 2 test cases for thinking block preservation during JSONL merge |

---

## Summary

| # | Part | Priority | Files | What it fixes |
|---|------|----------|-------|---------------|
| 1 | Add `thinking_delta` handler + `redacted_thinking` safety | P0 | `src/lib/streaming.ts` | Thinking content streams live; redacted blocks don't crash |
| 2 | Centralize finalization & filter empty thinking blocks | P0 | `src/lib/streaming.ts`, `src/components/Chat.tsx` | Phantom blocks cleaned up on all completion paths |
| 3 | ThinkingBlock streaming indicator | P1 | `src/components/tool-call/thinking-block.tsx`, `src/components/message-bubble.tsx` | Visual feedback during active thinking |
| 4 | Fix JSONL parser to preserve thinking on merge | P0 | `services/sandbox-host/internal/app/chat_jsonl_parser.go` | Thinking blocks no longer vanish on refresh |
| 5 | Tests | P0/P1 | `tests/stream-playback.test.ts`, `services/sandbox-host/internal/app/chat_jsonl_parser_test.go` | Regression coverage |

### Implementation order

1. **Part 1** — `thinking_delta` handler + `redacted_thinking` (core streaming fix)
2. **Part 2** — Centralized finalization (prevents phantom blocks on all paths)
3. **Part 4** — JSONL parser fix (prevents refresh data loss)
4. **Part 3** — Streaming indicator (UX polish)
5. **Part 5** — Tests (validation — run `bun run test` and `go test ./...` in sandbox-host)

### Components & dependencies used

- All changes use existing dependencies — no new npm packages needed
- No new shadcn/ui components needed
- The pulsing dot pattern in Part 3 reuses the same markup from `CompactingIndicator`

### Verification

- Send a message to the agent and watch the thinking block during streaming — thinking text should accumulate live inside the collapsed block
- Expand the thinking block during streaming — text should appear incrementally
- After streaming ends — thinking block should show full thinking text, no pulsing dot
- If model doesn't emit thinking content for a block — the empty block should be cleaned up on message completion, not visible as a phantom "Thinking..." row
- Page refresh — thinking blocks should look identical before and after refresh
- Run `bun run test` — all existing tests pass, new thinking tests pass
- Run `cd services/sandbox-host && go test ./internal/app/...` — parser tests pass

### Follow-up items (P2, not in this implementation)

1. **Phase-aware thinking indicator** — Track `content_block_start`/`content_block_stop` for thinking blocks to show the pulsing dot only during the thinking phase, not the entire assistant turn. Minimal approach: stop pulsing once `content_block_stop` fires for the thinking block's index.
2. **`redacted_thinking` UX policy** — Decide whether to render redacted thinking as "Thinking (redacted)" or hide it entirely. Currently mapped to an empty thinking block that gets filtered during finalization.
