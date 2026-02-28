# Auto-Compaction UX — Detect & Disclose

**February 28, 2026** | Single file: `src/components/Chat.tsx`

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

## Design Decision: Single-Writer State Pattern

The existing manual compaction flow uses a ref-driven architecture where `syncManualCompactionIndicator()` is the **single writer** to `isCompacting`, deriving it from `activeManualCompactionTurnRef` and `queuedManualCompactionsRef`. Adding direct `setIsCompacting()` calls for auto-compaction would create competing writers that can fight with the sync function in reconnect/replay edge cases.

To avoid this, we extend the existing single-writer pattern:

1. Add a new `isAutoCompactingRef` (a ref, not state — same pattern as the manual refs).
2. Rename `syncManualCompactionIndicator()` → `syncCompactionIndicator()`.
3. Expand the derivation formula: `shouldShow = activeManualCompactionTurnRef.current || queuedManualCompactionsRef.current > 0 || isAutoCompactingRef.current`.
4. **All** paths (manual and auto) mutate their respective refs and call `syncCompactionIndicator()`. No direct `setIsCompacting()` calls anywhere outside the sync function.

This preserves the existing architecture and eliminates any possibility of manual/auto state collisions.

---

## Step 0: Preflight Validation

Before writing any code, confirm that the SDK actually emits `system/status` events in our runtime.

1. Trigger a known auto-compaction run (long conversation that fills context).
2. In the browser devtools Network tab (WebSocket frames) or by adding a temporary `console.log` in the `sdk_event` handler, confirm the runner emits:
   - `{ type: "system", subtype: "status", status: "compacting" }`
   - `{ type: "system", subtype: "status", status: null }`
3. If both events are present, proceed with Steps 1-4 below.
4. **If absent**: use degraded fallback detection via `stream_event/content_block_start` where `content_block.type === "compaction"` (event 2 in the sequence — later than ideal since the summary is already generating, but still far better than no disclosure). In this case, replace the `system/status` check in Step 2 with a `content_block_start` type check for `compaction`, and skip the `status: null` cleanup (rely on existing summary-capture and safety-net paths instead).

---

## Implementation

All changes are in `src/components/Chat.tsx`.

### Step 1: Add `isAutoCompactingRef` and rename the sync function

**Around line 818-828** (the compaction ref declarations and `syncManualCompactionIndicator`):

```typescript
// FIND (around line 818-828):
const queuedManualCompactionsRef = useRef(0);
const activeManualCompactionTurnRef = useRef(false);

const syncManualCompactionIndicator = useCallback(() => {
  const shouldShowIndicator = activeManualCompactionTurnRef.current || queuedManualCompactionsRef.current > 0;
  setIsCompacting(shouldShowIndicator);
}, [setIsCompacting]);

// REPLACE WITH:
const queuedManualCompactionsRef = useRef(0);
const activeManualCompactionTurnRef = useRef(false);
const isAutoCompactingRef = useRef(false);

const syncCompactionIndicator = useCallback(() => {
  const shouldShowIndicator =
    activeManualCompactionTurnRef.current ||
    queuedManualCompactionsRef.current > 0 ||
    isAutoCompactingRef.current;
  setIsCompacting(shouldShowIndicator);
}, [setIsCompacting]);
```

Then rename all references from `syncManualCompactionIndicator` → `syncCompactionIndicator` throughout the file. This affects the dependency arrays of `queueManualCompaction`, `startQueuedManualCompactionIfNeeded`, `completeActiveManualCompaction`, and `clearManualCompactionQueue`.

### Step 2: Detect `system/status` compaction events

In the WebSocket `onmessage` handler, inside the `data.type === 'sdk_event'` branch. Currently, `system` events are handled around lines 1902-1926 with checks for `subtype === 'init'` and `subtype === 'compact_boundary'`.

Add a new branch between the `init` and `compact_boundary` cases:

