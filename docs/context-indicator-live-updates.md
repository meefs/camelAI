# Context Indicator — Live Per-Call Updates

**February 28, 2026** | Feature plan for real-time context usage updates during agent turns

**Files to modify:** `workers/main/src/durable-objects.ts`, `workers/main/tests/*` (new or existing test file for ChatThreadDO context usage sequencing)
**Files NOT modified:** `sandbox/control-plane.mjs`, `src/components/Chat.tsx`, `src/components/context-indicator.tsx`, `src/components/prompt-input.tsx`

---

## Problem

The context usage indicator currently updates only once per agent turn — when the `result` event fires at the very end. During long tool-use chains (10+ tool calls), the indicator sits frozen for the entire turn, then jumps to the new value. The user has no visibility into context growth as the agent works.

### Current behavior

```
User sends message
  │
  ├── message_start (call 1) ─── usage available, IGNORED
  ├── ... tool_use, tool_result ...
  ├── message_start (call 2) ─── usage available, IGNORED
  ├── ... tool_use, tool_result ...
  ├── message_start (call 3) ─── usage available, IGNORED
  ├── ... final text ...
  └── result ─────────────────── usage computed, broadcast, persisted
                                  Indicator jumps from old% → new%
```

### Desired behavior

```
User sends message
  │
  ├── message_start (call 1) ─── compute + broadcast (live update)
  │                               Indicator: 12% → 14%
  ├── ... tool_use, tool_result ...
  ├── message_start (call 2) ─── compute + broadcast (live update)
  │                               Indicator: 14% → 17%
  ├── ... tool_use, tool_result ...
  ├── message_start (call 3) ─── compute + broadcast (live update)
  │                               Indicator: 17% → 19%
  ├── ... final text ...
  └── result ─────────────────── final compute, broadcast, PERSIST to KV
                                  Indicator: 19% → 20% (final result-derived prompt usage persisted)
```

The indicator updates after every API call in the tool-use loop — after the user's message is incorporated, after each tool result is incorporated, etc. The user sees context fill grow in real time as the agent works.

---

## Cost Analysis

**Is this expensive? No.** Zero additional API calls, zero additional SDK queries. The `message_start` events already flow through the full pipeline:

```
SDK query() iterator
  → control-plane.mjs broadcast({ type: 'sdk_event', event })
    → ChatThreadDO handleRunnerEvent()
```

`ChatThreadDO` already intercepts `message_start` events and captures their usage (for the two-phase context calculation). This feature adds only:

1. **Trivial math** on each `message_start` (one addition, one division)
2. **One small WebSocket broadcast** per `message_start` (`{ type: 'context_usage_state', usedPercent: N }` — ~60 bytes)
3. **No additional KV writes** — intermediate updates are ephemeral (broadcast-only). Only the final `result` persists to storage.

A typical tool-use turn has 3-8 API calls. That's 3-8 extra tiny WebSocket messages, compared to the hundreds of `content_block_delta` streaming events already being sent during the same turn. Negligible.

---

## Background: The contextWindow Problem

Computing a percentage requires two values: `totalInputTokens` and `contextWindow`. The `message_start` event provides `totalInputTokens` (per-call usage), but `contextWindow` only arrives in `result.modelUsage`.

However, `contextWindow` is a **static property of the model** (e.g., 200,000 for Claude Sonnet 4). It doesn't change between calls or between turns for the same model. Once we've seen it in a prior `result`, we can cache it per model and reuse it for intermediate computations.

```
Turn 1: result → modelUsage["claude-sonnet-4-..."].contextWindow = 200000
         Cache contextWindowByModel["claude-sonnet-4-..."] = 200000

Turn 2: message_start (call 1) → usage available, model known, contextWindow cached → compute!
         message_start (call 2) → usage available, model known, contextWindow cached → compute!
         result → confirms contextWindow, final compute + persist
```

On the very first turn of a brand-new thread, there is no cached context window yet. In that case, intermediate updates are skipped (same as today) and the first computation happens on `result`. After that, all subsequent turns get live updates for known models.

---

## Implementation

Runtime changes are in `workers/main/src/durable-objects.ts`, plus worker tests under `workers/main/tests/*`. No client files need modification — the client already handles `context_usage_state` messages and re-renders on each one.

### Step 1: Add transient state + model-keyed contextWindow cache

Add new instance variables alongside the existing context usage state:

```typescript
// Existing canonical persisted/replayed value:
private contextUsedPercent: number | null = null;
private lastMessageStartUsage: LastMessageStartUsage | null = null;
private usageIsPostCompaction: boolean = true;

// ADD:
// Live mid-turn value (ephemeral, never persisted)
private transientContextUsedPercent: number | null = null;

// Cache context windows by model to avoid model-switch inaccuracies
private cachedContextWindowByModel: Record<string, number> = {};
```

