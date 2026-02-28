# Auto-Compaction UX — Detect & Disclose

**February 28, 2026**

---

## Problem

When the SDK's context window fills up during a long conversation, it automatically compacts (summarizes everything and continues from the summary). Today, users see **no indication** that this is happening. From their perspective, the agent appears to hang — the loading dots bounce indefinitely with no tool calls visible and no progress. The experience looks broken.

The root cause is that our compacting indicator (`isCompacting` state) is only set for **manual** `/compact` commands. Auto-compaction — the far more common case — goes completely undetected on the client.

### How it looks today (broken)

```
User sends message → agent starts working → context limit hit → SDK compacts silently

┌──────────────────────────────────────────┐
│  User: Can you update the dashboard...   │
│                                          │
│  ···  (bouncing dots, no context,        │
│        appears hung for 10-30 seconds)   │
│                                          │
│  Agent: Sure, I've updated the...        │  ← response finally arrives
└──────────────────────────────────────────┘
```

### How it should look (fixed)

```
┌──────────────────────────────────────────┐
│  User: Can you update the dashboard...   │
│                                          │
│  ◐ Compacting conversation...            │  ← clear system indicator
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ ● Context compacted               │  │  ← summary card appears
│  │   This session is being continued  │  │
│  │   from a previous conversation...  │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Agent: Sure, I've updated the...        │
└──────────────────────────────────────────┘
```

---

## Background: SDK Compaction Event Sequence

The Claude SDK emits a `system/status` event when compaction starts, which is distinct from the `compact_boundary` event that fires after compaction completes. The full sequence:

```
┌───────┬─────────────────────────────────────────────────────────────┬───────────────────────────┐
│ Order │ Event                                                       │ Meaning                   │
├───────┼─────────────────────────────────────────────────────────────┼───────────────────────────┤
│ 1     │ { type: "system", subtype: "status", status: "compacting" } │ Compaction starting       │
├───────┼─────────────────────────────────────────────────────────────┼───────────────────────────┤
│ 2     │ content_block_start (type: compaction)                      │ Summary generation begins │
├───────┼─────────────────────────────────────────────────────────────┼───────────────────────────┤
│ 3     │ content_block_delta (type: compaction_delta)                │ Summary text              │
├───────┼─────────────────────────────────────────────────────────────┼───────────────────────────┤
│ 4     │ content_block_stop                                          │ Summary done              │
├───────┼─────────────────────────────────────────────────────────────┼───────────────────────────┤
│ 5     │ { type: "system", subtype: "status", status: null }         │ Compaction finished       │
├───────┼─────────────────────────────────────────────────────────────┼───────────────────────────┤
│ 6     │ { type: "system", subtype: "compact_boundary" }             │ Boundary marker           │
└───────┴─────────────────────────────────────────────────────────────┴───────────────────────────┘
```

### What already works

- **Control plane** (`sandbox/control-plane.mjs:1022`): The event loop already broadcasts ALL SDK events via `this.broadcast({ type: 'sdk_event', event })`. This means `system/status` events with `status: "compacting"` are already flowing through to connected clients — we just ignore them.
- **Compaction content blocks** (`Chat.tsx:1758-1805`): The client already intercepts `compaction`/`compaction_delta` content blocks and builds a `CompactSummaryCard`.
- **Compact boundary** (`Chat.tsx:1907-1926`): The client already handles `compact_boundary` events by inserting a placeholder summary card.
- **Manual `/compact` indicator** (`Chat.tsx:813-855`): A `CompactingIndicator` component and `isCompacting` state already exist, but are only wired up for manual `/compact` commands via `queueManualCompaction()`.

### What's missing

The client **does not** listen for `system/status` events with `status: "compacting"`. This is the signal that auto-compaction has started. Without it, the `CompactingIndicator` never shows for auto-compaction.

---

## Implementation

### Step 1: Detect `system/status` compaction events on the client

**File: `src/components/Chat.tsx`** — in the WebSocket `onmessage` handler, inside the `data.type === 'sdk_event'` branch.

Currently, `system` events are handled at lines 1902-1926 with checks for `subtype === 'init'` and `subtype === 'compact_boundary'`. Add a new check for `subtype === 'status'`:

```typescript
// FIND this block (around line 1902):
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
  // System init - reset the streaming message ID
  splitStreamingMessageOnNextPartRef.current = false;
  setStreamingMessageId(null);
  startQueuedManualCompactionIfNeeded();
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {

// ADD this NEW branch between the 'init' and 'compact_boundary' cases:
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'status') {
  const status = (sdkEvent as Record<string, unknown>).status;
  if (status === 'compacting') {
    // Auto-compaction starting — show the compacting indicator
    setIsCompacting(true);
  } else if (status === null) {
    // Compaction finished — indicator will be cleared when summary/boundary arrives,
    // but clear it here too as a safety net
    setIsCompacting(false);
  }
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
```

### Step 2: Clear `isCompacting` on compact summary capture

The compacting indicator should be cleared as soon as the compaction summary is captured (whether via the `compaction` content block or the `compact_boundary` fallback). This already happens for manual compactions via `completeActiveManualCompaction()`, but auto-compaction bypasses that code path.

**File: `src/components/Chat.tsx`**

**2a.** In the `compaction` content block handler (around line 1769-1803), when `content_block_stop` fires and we have a summary, also clear `isCompacting`:

```typescript
// FIND this block (around line 1769):
if (evt?.type === 'content_block_stop') {
  const summary = compactionContentRef.current;
  isInCompactionBlockRef.current = false;
  compactionContentRef.current = '';
  if (summary) {
    hasCapturedCompactionSummaryRef.current = true;
    completeActiveManualCompaction();
    // ... builds compactMsg, updates messages ...
  }
  return;
}

// ADD setIsCompacting(false) right after completeActiveManualCompaction():
if (summary) {
  hasCapturedCompactionSummaryRef.current = true;
  completeActiveManualCompaction();
  setIsCompacting(false); // ← ADD THIS LINE
  // ... rest of the block stays the same ...
}
```

**2b.** In the `compact_boundary` handler (around line 1907-1926), also clear `isCompacting`. It currently calls `completeActiveManualCompaction()` which only clears for manual compactions:

```typescript
// FIND this block (around line 1907):
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
  completeActiveManualCompaction();
  if (hasCapturedCompactionSummaryRef.current) {
    hasCapturedCompactionSummaryRef.current = false;
    return;
  }

// ADD setIsCompacting(false) right after completeActiveManualCompaction():
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
  completeActiveManualCompaction();
  setIsCompacting(false); // ← ADD THIS LINE
  if (hasCapturedCompactionSummaryRef.current) {
```

**2c.** In the `isCompactSummary` user event handler (around line 1938-1978), also clear `isCompacting`:

```typescript
// FIND this block (around line 1938-1942):
if (sdkEvent.isCompactSummary) {
  completeActiveManualCompaction();
  hasCapturedCompactionSummaryRef.current = false;
  const placeholderId = pendingCompactionPlaceholderIdRef.current;
  pendingCompactionPlaceholderIdRef.current = null;

// ADD setIsCompacting(false):
if (sdkEvent.isCompactSummary) {
  completeActiveManualCompaction();
  setIsCompacting(false); // ← ADD THIS LINE
  hasCapturedCompactionSummaryRef.current = false;
```

### Step 3: Add safety net clearance on `result`, `error`, and reconnect

The `isCompacting` state must be cleared when a turn ends so it never gets stuck. Currently, none of these paths call `setIsCompacting(false)` because the state was only used for manual compaction (which clears via `completeActiveManualCompaction()`/`clearManualCompactionQueue()`). With auto-compaction support, explicit clearance is needed.

**File: `src/components/Chat.tsx`**

**3a.** In the `result` handler (around line 2023-2045), add `setIsCompacting(false)` alongside `setLoading(false)`:

```typescript
// FIND (around line 2039-2044):
setStreamingMessageId(null);
setLoading(false);
if (activeManualCompactionTurnRef.current) {
  completeActiveManualCompaction();
}
hasCapturedCompactionSummaryRef.current = false;

// ADD setIsCompacting(false) after setLoading(false):
setStreamingMessageId(null);
setLoading(false);
setIsCompacting(false); // ← ADD THIS LINE
if (activeManualCompactionTurnRef.current) {
  completeActiveManualCompaction();
}
hasCapturedCompactionSummaryRef.current = false;
```

**3b.** In the `error` handler (around line 2070-2084), add `setIsCompacting(false)` alongside `setLoading(false)`:

```typescript
// FIND (around line 2081-2084):
setStreamingMessageId(null);
setLoading(false);
clearManualCompactionQueue();
hasCapturedCompactionSummaryRef.current = false;

// ADD setIsCompacting(false) after setLoading(false):
setStreamingMessageId(null);
setLoading(false);
setIsCompacting(false); // ← ADD THIS LINE
clearManualCompactionQueue();
hasCapturedCompactionSummaryRef.current = false;
```

**3c.** In the `connectWebSocket` function's initial state reset (around line 1604), add `setIsCompacting(false)` alongside the existing `setLoading(false)`:

```typescript
// FIND (around line 1600-1604):
setReady(false);
// Clear stale streaming state on reconnect; server sends the
// authoritative streaming_state immediately after ready.
setStreamingMessageId(null);
setLoading(false);

// ADD setIsCompacting(false) after setLoading(false):
setStreamingMessageId(null);
setLoading(false);
setIsCompacting(false); // ← ADD THIS LINE
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/Chat.tsx` | Add `system/status` event handler to detect auto-compaction start/end; add `setIsCompacting(false)` calls in compaction summary capture paths and `result`/`error` handlers |

## Files NOT Modified

| File | Reason |
|------|--------|
| `sandbox/control-plane.mjs` | Already broadcasts all SDK events including `system/status` — no changes needed |
| `src/components/compacting-indicator.tsx` | Already exists and works correctly |
| `src/components/compact-summary-card.tsx` | Already exists and works correctly |
| `src/components/message-bubble.tsx` | Already renders compact summaries correctly |
| `src/types.ts` | Already has `isCompactSummary` flag |

---

## Verification

1. **Auto-compaction**: Start a long conversation that fills the context window. When auto-compaction triggers, the `CompactingIndicator` ("Compacting conversation...") should appear instead of ambiguous loading dots.
2. **Manual `/compact`**: Typing `/compact` should still show the same indicator (existing behavior preserved).
3. **Indicator clears**: After compaction finishes, the indicator disappears and is replaced by the `CompactSummaryCard`.
4. **No stuck indicator**: If the session ends mid-compaction (error, disconnect), the indicator clears on `result`/`error`/close events.
5. **Reconnect**: If a client reconnects mid-compaction, the replay buffer may deliver the `system/status` event, showing the indicator until the summary arrives.

## Not in Scope

- Changes to the control plane — it already forwards all events
- Changes to the `CompactingIndicator` or `CompactSummaryCard` visual design — they already look correct
- Showing compaction metadata (token count, trigger reason)
- Persisting compaction-in-progress state in `ChatThreadDO` for cross-session replay