```typescript
// FIND (around line 1902):
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
  splitStreamingMessageOnNextPartRef.current = false;
  setStreamingMessageId(null);
  startQueuedManualCompactionIfNeeded();
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {

// ADD this NEW branch between 'init' and 'compact_boundary':
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'status') {
  const status = (sdkEvent as Record<string, unknown>).status;
  if (status === 'compacting') {
    isAutoCompactingRef.current = true;
    syncCompactionIndicator();
  } else if (status === null) {
    isAutoCompactingRef.current = false;
    syncCompactionIndicator();
  }
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
```

### Step 3: Clear auto-compaction ref on summary capture paths

The compacting indicator should clear as soon as the compaction summary is captured. The existing `completeActiveManualCompaction()` only clears manual refs. Add `isAutoCompactingRef.current = false` + `syncCompactionIndicator()` alongside those calls.

**3a.** In the `compaction` content block handler (around line 1769-1803), when `content_block_stop` fires with a summary:

```typescript
// FIND (around line 1769):
if (evt?.type === 'content_block_stop') {
  const summary = compactionContentRef.current;
  isInCompactionBlockRef.current = false;
  compactionContentRef.current = '';
  if (summary) {
    hasCapturedCompactionSummaryRef.current = true;
    completeActiveManualCompaction();
    // ... builds compactMsg, updates messages ...

// ADD after completeActiveManualCompaction():
    hasCapturedCompactionSummaryRef.current = true;
    completeActiveManualCompaction();
    isAutoCompactingRef.current = false;
    syncCompactionIndicator();
    // ... rest stays the same ...
```

**3b.** In the `compact_boundary` handler (around line 1907-1926):

```typescript
// FIND (around line 1907):
} else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
  completeActiveManualCompaction();
  if (hasCapturedCompactionSummaryRef.current) {

// ADD after completeActiveManualCompaction():
  completeActiveManualCompaction();
  isAutoCompactingRef.current = false;
  syncCompactionIndicator();
  if (hasCapturedCompactionSummaryRef.current) {
```

**3c.** In the `isCompactSummary` user event handler (around line 1938-1978):

```typescript
// FIND (around line 1938-1942):
if (sdkEvent.isCompactSummary) {
  completeActiveManualCompaction();
  hasCapturedCompactionSummaryRef.current = false;

// ADD after completeActiveManualCompaction():
  completeActiveManualCompaction();
  isAutoCompactingRef.current = false;
  syncCompactionIndicator();
  hasCapturedCompactionSummaryRef.current = false;
```

### Step 4: Safety net clearance on `result`, `error`, reconnect, and close

The indicator must never get stuck. Clear the auto-compaction ref in all terminal paths.

**4a.** In the `result` handler (around line 2023-2045), alongside `setLoading(false)`:

```typescript
// FIND (around line 2039-2044):
setStreamingMessageId(null);
setLoading(false);
if (activeManualCompactionTurnRef.current) {
  completeActiveManualCompaction();
}
hasCapturedCompactionSummaryRef.current = false;

// ADD after setLoading(false):
setStreamingMessageId(null);
setLoading(false);
isAutoCompactingRef.current = false;
syncCompactionIndicator();
if (activeManualCompactionTurnRef.current) {
  completeActiveManualCompaction();
}
hasCapturedCompactionSummaryRef.current = false;
```

**4b.** In the `error` handler (around line 2070-2084), alongside `setLoading(false)`:

```typescript
// FIND (around line 2081-2084):
setStreamingMessageId(null);
setLoading(false);
clearManualCompactionQueue();
hasCapturedCompactionSummaryRef.current = false;

// ADD after setLoading(false):
setStreamingMessageId(null);
setLoading(false);
isAutoCompactingRef.current = false;
clearManualCompactionQueue();
// Note: clearManualCompactionQueue() calls syncCompactionIndicator() internally,
// which will now also evaluate the cleared isAutoCompactingRef.
hasCapturedCompactionSummaryRef.current = false;
```

**4c.** In the `connectWebSocket` function's initial state reset (around line 1604):