`contextUsedPercent` stays canonical and result-derived only.

### Step 2: Hydrate model-keyed cache from storage on construction

Persist and restore `cachedContextWindowByModel` so it survives DO evictions.

Add a storage key constant:

```typescript
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = 'chatContextWindowByModel';
```

In the constructor, after `contextUsedPercent` hydration:

```typescript
const storedContextWindowByModel =
  ctx.storage.kv.get<Record<string, unknown>>(CHAT_CONTEXT_WINDOW_BY_MODEL_KEY);
if (storedContextWindowByModel && typeof storedContextWindowByModel === 'object') {
  for (const [model, contextWindow] of Object.entries(storedContextWindowByModel)) {
    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
      this.cachedContextWindowByModel[model] = contextWindow;
    }
  }
}
```

### Step 3: Broadcast on each `message_start` (live intermediate update)

In the existing `message_start` handler, after capturing usage, compute and broadcast if cached contextWindow exists for that model:

```typescript
if (streamEvent?.type === 'message_start' && streamEvent.message?.usage) {
  const usage = streamEvent.message.usage as Record<string, unknown>;
  this.lastMessageStartUsage = {
    inputTokens:
      toFiniteNumber(usage.input_tokens) ??
      toFiniteNumber(usage.inputTokens) ??
      0,
    cacheReadInputTokens:
      toFiniteNumber(usage.cache_read_input_tokens) ??
      toFiniteNumber(usage.cacheReadInputTokens) ??
      0,
    cacheCreationInputTokens:
      toFiniteNumber(usage.cache_creation_input_tokens) ??
      toFiniteNumber(usage.cacheCreationInputTokens) ??
      0,
    model: typeof streamEvent.message.model === 'string' ? streamEvent.message.model : null,
  };
  this.usageIsPostCompaction = true;

  const model = this.lastMessageStartUsage.model;
  const contextWindow = model ? this.cachedContextWindowByModel[model] : undefined;
  if (contextWindow && contextWindow > 0 && this.usageIsPostCompaction) {
    const totalInput =
      this.lastMessageStartUsage.inputTokens +
      this.lastMessageStartUsage.cacheReadInputTokens +
      this.lastMessageStartUsage.cacheCreationInputTokens;
    const livePct = Math.max(0, Math.min(100, Math.round((totalInput / contextWindow) * 100)));
    this.transientContextUsedPercent = livePct;
    this.broadcastRealtime({ type: 'context_usage_state', usedPercent: livePct });
  }
}
```

Do **not** set `this.contextUsedPercent` during intermediate updates.

### Step 4: On `result`, compute canonical value + refresh model cache + persist

In the existing `result` handler:
1. Refresh `cachedContextWindowByModel` from `result.modelUsage`; persist only when changed.
2. Compute final context usage from `lastMessageStartUsage` + `contextWindow` from current `result`.
3. Persist canonical `contextUsedPercent` and broadcast final value.
4. Clear transient state.

```typescript
if (sdkEvent?.type === 'result') {
  // ... existing result handling ...

  const updatedContextWindowByModel = extractContextWindowByModel(sdkEvent);
  if (!shallowEqualNumberMaps(updatedContextWindowByModel, this.cachedContextWindowByModel)) {
    this.cachedContextWindowByModel = updatedContextWindowByModel;
    this.ctx.storage.kv.put(CHAT_CONTEXT_WINDOW_BY_MODEL_KEY, this.cachedContextWindowByModel);
  }

  if (this.lastMessageStartUsage && this.usageIsPostCompaction) {
    const contextWindow = extractContextWindowForModel(sdkEvent, this.lastMessageStartUsage.model);
    if (contextWindow > 0) {
      const totalInput =
        this.lastMessageStartUsage.inputTokens +
        this.lastMessageStartUsage.cacheReadInputTokens +
        this.lastMessageStartUsage.cacheCreationInputTokens;
      const contextUsedPercent = Math.max(
        0,
        Math.min(100, Math.round((totalInput / contextWindow) * 100))
      );
      this.contextUsedPercent = contextUsedPercent;
      this.ctx.storage.kv.put(CHAT_CONTEXT_USED_PERCENT_KEY, contextUsedPercent);
      this.broadcastRealtime({ type: 'context_usage_state', usedPercent: contextUsedPercent });
    }
  }

  this.transientContextUsedPercent = null;
  this.lastMessageStartUsage = null;
  this.usageIsPostCompaction = true;
}
```

In `handleChatInit`, replay the latest available state with:

```typescript
const initUsedPercent = this.transientContextUsedPercent ?? this.contextUsedPercent;
if (initUsedPercent !== null) {
  this.sendDirect(ws, { type: 'context_usage_state', usedPercent: initUsedPercent });
}
```

