# Fix Compaction Bugs Implementation Feedback

Date: March 2, 2026  
Scope reviewed: uncommitted implementation diff for compaction bug fixes

## Findings

### 1) P1: `compactingPriorMessageId` can be overwritten to `null` in normal auto-compaction flow

File: `src/components/Chat.tsx`

- `system/status: compacting` correctly captures `priorId` and clears `streamingMessageId` at [src/components/Chat.tsx:1957](/Users/illiana/Projects/chiridion-app/src/components/Chat.tsx:1957).
- Then `content_block_start(type=compaction)` recomputes `priorId` again at [src/components/Chat.tsx:1791](/Users/illiana/Projects/chiridion-app/src/components/Chat.tsx:1791).
- In the common event order (`status: compacting` before compaction block), `streamingMessageIdRef` is already `null` and `lastCompletedAssistantMessageIdRef` is often `null` (cleared at send time), so this second assignment can overwrite a valid prior message ID with `null`.

Why this matters:
- It can disable `suppressFinalizedState` during compaction, bringing back the original "message looks done" visual issue.

Recommended fix:

1. In the compaction block-start handler, only set `compactingPriorMessageId` if it is not already set.
2. Keep the block-start logic as fallback-only when status events are absent.

Suggested implementation pattern:

```ts
if (evt?.type === 'content_block_start' && evt?.content_block?.type === 'compaction') {
  isInCompactionBlockRef.current = true;
  compactionContentRef.current = '';
  hasCapturedCompactionSummaryRef.current = false;
  isAutoCompactingRef.current = true;
  syncCompactionIndicator();

  if (!compactingPriorMessageIdRef.current) {
    const priorId = streamingMessageIdRef.current
      ?? lastCompletedAssistantMessageIdRef.current
      ?? null;
    compactingPriorMessageIdRef.current = priorId;
    setCompactingPriorMessageId(priorId);
  }

  if (streamingMessageIdRef.current) {
    setStreamingMessageId(null);
  }
  return;
}
```

### 2) P3: Unrelated env-plumbing changes are mixed into this diff

Files:
- [workers/main/src/durable-objects.ts:124](/Users/illiana/Projects/chiridion-app/workers/main/src/durable-objects.ts:124)
- [workers/main/src/durable-objects.ts:1775](/Users/illiana/Projects/chiridion-app/workers/main/src/durable-objects.ts:1775)
- [services/sandbox-host/internal/container/manager.go:440](/Users/illiana/Projects/chiridion-app/services/sandbox-host/internal/container/manager.go:440)

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` forwarding looks reasonable, but it is outside the compaction-UI bugfix scope. If this is intentional, keep it; otherwise split/revert to reduce review/deploy blast radius.

---

## Additional review (Claude Opus)

### 3) P1: Agree with Codex finding #1 — this breaks Bug 1's fix in the most common flow

I traced the exact event sequence for auto-compaction and confirmed this is a real issue:

**Mid-stream compaction (agent hits context limit while streaming):**
1. `emitStreamTextPart` → `streamingMessageIdRef = 'msg-123'`
2. `message_delta(stop_reason)` → `message.isStreaming = false` but `streamingMessageIdRef` unchanged
3. `system/status: "compacting"` → captures `priorId = streamingMessageIdRef = 'msg-123'` ✅, then clears `streamingMessageIdRef`
4. `content_block_start(type: compaction)` → recomputes `priorId = null ?? null = null` → **overwrites valid prior ID with null** ❌

**Post-result compaction (result fires before compaction):**
1. `result` → `lastCompletedAssistantMessageIdRef = 'msg-123'`, clears `streamingMessageIdRef`
2. `system/status: "compacting"` → captures `priorId = null ?? 'msg-123' = 'msg-123'` ✅, clears `streamingMessageIdRef` (already null)
3. `content_block_start(type: compaction)` → recomputes `priorId = null ?? 'msg-123' = 'msg-123'` → happens to survive because `lastCompletedAssistantMessageIdRef` is still set

So mid-stream compaction (likely the more common case) is broken. The `content_block_start` handler was designed as a fallback for when `system/status` events are unavailable — it should not overwrite a value already captured by the primary handler.

Codex's suggested guard (`if (!compactingPriorMessageIdRef.current)`) is the correct fix.

Note: the new integration test at [tests/compact-message.test.tsx:738](tests/compact-message.test.tsx#L738) doesn't catch this because `MessageBubble` is mocked and ignores `suppressFinalizedState`. The test validates Bug 2 (message ordering) which works correctly, but Bug 1 (visual suppression) is not tested end-to-end.

### 4) P2: Missing unit tests from the plan (sections 4b and 4c)

The plan specified three test suites:
- **4a**: Compaction message ordering → ✅ implemented
- **4b**: `MessageBubble` `suppressFinalizedState` rendering → ❌ not implemented
- **4c**: `CompactSummaryCard` overflow / ResizeObserver → ❌ not implemented (though the `ResizeObserver` mock in `tests/setup.ts` was added ✅)

**4b is the more important one** — it would directly test that `suppressFinalizedState={true}` causes:
- `ContentBlockRenderer` to receive `isStreaming={true}` (tool calls stay in running state)
- The hover action row (`role="group" aria-label="Message actions"`) to be hidden

Without this test, a regression to the `isStreaming` computation or the `!suppressFinalizedState` guard at [message-bubble.tsx:670](src/components/message-bubble.tsx#L670) would go undetected.

### 5) P3: No-op assertion in the new test

At [tests/compact-message.test.tsx:772](tests/compact-message.test.tsx#L772):
```ts
expect('pre-compact-msg').not.toBe('post-compact-msg');
```

This compares two hardcoded string literals — it always passes regardless of runtime behavior. If the intent is to assert the two message IDs are distinct, it should compare the actual `data-message-id` attribute values from the rendered DOM, or just be removed since the ordering assertions below already verify two distinct messages exist.