```typescript
// FIND (around line 1600-1604):
setReady(false);
// Clear stale streaming state on reconnect; server sends the
// authoritative streaming_state immediately after ready.
setStreamingMessageId(null);
setLoading(false);

// ADD after setLoading(false):
setStreamingMessageId(null);
setLoading(false);
isAutoCompactingRef.current = false;
syncCompactionIndicator();
```

**4d.** In the `ws.onclose` handler (around line 2095-2123), when reconnect is exhausted:

```typescript
// FIND (around line 2095-2123):
ws.onclose = () => {
  if (connectionIdRef.current !== thisConnectionId) return;
  // ... clears ping interval, sets ready false, etc ...
  const maxAttempts = 5;
  if (reconnectAttempts.current < maxAttempts) {
    // ... exponential backoff reconnect ...
  }
};

// ADD an else branch when reconnect is exhausted:
  if (reconnectAttempts.current < maxAttempts) {
    // ... existing reconnect logic ...
  } else {
    // Reconnect exhausted — clear stale compaction indicator
    isAutoCompactingRef.current = false;
    syncCompactionIndicator();
  }
```

### Step 5: Remove temporary preflight instrumentation

If Step 0 used temporary logging in `Chat.tsx` (for example, `console.log(sdkEvent)` inside `sdk_event` handling), remove it before merge.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/Chat.tsx` | Add `isAutoCompactingRef`, rename sync function, detect `system/status` events, clear auto ref in summary/boundary/result/error/reconnect/close paths |

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

1. **Preflight**: Confirm `system/status` events are emitted by the SDK in our runtime (Step 0).
2. **Auto-compaction**: Start a long conversation that fills the context window. When auto-compaction triggers, the `CompactingIndicator` ("Compacting conversation...") should appear instead of ambiguous loading dots.
3. **Manual `/compact`**: Typing `/compact` should still show the same indicator (existing behavior preserved — manual refs drive the sync function as before).
4. **Indicator clears**: After compaction finishes, the indicator disappears and is replaced by the `CompactSummaryCard`.
5. **No stuck indicator on `result`**: If compaction completes and the turn ends, the indicator clears via the `result` handler safety net.
6. **No stuck indicator on `error`**: If an error occurs mid-compaction, the indicator clears via the `error` handler.
7. **No stuck indicator on close**: If the WebSocket closes and reconnect is exhausted (5 attempts), the indicator clears.
8. **Reconnect mid-compaction**: If a client reconnects while compaction is in progress, the reconnect reset clears the stale indicator. If the server replays the `system/status` event, the indicator re-enables correctly.
9. **Fallback branch (only if Step 0 fails)**: With `content_block_start(type=compaction)` as the trigger, the indicator still appears during auto-compaction and clears on summary capture, `result`, `error`, and reconnect-exhausted close.
10. **No debug leakage**: Confirm no temporary preflight logging remains in production code.

---

## Acceptance Criteria

- Auto-compaction start is visibly disclosed to users through `CompactingIndicator`.
- Manual `/compact` behavior remains unchanged and does not regress.
- `isCompacting` has one write path (`syncCompactionIndicator()`), derived from manual and auto refs.
- Indicator clears reliably on compaction completion and on terminal safety-net paths (`result`, `error`, reconnect-exhausted close).
- Reconnect/replay scenarios do not leave stale compaction UI state.
- If `system/status` events are unavailable in runtime, fallback detection still prevents "hung" perception.

---

## Rollout Notes

- No backend/control-plane rollout is required; change is frontend-only (`Chat.tsx`).
- Preflight validation (Step 0) is required before implementation merge.
- If fallback mode is used because status events are missing, note that in PR description and open a follow-up to investigate SDK/runtime event parity.
- After shipping, update [AGENTS.md](/Users/illiana/Projects/chiridion-app/AGENTS.md) chat behavior notes to mention auto-compaction disclosure in the client UI.

## Not in Scope

- Changes to the control plane — it already forwards all events
- Changes to the `CompactingIndicator` or `CompactSummaryCard` visual design — they already look correct
- Showing compaction metadata (token count, trigger reason)
- Persisting compaction-in-progress state in `ChatThreadDO` for cross-session replay