On `compact_boundary`, set `usageIsPostCompaction = false` and clear `transientContextUsedPercent` to avoid replaying stale pre-compaction intermediate values during reconnect.

---

## What Does NOT Change

- **`sandbox/control-plane.mjs`** — Already broadcasts all `stream_event` messages including `message_start`. No changes needed.
- **`src/components/Chat.tsx`** — Already handles `context_usage_state` WebSocket messages and calls `setContextUsedPercent`. Multiple updates per turn are handled naturally by React state.
- **`src/components/context-indicator.tsx`** — Already re-renders on prop change with CSS transition (`transition-all duration-300 ease-out`). Multiple updates per turn will animate smoothly.
- **`src/components/prompt-input.tsx`** — Passes `contextUsedPercent` prop through. No changes needed.
- **Client WebSocket handler** — Already idempotent. Receiving more `context_usage_state` messages is fine.

---

## Edge Cases

### First turn of a new thread
`cachedContextWindowByModel` is empty (no previous `result`). Intermediate broadcasts are skipped. The indicator updates once on `result`, same as today. All subsequent turns get live updates for known models.

### Model changes mid-thread
If the model changes (e.g., Sonnet -> Haiku), live updates for the new model are skipped until that model's `contextWindow` is seen in a `result` and cached. This avoids incorrect percentages.

### DO eviction between turns
`cachedContextWindowByModel` is persisted to KV and hydrated on construction. Survives DO eviction.

### Compaction mid-turn
The existing `usageIsPostCompaction` flag is checked before intermediate broadcasts (Step 3). If a `compact_boundary` fires, intermediate broadcasts stop until the next `message_start` (which sets `usageIsPostCompaction = true`). The post-compaction `message_start` will have smaller token counts, so the indicator will drop. `transientContextUsedPercent` is cleared on boundary to avoid replaying stale pre-compaction values.

### Mid-turn refresh/reconnect
If a client reconnects mid-turn, `handleChatInit` replays `transientContextUsedPercent ?? contextUsedPercent`, so users get the freshest live value when available without mutating canonical persisted state.

### Multiple chat clients connected
`broadcastRealtime` sends to all connected chat WebSocket clients. All clients see the same live updates. Correct behavior.

---

## Files to Modify

| File | Change |
|------|--------|
| `workers/main/src/durable-objects.ts` | Add transient live state, model-keyed contextWindow cache, hydration, intermediate broadcasts on `message_start`, result-time canonical persistence + cache refresh |
| `workers/main/tests/*` | Add tests for live update sequencing, compaction ordering, reconnect replay, and model-switch cache behavior |

## Files NOT Modified

| File | Why |
|------|-----|
| `sandbox/control-plane.mjs` | Already broadcasts all `message_start` events |
| `src/components/Chat.tsx` | Already handles `context_usage_state` messages idempotently |
| `src/components/context-indicator.tsx` | Already re-renders and animates on prop change |
| `src/components/prompt-input.tsx` | Already passes `contextUsedPercent` through |

---

## Verification

1. **Live updates during tool use:** Send a message that triggers multiple tool calls. The indicator should update after each tool call, not just at the end.
2. **First turn of new thread:** Start a new thread. The indicator should still update on `result` (no regression). On the second turn, intermediate updates should appear.
3. **Post-compaction accuracy:** Trigger `/compact`, then send a message. Intermediate updates should show the reduced (post-compaction) percentage.
4. **Mid-turn reconnect replay:** Refresh/reconnect mid-turn should replay `transientContextUsedPercent` when available, otherwise replay canonical persisted `contextUsedPercent`. Reconnect must never persist intermediate values.
5. **Compaction edge ordering:** Validate `message_start(pre) -> compact_boundary -> result` does not persist stale values; validate `message_start(pre) -> compact_boundary -> message_start(post) -> result` persists post-compaction value.
6. **Model switch behavior:** Validate model changes do not use wrong cached context windows for live updates.
7. **Smooth animation:** Multiple rapid updates should animate smoothly via the existing CSS transition, not flicker.
8. **Automated tests:** Add worker tests for the event sequence cases above; manual verification is not sufficient for merge.

---

## Acceptance Criteria

- Indicator updates after each API call in the tool-use loop, not just at turn end.
- No additional KV writes during intermediate updates (broadcast-only).
- `cachedContextWindowByModel` is persisted and survives DO eviction.
- First turn of a new thread still works (graceful degradation to end-of-turn update).
- Compaction mid-turn is handled correctly (indicator drops on post-compaction `message_start`).
- Canonical replay value remains result-derived (`contextUsedPercent`) and is only persisted on `result`.
- Intermediate live updates are isolated from canonical persistence (`transientContextUsedPercent` or equivalent).
- Reconnect replay uses `transientContextUsedPercent ?? contextUsedPercent`.
- No changes to client code.
