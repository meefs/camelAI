# Thinking Tokens Streaming Plan Audit Addendum

**Date:** February 28, 2026  
**Target plan:** `docs/thinking-tokens-streaming-plan.md`

## Scope

This addendum lists high-impact gaps in the current plan and the exact fixes to add before implementation starts.

## Vital Issues and Fixes

| Priority | Issue | Impact | Required Fix |
|---|---|---|---|
| P0 | JSONL parser can drop thinking blocks across assistant partials | Thinking can still disappear after refresh even if live streaming is fixed | Update sandbox-host merge logic + add parser tests |
| P0 | Empty thinking cleanup is not applied on all completion paths | Phantom blocks can survive in runtime state | Centralize finalization and call it on `result`/error completion paths |
| P1 | Streaming indicator is message-level, not thinking-phase-level | UI can show "thinking" when model is actually responding/tool-calling | Track explicit thinking phase from stream events |
| P1 | `redacted_thinking` is not handled | Missing/incorrect behavior for valid Claude event type | Add reducer/type/UI/test handling for redacted thinking blocks |

---

## 1) P0: Refresh Path Still Risks Dropping Thinking

### Evidence

1. `parseClaudeJSONLMessages()` merges same-assistant-ID segments via `mergeContentBlocks()` in [chat_jsonl_parser.go](/Users/illiana/Projects/chiridion-app/services/sandbox-host/internal/app/chat_jsonl_parser.go:76).  
2. In `mergeContentBlocks()`, when incoming contains text (`hasTextBlocks(incoming) == true`), logic returns incoming blocks + prior tool results only, which can discard earlier thinking blocks: [chat_jsonl_parser.go](/Users/illiana/Projects/chiridion-app/services/sandbox-host/internal/app/chat_jsonl_parser.go:372), [chat_jsonl_parser.go](/Users/illiana/Projects/chiridion-app/services/sandbox-host/internal/app/chat_jsonl_parser.go:395).  
3. Real JSONL sample shows same assistant message ID emitted in multiple lines (thinking, then text, then tool_use), so this path is active.

### Required Plan Additions

1. Add a backend section to the implementation plan for sandbox-host parser updates.
2. Update `mergeContentBlocks()` to preserve prior `thinking` / `redacted_thinking` blocks when merging later assistant segments.
3. Keep existing dedupe behavior for `tool_use`/`tool_result` semantics.
4. Add parser regression tests in [chat_jsonl_parser_test.go](/Users/illiana/Projects/chiridion-app/services/sandbox-host/internal/app/chat_jsonl_parser_test.go:1) for:
   1. `thinking -> text` same `message.id` does not lose thinking.
   2. `thinking -> text -> tool_use` same `message.id` preserves full ordered content.

### Acceptance Criteria

1. Before refresh and after refresh show identical thinking blocks for the same thread.
2. No loss of thinking content in `/api/workspaces/:id/chat/:threadId/messages/stream` responses.

---

## 2) P0: Finalization Cleanup Is Not Applied on All Completion Paths

### Evidence

1. Proposed plan filters empty thinking in reducer `message_delta`/`message_stop`, but not in `result`.
2. In runtime, completion often happens in `Chat.tsx` `sdkEvent.type === 'result'`, where message is currently finalized with direct state mutation, not reducer cleanup: [Chat.tsx](/Users/illiana/Projects/chiridion-app/src/components/Chat.tsx:2023).  
3. Error completion also flips `isStreaming` without content cleanup: [Chat.tsx](/Users/illiana/Projects/chiridion-app/src/components/Chat.tsx:2070).

### Required Plan Additions

1. Add a shared `finalizeStreamingMessageContent(message)` helper in [streaming.ts](/Users/illiana/Projects/chiridion-app/src/lib/streaming.ts:65) that:
   1. Removes empty thinking blocks.
   2. Clears `_blockOffset`.
   3. Sets `isStreaming: false`.
2. Use that helper in reducer end events (`message_delta`, `message_stop`) and `Chat.tsx` `result`/error completion branches.
3. Add tests for completion via `result` path and error path cleanup.

### Acceptance Criteria

1. Empty thinking shells are removed regardless of whether the turn ends by `message_stop`, `message_delta.stop_reason`, `result`, or error.

---

## 3) P1: Thinking Indicator Accuracy Is Too Coarse

### Evidence

1. Proposed indicator wiring uses `message.isStreaming` in [message-bubble.tsx](/Users/illiana/Projects/chiridion-app/src/components/message-bubble.tsx:247).  
2. `isStreaming` means "assistant turn still active," not "currently inside thinking block," so indicator can be wrong during text/tool phases.

### Required Plan Additions

1. Track explicit thinking phase in reducer from `stream_event`:
   1. Enter on `content_block_start` with `thinking`/`redacted_thinking`.
   2. Exit on corresponding `content_block_stop` or turn completion.
2. Pass `isThinkingActive` (not just `isStreaming`) into `ThinkingBlock`.
3. Keep pulsing indicator tied to `isThinkingActive`.

### Acceptance Criteria

1. Indicator shows only while thinking events are active.
2. Indicator does not show during plain text/tool streaming.

---

## 4) P1: Missing `redacted_thinking` Handling

### Evidence

1. Current reducer only handles `content_block_start` with `'thinking'`: [streaming.ts](/Users/illiana/Projects/chiridion-app/src/lib/streaming.ts:107).
2. Plan also focuses on `'thinking'` only.

### Required Plan Additions

1. Add reducer handling for `content_block_start` where block type is `redacted_thinking`.
2. Add delta handling semantics as no-op/placeholder-safe if no readable text is provided.
3. Add UI behavior decision:
   1. Render as "Thinking (redacted)" row, or
   2. Hide from UI but preserve structural correctness.
4. Add tests for `redacted_thinking` block lifecycle.

### Acceptance Criteria

1. No runtime/type errors when redacted thinking events appear.
2. Deterministic UI behavior for redacted blocks before and after refresh.

---

## Minimal Plan Patch Checklist

1. Keep existing Part 1 (`thinking_delta`) as core fix.
2. Add new backend parser section for sandbox-host merge logic and tests.
3. Expand finalization section to include `result`/error paths (not reducer-only).
4. Replace message-level thinking indicator language with event-phase tracking.
5. Add `redacted_thinking` coverage in types, reducer, UI decision, and tests.
