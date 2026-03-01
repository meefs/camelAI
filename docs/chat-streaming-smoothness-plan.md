# Chat Streaming Smoothness Plan

**Date:** March 1, 2026  
**Scope:** `src/components/Chat.tsx`, `src/components/message-bubble.tsx`, targeted tests in `tests/`

## Objective

Make streaming feel stable and consistent across tool-call boundaries and user follow-ups by:

1. Eliminating vertical "down/up" jitter during active assistant turns.
2. Making loading ellipses placement deterministic.

## Non-Goal

Keep the existing animation distinction between:

1. user sends when assistant is idle (net new task), and
2. user sends while assistant is actively streaming (interruption flow).

This plan intentionally does not change `sentDuringStreaming` spacer semantics.

## Audit Summary (Current Behavior)

### 1) Two different loading indicator render paths

- Inline indicator inside assistant message: `src/components/message-bubble.tsx:659-664`
- Fallback global indicator below messages: `src/components/Chat.tsx:617-621`

Current selection logic:

- `showStreamingIndicator={msg.id === lastStreamingMessageId}` in `ChatMessagesView` (`src/components/Chat.tsx:574-579`)
- `lastStreamingMessageId` is derived from `message.isStreaming` only (`src/components/Chat.tsx:945-951`)

### 2) Streaming message identity and indicator state can diverge

- Turn-level streaming identity is tracked by `streamingMessageId` (`src/components/Chat.tsx:795`, `942`), but indicator visibility is based on `message.isStreaming` (`945-951`).
- `message.isStreaming` is cleared on `message_delta(stop_reason)` and `message_stop` in the reducer (`src/lib/streaming.ts:201-207`).
- During tool boundaries, this temporarily removes "streaming" from the message even though the overall turn is still active (`loading` can stay true via `streaming_state`, `src/components/Chat.tsx:2096-2097`).

### 3) Different visual ordering for actions vs loading dots

- Assistant message currently renders dots before action row:
  - dots: `message-bubble.tsx:663`
  - actions: `message-bubble.tsx:665-691`
- Fallback global dots render after all messages (`Chat.tsx:617-621`), which effectively places dots after any visible action rows.

Result: perceived ordering inconsistency.

### 4) Different turn animation policy based on `sentDuringStreaming`

- User sends while assistant active: `sentDuringStreaming: true` (`Chat.tsx:3219`, `3260`, `3263-3267`)
- Spacer disabled for such turns (`Chat.tsx:2258-2260`), so layout behavior differs from idle-send flow.

## Root Causes for Reported Issues

### Issue A: Thread nudges down/up during tool-call transitions

Primary cause:

- UI flips between inline and fallback loading modes whenever `message.isStreaming` temporarily drops between tool segments.
- This adds/removes extra loading row(s), and the scroll/spacer observers react, creating visible micro-jumps.

### Issue B: Ellipses appear above actions sometimes and below other times

Primary cause:

- Inline path renders dots above actions (`message-bubble.tsx`), fallback path renders dots below message list (`Chat.tsx`).

## Implementation Plan

## Phase 1: Unify active-turn indicator ownership in `Chat.tsx` (P0)

Goal: keep a single active assistant target for dots throughout a turn, including between tool segments.

### Changes

1. Replace `lastStreamingMessageId`/`hasStreamingMessage` derivation with a turn-aware `activeAssistantMessageId`:
   - Prefer `streamingMessageId` if that message exists in `messages`.
   - Fallback to last `message.isStreaming` message (reconnect/replay safety).
   - Else `null`.

2. Compute booleans:
   - `assistantTurnActive = loading || isStreaming`
   - `hasActiveAssistantMessage = activeAssistantMessageId !== null`
   - `showGlobalAssistantIndicator = assistantTurnActive && !hasActiveAssistantMessage && !isCompacting`

3. Pass inline indicator by active ID, not by `message.isStreaming`:
   - `showStreamingIndicator={assistantTurnActive && msg.id === activeAssistantMessageId}`

4. Use `showGlobalAssistantIndicator` for fallback dots instead of current `(loading || isStreaming) && !hasStreamingMessage` check.

### Why this fixes jitter

It prevents mode-flips between inline and fallback indicators during `message_stop`/next-`message_start` gaps.

## Phase 2: Make ellipses placement deterministic in `message-bubble.tsx` (P0)

Goal: dots appear after assistant actions when an assistant message exists.

### Changes

1. Reorder assistant render block so action row is before `LoadingDots`.
2. Keep action row mounted (already true with `hasContent` guard).
3. For no-content edge case (`hasContent === false`), render only dots (no actions).

### Expected result

- With an active assistant message, visual order is always:
  - content/tool rows
  - action row (timestamp/copy)
  - loading dots

## Phase 3: Regression tests (P0)

### Update existing tests

1. `tests/chat-midstream-followup-order.test.tsx`
   - Add assertion that fallback global loading indicator does not appear once an active assistant message exists for the turn.
   - Keep existing ordering/split assertions unchanged.

2. `tests/stream-playback.test.ts`
   - Keep reducer semantics coverage as-is unless reducer behavior is intentionally changed.

### Add targeted UI test

3. New test file (recommended): `tests/message-bubble-streaming-indicator-order.test.tsx`
   - Render assistant bubble with content + `showStreamingIndicator`.
   - Assert action row renders before loading dots in DOM order.

## Acceptance Criteria

1. During tool-call boundaries in a single assistant turn, chat transcript no longer visibly jumps down/up.
2. When an assistant message exists, loading dots always render after chat actions.
3. Pre-first-token state still shows fallback dots (no regression for initial waiting state).
4. Mid-stream follow-up split behavior remains correct (existing tests pass).
5. Interrupt-vs-idle send animation distinction is preserved (no change to existing `sentDuringStreaming` spacer behavior).
6. No regressions in compaction indicator behavior.

## Manual QA Matrix

1. Idle send -> assistant does multiple tool calls:
   - verify no repeated vertical nudges between tool completion and next tool start.
2. Mid-stream follow-up send:
   - verify assistant split ordering remains correct and motion is stable.
3. Long tool-only sequence (many tool rows before text):
   - verify dots stay in a single location.
4. Reconnect during active turn:
   - verify indicator restores to active assistant message when possible.
5. `/compact` turn:
   - verify compaction indicator still takes precedence over dots.

## Risk Notes

1. `streamingMessageId` can be stale during unusual replay paths.
   - Mitigation: retain fallback scan for `message.isStreaming` and existing reset paths (`system/init`, `result`, `error`).

## Suggested Delivery Order

1. Phase 1 + Phase 2 together (highest impact, lowest risk).
2. Run automated tests + manual QA matrix.
