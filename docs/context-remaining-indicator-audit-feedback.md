# Context Remaining Indicator Plan - Audit Feedback

**Date:** March 1, 2026  
**Target plan:** [docs/context-remaining-indicator.md](/Users/illiana/Projects/chiridion-app/docs/context-remaining-indicator.md)

## Product Decisions Confirmed

1. Clicking the indicator **must preserve unsent draft text** in the composer.
2. Tooltip copy should use **"used"** (for example, `"62% context used"`).
3. Include **first-load/reopen support now** using `ChatThreadDO` persistence/replay (cross-device), not browser-local storage.

## Vital Issues and Required Fixes

## 1) P0 - `/compact` trigger path is ambiguous and one path is unsafe

### Issue
The plan currently offers two implementation options for indicator click handling:
- `setInput('/compact')` + `queueMicrotask(sendMessage)`
- a direct WebSocket send path

Both are problematic:
- `setInput('/compact')` mutates user draft (violates product decision #1) and can race with state updates.
- direct WebSocket send bypasses existing `sendMessage()` behavior (optimistic message, queue/reconnect path, cleanup logic).

### Required plan change
Replace Step 4 with **one deterministic approach**:
- Refactor `sendMessage` into a reusable internal path that accepts a content override.
- Use this internal path for indicator-initiated compaction with `preserveDraft: true`.
- Do not write `/compact` into the input field.

### Concrete implementation shape

```ts
type SendOptions = {
  contentOverride?: string;
  preserveDraft?: boolean;        // true for indicator compact
  skipAttachmentRefs?: boolean;   // true for indicator compact
};

function sendMessage(opts?: SendOptions) {
  if (readOnly) return;
  if (isLoadingMessages || !shouldShowChat || !resolvedWorkspaceId || !threadId) return;

  const raw = (opts?.contentOverride ?? input).trim();
  if (!raw) return;

  // Preserve draft when content is overridden by indicator click.
  if (!opts?.preserveDraft && !opts?.contentOverride) {
    setInput('');
  }

  const shouldIncludeAttachmentRefs = !opts?.skipAttachmentRefs && !opts?.contentOverride;
  const finalContent = shouldIncludeAttachmentRefs ? appendAttachmentRefs(raw) : raw;

  if (isManualCompactCommand(finalContent)) {
    queueManualCompaction();
  }

  // Keep all existing optimistic message + ws send/queue behavior unchanged.
  sendThroughExistingPipeline(finalContent);
}

const handleCompactFromIndicator = useCallback(() => {
  if (loading || isStreaming || isCompacting || readOnly) return;
  sendMessage({
    contentOverride: '/compact',
    preserveDraft: true,
    skipAttachmentRefs: true,
  });
}, [loading, isStreaming, isCompacting, readOnly, sendMessage]);
```

## 2) P0 - Missing cross-device first-load/reopen support in the plan

### Issue
The current plan hides the indicator until first `result` event. After reload/reopen, users see no context signal until another full turn completes.

### Required plan change
Make `ChatThreadDO` the source of truth for last known context usage:
- Persist last computed used percent in DO storage (`ctx.storage.kv`) per thread.
- Replay that value to newly connected chat clients during `init`.
- Broadcast updates to all active chat clients when a new `result` updates context usage.
- Compute the percentage in `ChatThreadDO` from `sdk_event.result.modelUsage`; client must not parse raw `modelUsage`.

This replaces browser `sessionStorage` persistence.

### Behavior requirements
- When any client opens a thread, it receives the latest persisted value from `ChatThreadDO` and renders immediately.
- On each `sdk_event.result`, `ChatThreadDO` recomputes and persists the value, then broadcasts update.
- Different devices/browsers for the same thread see the same latest value.
- If no persisted value exists yet, indicator remains hidden until first valid computation.
- Client is presentation-only for this feature: it renders `usedPercent` from `context_usage_state`.

### Concrete implementation shape

```ts
// workers/main/src/durable-objects.ts
const CHAT_CONTEXT_USED_PERCENT_KEY = 'chatContextUsedPercent';
private contextUsedPercent: number | null = null;

// constructor hydrate:
const storedPct = ctx.storage.kv.get<number>(CHAT_CONTEXT_USED_PERCENT_KEY);
if (typeof storedPct === 'number' && Number.isFinite(storedPct)) {
  this.contextUsedPercent = Math.max(0, Math.min(100, Math.round(storedPct)));
}

// on sdk_event.result in handleRunnerEvent:
const pct = computeContextUsedPercentFromResult(sdkEvent);
if (pct !== null) {
  this.contextUsedPercent = pct;
  this.ctx.storage.kv.put(CHAT_CONTEXT_USED_PERCENT_KEY, pct);
  this.broadcastChat({ type: 'context_usage_state', usedPercent: pct });
}

// IMPORTANT: do not clear/overwrite when result has no modelUsage
// (for example synthetic runner_disconnected result).

// in handleChatInit after replay:
if (this.contextUsedPercent !== null) {
  this.sendDirect(ws, { type: 'context_usage_state', usedPercent: this.contextUsedPercent });
}

// src/components/Chat.tsx
if (data.type === 'context_usage_state') {
  const used = typeof data.usedPercent === 'number' ? data.usedPercent : null;
  setContextUsedPercent(used !== null ? clampToPercent(used) : null);
}
```

```ts
// workers/main/src/durable-objects.ts (helper shape)
function computeContextUsedPercentFromResult(
  sdkEvent: { type?: string; modelUsage?: unknown }
): number | null {
  if (sdkEvent.type !== 'result') return null;
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== 'object') return null;

  let maxPct: number | null = null;
  for (const usage of Object.values(sdkEvent.modelUsage as Record<string, unknown>)) {
    if (!usage || typeof usage !== 'object') continue;
    const u = usage as Record<string, unknown>;
    const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
    const cacheRead = typeof u.cacheReadInputTokens === 'number' ? u.cacheReadInputTokens : 0;
    const cacheCreate = typeof u.cacheCreationInputTokens === 'number' ? u.cacheCreationInputTokens : 0;
    const contextWindow = typeof u.contextWindow === 'number' ? u.contextWindow : 0;
    if (contextWindow <= 0) continue;
    const totalInput = inputTokens + cacheRead + cacheCreate;
    const pct = Math.max(0, Math.min(100, Math.round((totalInput / contextWindow) * 100)));
    maxPct = maxPct === null ? pct : Math.max(maxPct, pct);
  }
  return maxPct;
}
```

## 3) P1 - Token math assumptions are not validated

### Issue
The plan assumes `modelUsage` always reflects the real "current prompt fill" users expect. This should be validated before merge.

### Required plan change
Add a preflight validation step before implementation completion:
- Log/inspect `result.modelUsage` values during a long thread.
- Confirm percentage rises with larger history and drops after `/compact`.
- Confirm percentage is bounded `0-100`.
- Confirm DO-persisted value matches live result-derived value.
- Confirm client receives the DO-broadcast `context_usage_state` and never needs raw `modelUsage`.

If data is absent or malformed:
- Keep indicator hidden for that turn.
- Do not throw.

### Acceptance addendum
- "Indicator never crashes chat when `modelUsage` is missing or unexpected."

## 4) P1 - Visual spec mismatch: ring arc vs pie slice

### Issue
Current sample component draws a stroked arc ring (`fill="none"` circles). Request is specifically a **pie-slice filled circle**.

### Required plan change
Update Step 1 to render a true wedge fill (`<path fill="currentColor">`) rather than stroke dash arc.

### Concrete implementation shape

```ts
function describeWedgePath(pct: number, cx = 10, cy = 10, r = 8): string {
  if (pct <= 0) return '';
  if (pct >= 100) return `M ${cx} ${cy} m -${r},0 a ${r},${r} 0 1,0 ${2*r},0 a ${r},${r} 0 1,0 -${2*r},0`;
  const angle = (pct / 100) * 360 - 90;
  const radians = (angle * Math.PI) / 180;
  const x = cx + r * Math.cos(radians);
  const y = cy + r * Math.sin(radians);
  const largeArc = pct > 50 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`;
}
```

## 5) P2 - Type safety and maintainability gap (worker-side)

### Issue
The plan uses broad `Record<string, unknown>` casts in client event handling for `modelUsage`.

### Required plan change
Move type narrowing to `ChatThreadDO` compute helper:
- Add narrow runtime guards for `modelUsage` shape in worker code.
- Client only handles typed realtime message `{ type: 'context_usage_state'; usedPercent: number }`.
- Remove client-side `modelUsage` extraction/casting entirely.

## Plan Patch Checklist (what to change in the original plan)

1. **Replace Step 4** with a single `sendMessage(contentOverride, options)` strategy that preserves draft text.
2. **Replace Step 3**: remove client-side `modelUsage` extraction. Add DO-side computation + persistence + broadcast as the single source of truth.
3. **Expand validation step** with preflight checks and malformed-data guards for worker-side `modelUsage` parsing.
4. **Replace Step 1 SVG example** to use a pie wedge path (not stroke-dash ring).
5. **Replace Step 7** with `ChatThreadDO` persistence + init replay + realtime broadcast for `context_usage_state` (no browser storage).
6. **Add verification cases**:
   - Draft text remains unchanged after indicator click.
   - Reopen existing thread on a different browser/device shows the same latest context percent immediately.
   - Missing/invalid `modelUsage` does not break chat.
   - Synthetic `result` events without `modelUsage` do not erase persisted context usage.
   - Client code path has no raw `modelUsage` parsing.
7. **Add acceptance criteria**:
   - Indicator click uses same send pipeline as normal messages.
   - Indicator survives refresh/reopen with `ChatThreadDO` per-thread persistence and cross-device consistency.
   - `ChatThreadDO` is the single source of truth for computed context usage.
